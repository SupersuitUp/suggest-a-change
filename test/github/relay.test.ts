// RUN YOUR OWN RELAY: createAttachRelay saves a file into a repo for someone who can file an issue there but cannot
// push, through the operator's own GitHub App. Every refusal the relay makes has a test here.
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createAttachRelay, relayHost, toBase64 } from '../../src/github/index.ts'

const API = 'https://api.github.com'
const ID = 'r-20261026170412-ab12cd'
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82])
const pair = (type: 'pkcs1' | 'pkcs8') => generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type, format: 'pem' } })
const KEY = pair('pkcs1') // GitHub hands out PKCS#1 keys

type Call = { method: string; url: string; auth: string; body: any }
function fakeGitHub(over: { publicKey?: string; files?: string[]; issueBody?: string; closedAt?: string | null; pr?: boolean } = {}) {
  const calls: Call[] = []
  let branch = false
  const files = new Set(over.files ?? [])
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    const auth = new Headers(init.headers).get('authorization') ?? ''
    const c: Call = { method: init.method ?? 'GET', url, auth, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined }
    calls.push(c)
    const ok = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    if (url === `${API}/repos/acme/app/installation`) {
      const jwt = auth.replace('Bearer ', '')
      const [h, p, s] = jwt.split('.')
      const good = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey(over.publicKey ?? KEY.publicKey), Buffer.from(s, 'base64url'))
      if (!good) return ok(401, { message: 'A JSON web token could not be decoded' })
      return ok(200, { id: 55 })
    }
    if (url.endsWith('/installation')) return ok(404, { message: 'Not Found' })
    if (c.method === 'POST' && url === `${API}/app/installations/55/access_tokens`) return ok(201, { token: 'inst-token' })
    if (!auth.includes('inst-token')) return ok(401, { message: 'Bad credentials' })
    if (url === `${API}/repos/acme/app/issues/7`) return ok(200, { number: 7, state: over.closedAt ? 'closed' : 'open', closed_at: over.closedAt ?? null, body: over.issueBody ?? `## What they said\nhi\n\n## Filed by\nA member (member), through Suggest a change in the app. Report ${ID}.`, ...(over.pr ? { pull_request: {} } : {}) })
    if (url.startsWith(`${API}/repos/acme/app/issues/`)) return ok(404, { message: 'Not Found' })
    if (url.startsWith(`${API}/repos/acme/app/contents/attachments/${ID}?`)) return files.size ? ok(200, [...files].map((name) => ({ name, type: 'file' }))) : ok(404, { message: 'Not Found' })
    if (url === `${API}/repos/acme/app/git/ref/heads/suggestion-attachments`) return branch ? ok(200, { object: { sha: 'c1' } }) : ok(404, {})
    if (url.endsWith('/git/trees')) return ok(201, { sha: 't1' })
    if (url.endsWith('/git/commits')) return ok(201, { sha: 'c1' })
    if (url.endsWith('/git/refs')) { branch = true; return ok(201, {}) }
    if (c.method === 'PUT' && url.startsWith(`${API}/repos/acme/app/contents/attachments/${ID}/`)) {
      const name = url.split('/').pop()!
      if (files.has(name)) return ok(422, { message: 'sha wasn\'t supplied' })
      files.add(name); return ok(201, {})
    }
    return ok(404, { message: 'Not Found' })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const who = (req: Request) => Promise.resolve(req.headers.get('authorization') === 'Bearer member' ? { account: 'amy' } : req.headers.get('authorization') === 'Bearer ben' ? { account: 'ben' } : null)
const relay = (g: ReturnType<typeof fakeGitHub>, extra: Record<string, unknown> = {}) => createAttachRelay({ app: { id: 1234, privateKey: KEY.privateKey }, identity: who, fetch: g.fetch, now: () => Date.parse('2026-10-26T18:00:00Z'), ...extra })
const post = (body: unknown, auth = 'Bearer member', method = 'POST') => new Request('https://relay.test/attach', { method, headers: { authorization: auth, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) })
const file = (over: Record<string, unknown> = {}) => ({ repo: 'acme/app', issue: 7, reportId: ID, name: 'image-1.png', type: 'image/png', bytes: toBase64(PNG), ...over })
const status = async (res: Response) => [res.status, ((await res.json()) as { error?: string }).error]

describe('createAttachRelay: a file saved', () => {
  it('signs as the App, reads the issue with the installation token, creates the branch, writes one path, answers its link', async () => {
    const g = fakeGitHub()
    const res = await relay(g)(post(file()))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ url: `https://github.com/acme/app/blob/suggestion-attachments/attachments/${ID}/image-1.png?raw=true` })
    const put = g.calls.find((c) => c.method === 'PUT')!
    expect(put.url).toBe(`${API}/repos/acme/app/contents/attachments/${ID}/image-1.png`)
    expect(put.body).toMatchObject({ branch: 'suggestion-attachments', content: toBase64(PNG) })
    expect(put.auth).toBe('Bearer inst-token')
    expect(g.calls.find((c) => c.url.endsWith('/git/commits'))!.body.parents).toEqual([])
    expect(g.calls.find((c) => c.url.endsWith('/access_tokens'))!.body).toEqual({ repositories: ['app'] }) // the token is for this one repo
  })

  it('takes a PKCS#8 key as well as GitHub\'s PKCS#1', async () => {
    const k = pair('pkcs8')
    const g = fakeGitHub({ publicKey: k.publicKey })
    const res = await createAttachRelay({ app: { id: 1, privateKey: k.privateKey }, identity: who, fetch: g.fetch })(post(file()))
    expect(res.status).toBe(200)
  })

  it('relayHost posts to any relay URL with any headers, and the two halves fit', async () => {
    const g = fakeGitHub()
    const handler = relay(g)
    const viaRelay = (async (input: RequestInfo | URL, init?: RequestInit) => (String(input) === 'https://relay.test/attach' ? handler(new Request(String(input), init)) : g.fetch(input, init))) as typeof globalThis.fetch
    const host = relayHost({ url: 'https://relay.test/attach', headers: { authorization: 'Bearer member' }, fetch: viaRelay })
    expect((await host.put({ repo: 'acme/app', issue: 7, reportId: ID }, { name: 'image-2.png', type: 'image/png', bytes: PNG })).url).toMatch(/image-2\.png\?raw=true$/)
  })
})

describe('createAttachRelay: every refusal', () => {
  it('only POST, and only someone the relay knows', async () => {
    const g = fakeGitHub()
    expect((await relay(g)(post(undefined, 'Bearer member', 'GET'))).status).toBe(405)
    expect((await relay(g)(post(file(), 'Bearer stranger'))).status).toBe(401)
    expect(g.calls).toHaveLength(0) // nothing reached GitHub
  })

  it('a malformed request: repo, report id, file name outside the folder, issue number, bytes', async () => {
    const g = fakeGitHub()
    for (const bad of [{ repo: 'acme' }, { reportId: '../../x' }, { name: '../main.ts' }, { name: '.github/workflows/x.yml' }, { issue: 0 }, { issue: '7' }, { bytes: 'not base64!' }, { bytes: '' }]) {
      expect((await relay(g)(post(file(bad)))).status, JSON.stringify(bad)).toBe(400)
    }
    expect((await relay(g)(new Request('https://relay.test/attach', { method: 'POST', headers: { authorization: 'Bearer member' }, body: 'nope' }))).status).toBe(400)
    expect(g.calls).toHaveLength(0)
  })

  it('bytes that are not an accepted picture, video or recording, or not the type declared', async () => {
    const g = fakeGitHub()
    expect(await status(await relay(g)(post(file({ bytes: toBase64(new TextEncoder().encode('MZ this is a program, not a picture')) }))))).toEqual([422, 'the file is not a picture, video or recording this module accepts'])
    expect((await relay(g)(post(file({ type: 'image/jpeg' })))).status).toBe(422)
  })

  it('a file over the size cap, which an operator may lower and never raise', async () => {
    const g = fakeGitHub()
    expect((await relay(g, { limits: { imageBytes: 8 } })(post(file()))).status).toBe(413)
    expect(() => relay(g, { limits: { imageBytes: 11 * 2 ** 20 } })).toThrow(/never raise/)
  })

  it('a repo the App is not installed on', async () => {
    const g = fakeGitHub()
    expect(await status(await relay(g)(post(file({ repo: 'other/x' }))))).toEqual([403, 'the app is not installed on other/x'])
  })

  it('an issue that does not exist, does not carry this report, is a pull request, or closed long ago', async () => {
    expect((await relay(fakeGitHub())(post(file({ issue: 8 })))).status).toBe(404)
    expect(await status(await relay(fakeGitHub({ issueBody: 'Report r-20261026170412-zzzzzz.' }))(post(file())))).toEqual([403, `issue #7 does not carry Report ${ID}`])
    expect((await relay(fakeGitHub({ issueBody: `Report ${ID}0` }))(post(file()))).status).toBe(403) // the id must be whole
    expect((await relay(fakeGitHub({ pr: true }))(post(file()))).status).toBe(403)
    expect((await relay(fakeGitHub({ closedAt: '2026-09-01T00:00:00Z' }))(post(file()))).status).toBe(403)
    expect((await relay(fakeGitHub({ closedAt: '2026-10-25T00:00:00Z' }))(post(file()))).status).toBe(200) // recently closed is fine
  })

  it('a path already written is never overwritten', async () => {
    const g = fakeGitHub({ files: ['image-1.png'] })
    expect((await relay(g)(post(file()))).status).toBe(409)
    expect(g.calls.some((c) => c.method === 'PUT')).toBe(false)
  })

  it('a report with all the pictures or videos it can carry', async () => {
    expect((await relay(fakeGitHub({ files: ['a.png', 'b.png', 'c.png', 'd.jpg', 'e.png', 'f.webp'] }))(post(file()))).status).toBe(422)
    const mp4 = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0, 0, 0, 0])
    expect((await relay(fakeGitHub({ files: ['video-1.mp4'] }))(post(file({ name: 'video-2.mp4', type: 'video/mp4', bytes: toBase64(mp4) })))).status).toBe(422)
  })

  it('more reports in a day than the cap, per account', async () => {
    const g = fakeGitHub()
    const r = relay(g, { limits: { perPersonPerDay: 1 } })
    expect((await r(post(file()))).status).toBe(200)
    expect((await r(post(file({ name: 'image-2.png' })))).status).toBe(200) // the same report again is not a new one
    expect((await r(post(file({ reportId: 'r-20261026170412-zzzzzz' })))).status).toBe(429)
    expect((await r(post(file({ reportId: 'r-20261026170412-zzzzzz' }), 'Bearer ben'))).status).not.toBe(429) // another account has its own day
  })

  it('a recording\'s ceiling is the server half\'s', async () => {
    const { VOICE_FILE_BYTES } = await import('../../src/server/index.ts')
    const { RELAY_VOICE_BYTES } = await import('../../src/github/index.ts')
    expect(RELAY_VOICE_BYTES).toBe(VOICE_FILE_BYTES)
  })

  it('names nobody: no host, product or key kind is written into the module', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const dir = new URL('../../src/github/', import.meta.url)
    for (const f of readdirSync(dir)) {
      const src = readFileSync(new URL(f, dir), 'utf8')
      expect(src, f).not.toMatch(/continentalworks|member key|memberKey/i)
    }
  })
})
