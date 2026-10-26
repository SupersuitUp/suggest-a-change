// RUN YOUR OWN RELAY: createAttachRelay saves a file into a repo for someone who can file an issue there but cannot
// push, through the operator's own GitHub App. Every refusal the relay makes has a test here.
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { branchHost, canFileDirectly, createAttachRelay, createSuggestionRelay, fileSuggestion, memoryUsage, relayFiler, relayHost, toBase64 } from '../../src/github/index.ts'

const API = 'https://api.github.com'
const ID = 'r-20261026170412-ab12cd'
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82])
const pair = (type: 'pkcs1' | 'pkcs8') => generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type, format: 'pem' } })
const KEY = pair('pkcs1') // GitHub hands out PKCS#1 keys

type Call = { method: string; url: string; auth: string; body: any }
function fakeGitHub(over: { publicKey?: string; files?: string[]; issueBody?: string; closedAt?: string | null; pr?: boolean; author?: string; putFails?: boolean } = {}) {
  const calls: Call[] = []
  let branch = false
  let issues = 100
  const files = new Set(over.files ?? [])
  const opened: { number: number; title: string; body: string; labels: string[] }[] = []
  const blobs: { content: string; encoding: string }[] = []
  const comments: { number: number; body: string }[] = []
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
    if (c.method === 'POST' && url === `${API}/repos/acme/app/labels`) return ok(201, {})
    if (c.method === 'POST' && url === `${API}/repos/acme/app/issues`) { const number = ++issues; opened.push({ number, ...c.body }); return ok(201, { number, html_url: `https://github.com/acme/app/issues/${number}` }) }
    const comment = /\/repos\/acme\/app\/issues\/(\d+)\/comments$/.exec(url)
    if (c.method === 'POST' && comment) { comments.push({ number: Number(comment[1]), body: c.body.body }); return ok(201, { id: 900 + comments.length, html_url: `https://github.com/acme/app/issues/${comment[1]}#issuecomment-${900 + comments.length}` }) }
    if (c.method === 'POST' && url === `${API}/graphql`) {
      const data: Record<string, unknown> = {}
      for (const k of Object.keys(c.body.variables).filter((v) => v.startsWith('k'))) data[`i${k.slice(1)}`] = { issue: { state: c.body.variables[k] === 101 ? 'CLOSED' : 'OPEN', stateReason: c.body.variables[k] === 101 ? 'COMPLETED' : null, comments: { nodes: [] } } }
      return ok(200, { data })
    }
    if (url === `${API}/repos/acme/app/issues/7`) return ok(200, { number: 7, state: over.closedAt ? 'closed' : 'open', closed_at: over.closedAt ?? null, body: over.issueBody ?? `## What they said\nhi\n\n## Filed by\nA member (member), through Suggest a change in the app. Report ${ID}.`, user: { login: over.author ?? 'pat-gh' }, ...(over.pr ? { pull_request: {} } : {}) })
    if (url.startsWith(`${API}/repos/acme/app/issues/`)) return ok(404, { message: 'Not Found' })
    if (url.startsWith(`${API}/repos/acme/app/contents/attachments/${ID}?`)) return files.size ? ok(200, [...files].map((name) => ({ name, type: 'file' }))) : ok(404, { message: 'Not Found' })
    if (url === `${API}/repos/acme/app/git/ref/heads/suggestion-attachments`) return branch ? ok(200, { object: { sha: 'c1' } }) : ok(404, {})
    // Large files go through the git data API: a blob, a tree on top of the branch's, a commit, the ref moved.
    if (c.method === 'POST' && url.endsWith('/git/blobs')) { blobs.push(c.body); return ok(201, { sha: `blob${blobs.length}` }) }
    if (c.method === 'GET' && /\/git\/commits\/c\d+$/.test(url)) return ok(200, { sha: 'c1', tree: { sha: 't0' } })
    if (c.method === 'PATCH' && url === `${API}/repos/acme/app/git/refs/heads/suggestion-attachments`) {
      const t = calls.filter((x) => x.url.endsWith('/git/trees')).at(-1)?.body.tree?.[0]
      if (t?.path?.startsWith(`attachments/`)) files.add(t.path.split('/').pop()); return ok(200, {})
    }
    const one = new RegExp(`/repos/acme/app/contents/attachments/${ID}/([^?]+)\\?ref=`).exec(url)
    if (c.method === 'GET' && one) return files.has(one[1]) ? ok(200, { name: one[1] }) : ok(404, {})
    if (url.endsWith('/git/trees')) return ok(201, { sha: 't1' })
    if (url.endsWith('/git/commits')) return ok(201, { sha: 'c1' })
    if (url.endsWith('/git/refs')) { branch = true; return ok(201, {}) }
    if (c.method === 'PUT' && url.startsWith(`${API}/repos/acme/app/contents/attachments/${ID}/`)) {
      const name = url.split('/').pop()!
      if (files.has(name)) return ok(422, { message: 'sha wasn\'t supplied' })
      if (over.putFails) return ok(422, { message: 'Invalid request: content is not valid Base64' })
      files.add(name); return ok(201, {})
    }
    return ok(404, { message: 'Not Found' })
  }) as typeof globalThis.fetch
  return { fetch, calls, opened, comments, blobs, files }
}

/** A staging store as a host would back it with a bucket: a one-time signed PUT, then the relay reads and discards. */
function fakeStaging() {
  const objects = new Map<string, Uint8Array>()
  const issued: { key: string; type: string; bytes: number }[] = []
  const discarded: string[] = []
  const staging = {
    async uploadUrl(key: string, o: { type: string; bytes: number }) { issued.push({ key, ...o }); return { url: `https://staging.test/${key}`, headers: { 'content-type': o.type, 'x-goog-if-generation-match': '0' } } },
    async read(key: string) { return objects.get(key) ?? null },
    async discard(key: string) { discarded.push(key); objects.delete(key) },
  }
  /** What the storage service does with a PUT on one of those links. */
  const put = (url: string, bytes: Uint8Array) => { objects.set(url.replace('https://staging.test/', ''), bytes) }
  return { staging, objects, issued, discarded, put }
}
/** An mp4's first bytes, padded to `size`: enough for the sniffer, large enough to need staging and the git data API. */
const mp4 = (size: number) => { const b = new Uint8Array(size); b.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]); return b }

// Who is calling, as the host knows them: the name, role, app and contact the issue uses come from here, never the request.
const who = (req: Request) => Promise.resolve(
  req.headers.get('authorization') === 'Bearer member' ? { account: 'amy', name: 'Pat Okafor', role: 'member' as const, githubLogin: 'pat-gh', contact: { email: 'pat@example.com' } }
    : req.headers.get('authorization') === 'Bearer ben' ? { account: 'ben', name: 'Ben Okoro' } : null)
const relay = (g: ReturnType<typeof fakeGitHub>, extra: Record<string, unknown> = {}) => createAttachRelay({ app: { id: 1234, privateKey: KEY.privateKey }, identity: who, apps: APPS, fetch: g.fetch, now: () => Date.parse('2026-10-26T18:00:00Z'), ...extra })
// The apps this relay files for, as the host names them: the request names one by its id, and only these are accepted.
const APPS = { notes: { name: 'Notes', label: 'notes' } }
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
      expect(src, f).not.toMatch(/continentalworks|continental works|supersuit suggestions|member key|memberKey/i)
    }
  })
})

// FILING FOR PEOPLE WITH NO ACCESS. The relay opens the issue itself, as the App, for someone who cannot even read the
// repo: the privacy catch runs on the relay, the files go to the branch first, then the issue, and only the identity
// that filed a report may add to it or read its state.
const suggestions = (g: ReturnType<typeof fakeGitHub>, extra: Record<string, unknown> = {}) => createSuggestionRelay({ app: { id: 1234, privateKey: KEY.privateKey }, identity: who, apps: APPS, fetch: g.fetch, now: () => Date.parse('2026-10-26T18:00:00Z'), ...extra })
const act = (action: string, body: unknown, auth = 'Bearer member') => new Request(`https://relay.test/api/suggestions/${action}`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) })
const report = (over: Record<string, unknown> = {}) => ({
  id: ID, kind: 'broken', words: 'The save button is gone.', who: { member: 'amy', role: 'member' },
  voice: [], media: [{ file: 'image-1.png', type: 'image/png', bytes: PNG.length }],
  where: { screen: 'Notes', route: '/notes' }, diagnostics: { appVersion: '1.2.3', at: '2026-10-26T17:04:12Z', device: 'iPhone', screen: '390x844' }, ...over,
})
const filing = (over: Record<string, unknown> = {}) => ({ repo: 'acme/app', report: report(), app: 'notes', filerName: 'Pat Okafor', appVersion: '1.2.3', files: [{ name: 'image-1.png', type: 'image/png', bytes: toBase64(PNG) }], ...over })

describe('createSuggestionRelay: file', () => {
  it('saves the files first, then opens the issue as the App, with the filer\'s name and never their account', async () => {
    const g = fakeGitHub()
    const res = await suggestions(g)(act('file', filing()))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ number: 101, url: 'https://github.com/acme/app/issues/101' })
    const order = g.calls.filter((c) => c.method === 'PUT' || c.url === `${API}/repos/acme/app/issues`).map((c) => c.method)
    expect(order).toEqual(['PUT', 'POST'])
    const issue = g.opened[0]
    expect(issue.labels).toEqual(['bug', 'app:notes'])
    expect(issue.body).toContain('Pat Okafor (member), through Suggest a change in the Notes.')
    expect(issue.body).toContain(`Report ${ID}.`)
    expect(issue.body).toContain(`![image-1.png](https://github.com/acme/app/blob/suggestion-attachments/attachments/${ID}/image-1.png?raw=true)`)
    expect(issue.body).not.toContain('amy')
    expect(g.calls.find((c) => c.url === `${API}/repos/acme/app/issues`)!.auth).toBe('Bearer inst-token')
  })

  it('is idempotent by report id: a repeat answers the same issue; another identity using that id is refused', async () => {
    const g = fakeGitHub()
    const r = suggestions(g)
    expect((await (await r(act('file', filing()))).json())).toMatchObject({ number: 101 })
    const again = await r(act('file', filing()))
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ number: 101, url: 'https://github.com/acme/app/issues/101' })
    expect(g.opened).toHaveLength(1)
    expect((await r(act('file', filing(), 'Bearer ben'))).status).toBe(409)
  })

  it('refuses someone it does not know, a repo the host does not allow for them, and a repo the App is not installed on', async () => {
    const g = fakeGitHub()
    expect((await suggestions(g)(act('file', filing(), 'Bearer stranger'))).status).toBe(401)
    const only = suggestions(g, { repos: (account: string) => (account === 'amy' ? ['acme/app'] : []) })
    expect(await status(await only(act('file', filing(), 'Bearer ben')))).toEqual([403, 'this account may not file on acme/app'])
    expect(await status(await suggestions(g)(act('file', filing({ repo: 'other/x' }))))).toEqual([403, 'the app is not installed on other/x'])
    expect(g.opened).toHaveLength(0)
  })

  it('a credential is refused by its kind and never echoed, even when the filer says they redacted', async () => {
    const g = fakeGitHub()
    const secret = 'AKIA' + 'IOSFODNN7EXAMPLE'
    for (const redacted of [false, true]) {
      const res = await suggestions(g)(act('file', filing({ report: report({ words: `my key ${secret}` }), redacted })))
      expect(res.status).toBe(422)
      const text = await res.text()
      expect(text).toContain('credential')
      expect(text).not.toContain(secret)
    }
    expect(g.opened).toHaveLength(0)
  })

  it('anything else the catch finds holds the report, naming the kind and field only, until the filer has redacted', async () => {
    const g = fakeGitHub()
    const people = [{ name: 'Dana Whitlock' }]
    const r = suggestions(g, { privacy: { people } })
    const held = await r(act('file', filing({ report: report({ words: 'ask Dana Whitlock or mail sam@example.com' }) })))
    expect(held.status).toBe(409)
    const body = await held.text()
    expect(JSON.parse(body)).toEqual({ held: true, hits: [{ kind: 'email', field: 'words' }, { kind: 'person', field: 'words' }] })
    expect(body).not.toMatch(/Dana|sam@/)
    expect(g.opened).toHaveLength(0)
    expect((await r(act('file', filing({ report: report({ words: 'ask [removed]' }), redacted: true })))).status).toBe(200)
  })

  it('refuses a file over the cap, bytes that are not what they say, a file the report did not declare, and an invalid report', async () => {
    const g = fakeGitHub()
    expect((await suggestions(g, { limits: { imageBytes: 8 } })(act('file', filing()))).status).toBe(413)
    expect((await suggestions(g)(act('file', filing({ files: [{ name: 'image-1.png', type: 'image/png', bytes: toBase64(new TextEncoder().encode('MZ this is a program, not a picture')) }] })))).status).toBe(422)
    expect((await suggestions(g)(act('file', filing({ files: [{ name: 'other.png', type: 'image/png', bytes: toBase64(PNG) }] })))).status).toBe(400)
    expect((await suggestions(g)(act('file', filing({ report: report({ kind: 'rant' }) })))).status).toBe(400)
    expect(g.opened).toHaveLength(0)
  })

  it('holds each identity to a daily cap of reports and of bytes', async () => {
    const g = fakeGitHub()
    const r = suggestions(g, { limits: { perPersonPerDay: 1 } })
    expect((await r(act('file', filing()))).status).toBe(200)
    expect((await r(act('file', filing({ report: report({ id: 'r-20261026170412-zzzzzz', media: [] }), files: [] })))).status).toBe(429)
    const b = suggestions(fakeGitHub(), { limits: { bytesPerPersonPerDay: PNG.length } })
    expect((await b(act('file', filing()))).status).toBe(200)
    expect((await b(act('file', filing({ report: report({ id: 'r-20261026170412-zzzzzz' }) })))).status).toBe(429)
  })

  it('an action it does not have is not found', async () => {
    expect((await suggestions(fakeGitHub())(act('delete', {}))).status).toBe(404)
  })
})

describe('createSuggestionRelay: context, contact and roughly where', () => {
  it('passes the contact and the context into the issue, adds the place from geo, and does not hold the sender\'s own email', async () => {
    const g = fakeGitHub()
    const geo = (req: Request) => (req.headers.get('x-country') ? { city: 'Lagos', region: 'LA', country: req.headers.get('x-country')! } : null)
    const r = suggestions(g, { geo })
    const req = act('file', filing({ report: report({ words: 'email me at pat@example.com', who: { member: 'amy', role: 'member', contact: { email: 'pat@example.com' } }, context: { items: [{ key: 'device', label: 'Your device', value: 'Android phone, Android 14, Chrome 129', why: 'so it can be tried on the same phone' }] } }) }))
    req.headers.set('x-country', 'NG')
    expect((await r(req)).status).toBe(200)
    const body = g.opened[0].body
    expect(body).toContain('## Reach them')
    expect(body).toContain('[pat@example.com](mailto:pat@example.com)')
    expect(body).toContain('| Roughly where they were | Lagos, LA, NG |')
    expect(body).toContain('| Your device | Android phone, Android 14, Chrome 129 |')
    expect(body).not.toContain('amy')
  })
})

describe('createSuggestionRelay: follow-up and status, for the one who filed it', () => {
  it('adds a comment for the identity that filed it, and refuses anyone else', async () => {
    const g = fakeGitHub()
    const r = suggestions(g)
    await r(act('file', filing()))
    const add = (auth: string, over: Record<string, unknown> = {}) => r(act('follow-up', { repo: 'acme/app', number: 101, reportId: ID, words: 'one more thing', ...over }, auth))
    const ok = await add('Bearer member')
    expect(ok.status).toBe(200)
    expect(g.comments).toEqual([{ number: 101, body: expect.stringContaining('one more thing') }])
    expect(await status(await add('Bearer ben'))).toEqual([403, 'only the person who filed it may add to it'])
    expect((await add('Bearer member', { number: 7 })).status).toBe(403) // not an issue this identity filed
    expect((await add('Bearer member', { words: 'my key AKIA' + 'IOSFODNN7EXAMPLE' })).status).toBe(422)
    expect(g.comments).toHaveLength(1)
  })

  it('answers the state of the issues this identity filed, and refuses someone else\'s', async () => {
    const g = fakeGitHub()
    const r = suggestions(g)
    await r(act('file', filing()))
    const mine = await r(act('status', { items: [{ repo: 'acme/app', number: 101 }] }))
    expect(mine.status).toBe(200)
    expect(await mine.json()).toEqual({ items: [{ repo: 'acme/app', number: 101, status: 'done' }] })
    expect((await r(act('status', { items: [{ repo: 'acme/app', number: 101 }] }, 'Bearer ben'))).status).toBe(403)
  })
})

describe('the filer\'s side: relayFiler, canFileDirectly and the choice fileSuggestion makes', () => {
  const wire = (g: ReturnType<typeof fakeGitHub>, extra: Record<string, unknown> = {}) => {
    const handler = suggestions(g, extra)
    return (async (input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith('https://relay.test/') ? handler(new Request(String(input), init)) : g.fetch(input, init))) as typeof globalThis.fetch
  }

  it('relayFiler files, follows up and reads status through any relay URL with any headers', async () => {
    const g = fakeGitHub()
    const filer = relayFiler({ url: 'https://relay.test/api/suggestions', headers: { authorization: 'Bearer member' }, fetch: wire(g) })
    const got = await filer.file(filing())
    expect(got).toEqual({ number: 101, url: 'https://github.com/acme/app/issues/101' })
    expect((await filer.followUp({ repo: 'acme/app', number: 101, reportId: ID, words: 'more' })).url).toMatch(/issuecomment/)
    expect(await filer.status([{ repo: 'acme/app', number: 101 }])).toEqual([{ repo: 'acme/app', number: 101, status: 'done' }])
    await expect(filer.file(filing({ report: report({ words: 'mail sam@example.com' }) }))).rejects.toMatchObject({ status: 409, body: { held: true } })
  })

  it('canFileDirectly is true only when the token can see the repo', async () => {
    const f = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof globalThis.fetch
    expect(await canFileDirectly({ repo: 'acme/app', token: 't', fetch: f(200) })).toBe(true)
    expect(await canFileDirectly({ repo: 'acme/app', token: 't', fetch: f(404) })).toBe(false)
    expect(await canFileDirectly({ repo: 'acme/app', token: 't', fetch: f(403) })).toBe(false)
  })

  it('fileSuggestion goes through the relay when the filer\'s own token cannot file, with every file', async () => {
    const g = fakeGitHub()
    const relayed = wire(g)
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => (String(input) === `${API}/repos/acme/app` ? new Response('{}', { status: 404 }) : relayed(input, init))) as typeof globalThis.fetch
    const relay = relayFiler({ url: 'https://relay.test/api/suggestions', headers: { authorization: 'Bearer member' }, fetch })
    const got = await fileSuggestion({ repo: 'acme/app', token: 'no-access', fetch, relay }, { report: report(), compose: { appName: 'Notes', appVersion: '1.2.3', filerName: 'Pat Okafor' }, files: [{ name: 'image-1.png', type: 'image/png', bytes: PNG }] })
    expect(got).toMatchObject({ number: 101, via: 'relay', pending: [] })
    expect(g.opened[0].body).toContain('![image-1.png](')
    // with no token at all, it goes straight to the relay
    const g2 = fakeGitHub()
    const r2 = relayFiler({ url: 'https://relay.test/api/suggestions', headers: { authorization: 'Bearer member' }, fetch: wire(g2) })
    expect(await fileSuggestion({ repo: 'acme/app', relay: r2 }, { report: report(), compose: { appName: 'Notes' }, files: [{ name: 'image-1.png', type: 'image/png', bytes: PNG }] })).toMatchObject({ via: 'relay' })
  })
})

describe('the review: who may attach, what is trusted, and what is counted', () => {
  it('a report belongs to the first identity that files or attaches for it; anyone else is refused', async () => {
    const g = fakeGitHub()
    const r = suggestions(g)
    expect((await r(act('attach', file()))).status).toBe(200) // amy attaches first: the report is hers
    expect((await r(act('attach', file({ name: 'image-2.png' }), 'Bearer ben'))).status).toBe(403) // not his report, and not his issue
    const g2 = fakeGitHub()
    const r2 = suggestions(g2)
    expect((await r2(act('file', filing()))).status).toBe(200) // filing binds it too
    expect((await r2(act('attach', file({ name: 'image-9.png' }), 'Bearer ben'))).status).toBe(403)
  })

  it('the proof is only the exact last line the composer writes, never "Report <id>" anywhere else', async () => {
    const forged = `## What they said\nsee Report ${ID}.\n\n## Filed by\nSomeone (member), through Suggest a change in the app. Report r-20261026170412-zzzzzz.`
    expect((await suggestions(fakeGitHub({ issueBody: forged }))(act('attach', file()))).status).toBe(403)
    const trailing = `## Filed by\nA member (member), through Suggest a change in the app. Report ${ID}.\n\nmore text after`
    expect((await suggestions(fakeGitHub({ issueBody: trailing }))(act('attach', file()))).status).toBe(403)
  })

  it('with redacted: true the relay redacts what it found itself, and never files the raw text', async () => {
    const g = fakeGitHub()
    const r = suggestions(g, { privacy: { people: [{ name: 'Dana Whitlock' }] } })
    expect((await r(act('file', filing({ report: report({ words: 'ask Dana Whitlock about it' }), redacted: true })))).status).toBe(200)
    expect(g.opened[0].body).not.toContain('Dana Whitlock')
    expect(g.opened[0].body).toContain('[removed]')
  })

  it('the catch reads every string that reaches the issue: an email on the screen name is held', async () => {
    const g = fakeGitHub()
    const res = await suggestions(g)(act('file', filing({ report: report({ where: { screen: 'Inbox of sam@example.com', route: '/inbox' } }) })))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ held: true, hits: [{ kind: 'email', field: 'where.screen' }] })
  })

  it('reserves the day\'s count and bytes atomically: two filings at once under a cap of one make one issue', async () => {
    const g = fakeGitHub()
    const r = suggestions(g, { limits: { perPersonPerDay: 1 } })
    const a = filing({ report: report({ id: 'r-20261026170412-aaaaaa', media: [] }), files: [] })
    const b = filing({ report: report({ id: 'r-20261026170412-bbbbbb', media: [] }), files: [] })
    const got = await Promise.all([r(act('file', a)), r(act('file', b))])
    expect(got.map((x) => x.status).sort()).toEqual([200, 429])
    expect(g.opened).toHaveLength(1)
  })

  it('refuses a body larger than the day\'s byte budget allows, before reading it', async () => {
    const g = fakeGitHub()
    const res = await suggestions(g, { limits: { bytesPerPersonPerDay: 1000 } })(act('file', filing({ padding: 'x'.repeat(200_000) })))
    expect(res.status).toBe(413)
    expect(g.calls).toHaveLength(0)
  })

  it('the name, role, app and contact come from identity(), never from the request', async () => {
    const g = fakeGitHub()
    const r = suggestions(g)
    const res = await r(act('file', filing({ filerName: 'Fake Person', appName: 'Evil', report: report({ who: { member: 'someone-else', role: 'maintainer', contact: { email: 'evil@example.com' } } }) })))
    expect(res.status).toBe(200)
    const issue = g.opened[0]
    expect(issue.body).toContain('Pat Okafor (member), through Suggest a change in the Notes.')
    expect(issue.body).not.toMatch(/Fake Person|Evil|evil@example\.com|maintainer/)
    expect(issue.body).toContain('[pat@example.com](mailto:pat@example.com)') // the request asked to share; the address is the host's
    expect(issue.labels).toEqual(['bug', 'app:notes'])
    // no who.contact in the report means the person unticked it: nothing is shared, whatever the host knows
    const g2 = fakeGitHub()
    await suggestions(g2)(act('file', filing({ report: report() })))
    expect(g2.opened[0].body).not.toContain('## Reach them')
    // a request naming no app gets no app label and no app name, whatever else it says
    const g3 = fakeGitHub()
    expect((await suggestions(g3)(act('file', filing({ app: undefined, appName: 'Evil', report: report({ id: 'r-20261026170412-cccccc', media: [] }), files: [] }), 'Bearer ben'))).status).toBe(200)
    expect(g3.opened[0].labels).toEqual(['bug'])
    expect(g3.opened[0].body).toContain('through Suggest a change in an app.')
  })

  it('refuses a repo with a dot segment, and a follow-up on a repo the host does not allow', async () => {
    const g = fakeGitHub()
    expect((await suggestions(g)(act('file', filing({ repo: '../x' })))).status).toBe(400)
    expect((await suggestions(g)(act('file', filing({ repo: 'acme/..' })))).status).toBe(400)
    const usage = memoryUsage()
    expect((await suggestions(g, { usage })(act('file', filing()))).status).toBe(200)
    const closed = suggestions(g, { usage, repos: () => [] })
    expect(await status(await closed(act('follow-up', { repo: 'acme/app', number: 101, reportId: ID, words: 'more' })))).toEqual([403, 'this account may not file on acme/app'])
  })
})

describe('the app comes from the host\'s table', () => {
  it('names the app and its label from apps, by the id the request gives, and refuses one it does not know', async () => {
    const g = fakeGitHub()
    const r = suggestions(g, { apps: { notes: { name: 'Notes', label: 'notes' }, helm: { name: 'Helm', label: 'helm' } } })
    expect((await r(act('file', filing({ app: 'helm' })))).status).toBe(200)
    expect(g.opened[0].labels).toEqual(['bug', 'app:helm'])
    expect(g.opened[0].body).toContain('through Suggest a change in the Helm.')
    expect(await status(await r(act('file', filing({ app: 'evil', report: report({ id: 'r-20261026170412-eeeeee', media: [] }), files: [] }))))).toEqual([400, 'unknown app'])
  })

  it('with no table, no request can name an app', async () => {
    const g = fakeGitHub()
    expect((await suggestions(g, { apps: undefined })(act('file', filing({ app: 'notes' })))).status).toBe(200)
    expect(g.opened[0].labels).toEqual(['bug'])
    expect(g.opened[0].body).toContain('through Suggest a change in an app.')
  })
})

describe('staging: files past a serverless body limit', () => {
  const VID = 'video-1.mp4'
  const big = mp4(1_200_000)
  const videoReport = () => report({ media: [{ file: VID, type: 'video/mp4', bytes: big.length, ms: 5000 }] })
  const get = (action: string) => new Request(`https://relay.test/api/suggestions/${action}`, { method: 'GET' })

  it('says what it can take, so a filer knows before it sends', async () => {
    const plain = await (await suggestions(fakeGitHub())(get('capabilities'))).json()
    expect(plain).toMatchObject({ staging: false, inlineBytes: 3 * 2 ** 20, actions: ['file', 'follow-up', 'status', 'attach'] })
    const st = fakeStaging()
    expect(await (await suggestions(fakeGitHub(), { staging: st.staging })(get('capabilities'))).json()).toMatchObject({ staging: true, actions: ['file', 'follow-up', 'status', 'attach', 'upload-url'] })
  })

  it('upload-url answers a one-time signed PUT for staging/<account>/<report>/<name>, with the day\'s bytes held up front', async () => {
    const st = fakeStaging()
    const r = suggestions(fakeGitHub(), { staging: st.staging })
    const res = await r(act('upload-url', { repo: 'acme/app', reportId: ID, name: VID, type: 'video/mp4', bytes: big.length }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ url: `https://staging.test/staging/amy/${ID}/${VID}`, headers: { 'content-type': 'video/mp4', 'x-goog-if-generation-match': '0' }, staged: VID })
    expect(st.issued).toEqual([{ key: `staging/amy/${ID}/${VID}`, type: 'video/mp4', bytes: big.length }])
    // its refusals
    expect((await r(act('upload-url', { repo: 'acme/app', reportId: ID, name: VID, type: 'video/mp4', bytes: big.length }, 'Bearer stranger'))).status).toBe(401)
    expect((await r(act('upload-url', { repo: 'acme/app', reportId: ID, name: 'x.exe', type: 'application/x-msdownload', bytes: 10 }))).status).toBe(422)
    expect((await r(act('upload-url', { repo: 'acme/app', reportId: ID, name: VID, type: 'video/mp4', bytes: 101 * 2 ** 20 }))).status).toBe(413)
    expect((await r(act('upload-url', { repo: 'acme/app', reportId: ID, name: 'v2.mp4', type: 'video/mp4', bytes: 10 }, 'Bearer ben'))).status).toBe(403) // amy's report
    const tight = suggestions(fakeGitHub(), { staging: fakeStaging().staging, limits: { bytesPerPersonPerDay: 1000 } })
    expect((await tight(act('upload-url', { repo: 'acme/app', reportId: ID, name: VID, type: 'video/mp4', bytes: 5000 }))).status).toBe(429)
    expect((await suggestions(fakeGitHub())(act('upload-url', { repo: 'acme/app', reportId: ID, name: VID, type: 'video/mp4', bytes: 10 }))).status).toBe(404) // no staging: no such action
  })

  it('file takes a staged file: reads it, sniffs it, writes it through the git data API, links it, and discards it', async () => {
    const g = fakeGitHub()
    const st = fakeStaging()
    const r = suggestions(g, { staging: st.staging })
    const u = (await (await r(act('upload-url', { repo: 'acme/app', reportId: ID, name: VID, type: 'video/mp4', bytes: big.length }))).json()) as { url: string }
    st.put(u.url, big)
    const res = await r(act('file', filing({ report: videoReport(), files: [{ name: VID, type: 'video/mp4', staged: VID }] })))
    expect(res.status).toBe(200)
    expect(g.blobs).toHaveLength(1)
    expect(g.blobs[0].encoding).toBe('base64')
    expect(g.calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/git/refs/heads/suggestion-attachments'))).toBe(true)
    expect(g.calls.some((c) => c.method === 'PUT' && c.url.includes(VID))).toBe(false) // never the contents API for a large file
    expect(g.opened[0].body).toContain(`[video-1.mp4](https://github.com/acme/app/blob/suggestion-attachments/attachments/${ID}/${VID}?raw=true)`)
    expect(st.discarded).toEqual([`staging/amy/${ID}/${VID}`])
  })

  it('a staged file that is not what it says, or was never uploaded, files nothing', async () => {
    const g = fakeGitHub()
    const st = fakeStaging()
    const r = suggestions(g, { staging: st.staging })
    expect((await r(act('file', filing({ report: videoReport(), files: [{ name: VID, type: 'video/mp4', staged: VID }] })))).status).toBe(400) // never uploaded
    await r(act('upload-url', { repo: 'acme/app', reportId: ID, name: VID, type: 'video/mp4', bytes: big.length }))
    st.objects.set(`staging/amy/${ID}/${VID}`, new TextEncoder().encode('MZ this is a program'))
    expect((await r(act('file', filing({ report: videoReport(), files: [{ name: VID, type: 'video/mp4', staged: VID }] })))).status).toBe(422)
    expect(g.opened).toHaveLength(0)
  })

  it('a file over the inline cap is refused in words before anything is filed, saying whether staging would take it', async () => {
    const g = fakeGitHub()
    const res = await suggestions(g, { limits: { inlineBytes: 8 } })(act('file', filing()))
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: string }).error).toBe('image-1.png is larger than this relay takes in one request, and it has no staging for larger files')
    const st = suggestions(fakeGitHub(), { limits: { inlineBytes: 8 }, staging: fakeStaging().staging })
    expect(((await (await st(act('file', filing()))).json()) as { error: string }).error).toBe('image-1.png is larger than this relay takes in one request; send it staged (upload-url)')
    expect(g.opened).toHaveLength(0)
  })

  it('attach takes a staged file too', async () => {
    const g = fakeGitHub()
    const st = fakeStaging()
    const r = suggestions(g, { staging: st.staging })
    const u = (await (await r(act('upload-url', { repo: 'acme/app', reportId: ID, name: VID, type: 'video/mp4', bytes: big.length }))).json()) as { url: string }
    st.put(u.url, big)
    const res = await r(act('attach', { repo: 'acme/app', issue: 7, reportId: ID, name: VID, type: 'video/mp4', staged: VID }))
    expect(res.status).toBe(200)
    expect(g.blobs).toHaveLength(1)
    expect(st.discarded).toEqual([`staging/amy/${ID}/${VID}`])
  })

  it('relayFiler stages anything over 2 MB when the relay can, and refuses before filing when it cannot', async () => {
    const g = fakeGitHub()
    const st = fakeStaging()
    const handler = suggestions(g, { staging: st.staging })
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('https://staging.test/')) { st.put(url, new Uint8Array(init!.body as ArrayBuffer)); return new Response(null, { status: 200 }) }
      return url.startsWith('https://relay.test/') ? handler(new Request(url, init)) : g.fetch(input, init)
    }) as typeof globalThis.fetch
    const huge = mp4(2_500_000)
    const filer = relayFiler({ url: 'https://relay.test/api/suggestions', headers: { authorization: 'Bearer member' }, fetch })
    const got = await filer.file({ repo: 'acme/app', app: 'notes', report: report({ media: [{ file: VID, type: 'video/mp4', bytes: huge.length, ms: 5000 }] }), files: [{ name: VID, type: 'video/mp4', bytes: huge }] })
    expect(got.number).toBe(101)
    expect(st.issued.map((i) => i.key)).toEqual([`staging/amy/${ID}/${VID}`])
    const fileCall = g.calls.length // the relay's own GitHub calls happened; the file request itself carried no bytes
    expect(fileCall).toBeGreaterThan(0)
    // a relay with no staging: refused before anything is filed
    const g2 = fakeGitHub()
    const plain = suggestions(g2)
    const f2 = (async (input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith('https://relay.test/') ? plain(new Request(String(input), init)) : g2.fetch(input, init))) as typeof globalThis.fetch
    const noStaging = relayFiler({ url: 'https://relay.test/api/suggestions', headers: { authorization: 'Bearer member' }, fetch: f2 })
    await expect(noStaging.file({ repo: 'acme/app', report: report({ media: [{ file: VID, type: 'video/mp4', bytes: huge.length, ms: 5000 }] }), files: [{ name: VID, type: 'video/mp4', bytes: huge }] })).rejects.toThrow(/video-1\.mp4 is larger than this relay takes/)
    expect(g2.opened).toHaveLength(0)
  })
})

describe('the second review', () => {
  const VID = 'video-1.mp4'
  const big = mp4(1_200_000)
  const videoReport = () => report({ media: [{ file: VID, type: 'video/mp4', bytes: big.length, ms: 5000 }] })
  const stage = async (r: ReturnType<typeof suggestions>, st: ReturnType<typeof fakeStaging>, bytes: number, body = big) => {
    const u = (await (await r(act('upload-url', { repo: 'acme/app', reportId: ID, name: VID, type: 'video/mp4', bytes }))).json()) as { url: string }
    st.put(u.url, body)
  }

  it('a file listed twice is refused, and a follow-up carries no more files than a report may', async () => {
    const g = fakeGitHub()
    const st = fakeStaging()
    const r = suggestions(g, { staging: st.staging })
    await stage(r, st, big.length)
    const twice = { name: VID, type: 'video/mp4', staged: VID }
    expect(await status(await r(act('file', filing({ report: videoReport(), files: [twice, twice] }))))).toEqual([400, 'video-1.mp4 is listed twice'])
    expect(g.opened).toHaveLength(0)
    await r(act('file', filing()))
    const seven = Array.from({ length: 7 }, (_, i) => ({ name: `image-${i + 2}.png`, type: 'image/png', bytes: toBase64(PNG) }))
    expect((await r(act('follow-up', { repo: 'acme/app', number: 101, reportId: ID, words: 'more', files: seven }))).status).toBe(400)
  })

  it('a staged file is read no further than the bytes upload-url held for it', async () => {
    const g = fakeGitHub()
    const st = fakeStaging()
    const r = suggestions(g, { staging: st.staging })
    await stage(r, st, 100) // asked for 100 bytes, put 1.2 MB
    expect((await r(act('file', filing({ report: videoReport(), files: [{ name: VID, type: 'video/mp4', staged: VID }] })))).status).toBe(413)
    expect(g.opened).toHaveLength(0)
    // and a key upload-url never issued is not read at all
    st.objects.set(`staging/amy/${ID}/video-9.mp4`, big)
    const res = await r(act('file', filing({ report: report({ media: [{ file: 'video-9.mp4', type: 'video/mp4', bytes: big.length, ms: 5000 }] }), files: [{ name: 'video-9.mp4', type: 'video/mp4', staged: 'video-9.mp4' }] })))
    expect(res.status).toBe(400)
  })

  it('attach to an issue the relay did not file needs the GitHub login that opened it', async () => {
    expect((await suggestions(fakeGitHub({ author: 'pat-gh' }))(act('attach', file()))).status).toBe(200)
    expect(await status(await suggestions(fakeGitHub({ author: 'someone-else' }))(act('attach', file())))).toEqual([403, 'only the person who opened issue #7 may attach to it'])
    expect((await suggestions(fakeGitHub({ author: 'pat-gh' }))(act('attach', file(), 'Bearer ben'))).status).toBe(403) // ben vouches for no login
    // a refused attach claims nothing: the real author can still attach
    const g = fakeGitHub({ author: 'pat-gh' })
    const usage = memoryUsage()
    expect((await suggestions(g, { usage })(act('attach', file(), 'Bearer ben'))).status).toBe(403)
    expect((await suggestions(g, { usage })(act('attach', file()))).status).toBe(200)
  })

  it('a follow-up is composed and measured before any file is written, and holds to the per-report caps', async () => {
    const g = fakeGitHub()
    const r = suggestions(g)
    await r(act('file', filing()))
    const writes = () => g.calls.filter((c) => c.method === 'PUT' || c.url.endsWith('/git/blobs')).length
    const before = writes()
    const res = await r(act('follow-up', { repo: 'acme/app', number: 101, reportId: ID, words: 'more', transcript: 'talk '.repeat(20_000), files: [{ name: 'image-2.png', type: 'image/png', bytes: toBase64(PNG) }] }))
    expect(res.status).toBe(413)
    expect(writes()).toBe(before)
    // six images already on the report: a seventh through a follow-up is refused
    const full = fakeGitHub({ files: ['image-1.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png'] })
    const r2 = suggestions(full)
    await r2(act('file', filing({ files: [] })))
    expect((await r2(act('follow-up', { repo: 'acme/app', number: 101, reportId: ID, words: 'one more', files: [{ name: 'g.png', type: 'image/png', bytes: toBase64(PNG) }] }))).status).toBe(422)
  })

  it('a filing whose process died is taken over once its lease runs out', async () => {
    let clock = 1_000
    const usage = memoryUsage({ now: () => clock })
    expect((await usage.begin('acme/app', ID, 'amy', 60_000)).state).toBe('go')
    expect((await usage.begin('acme/app', ID, 'amy', 60_000)).state).toBe('busy')
    clock += 60_001
    expect((await usage.begin('acme/app', ID, 'amy', 60_000)).state).toBe('go')
  })

  it('an app name in the request never reaches the issue', async () => {
    const g = fakeGitHub()
    await suggestions(g)(act('file', filing({ app: undefined, report: report({ appName: 'Evil App', filerName: 'Fake' }) })))
    expect(g.opened[0].body).not.toMatch(/Evil App|Fake/)
    expect(g.opened[0].body).toContain('through Suggest a change in an app.')
  })

  it('attach accepts the composer\'s line in both its forms, with an app and without one', async () => {
    const noApp = `## Filed by\nPat Okafor (member), through Suggest a change in an app. Report ${ID}.`
    expect((await suggestions(fakeGitHub({ issueBody: noApp }))(act('attach', file()))).status).toBe(200)
    const withApp = `## Filed by\nPat Okafor (member), through Suggest a change in the Notes. Report ${ID}.`
    expect((await suggestions(fakeGitHub({ issueBody: withApp }))(act('attach', file()))).status).toBe(200)
  })

  it('a store that fails to record the issue once does not make a second one', async () => {
    const g = fakeGitHub()
    const usage = memoryUsage()
    const finish = usage.finish
    let fails = 1
    usage.finish = async (...a) => { if (fails-- > 0) throw new Error('the database blinked'); return finish(...a) }
    const r = suggestions(g, { usage })
    expect(await (await r(act('file', filing()))).json()).toMatchObject({ number: 101 })
    expect(await (await r(act('file', filing()))).json()).toMatchObject({ number: 101 })
    expect(g.opened).toHaveLength(1)
  })

  it('file names go through the privacy catch too', async () => {
    const g = fakeGitHub()
    const name = 'AKIA' + 'IOSFODNN7EXAMPLE.png'
    const res = await suggestions(g)(act('file', filing({ report: report({ media: [{ file: name, type: 'image/png', bytes: PNG.length }] }), files: [{ name, type: 'image/png', bytes: toBase64(PNG) }] })))
    expect(res.status).toBe(422)
    expect(await res.text()).not.toContain('IOSFODNN7EXAMPLE')
    expect(g.opened).toHaveLength(0)
  })
})

describe('branchHost and a contents API refusal that is not "already written"', () => {
  it('re-checks: a 422 for any other reason is an error, never a link', async () => {
    const g = fakeGitHub({ putFails: true })
    const host = branchHost({ repo: 'acme/app', token: 'inst-token', fetch: g.fetch })
    await expect(host.put({ repo: 'acme/app', issue: 7, reportId: ID }, { name: 'image-5.png', type: 'image/png', bytes: PNG })).rejects.toMatchObject({ status: 422 })
  })
})
