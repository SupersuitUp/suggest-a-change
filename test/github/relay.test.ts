// RUN YOUR OWN RELAY: createAttachRelay saves a file into a repo for someone who can file an issue there but cannot
// push, through the operator's own GitHub App. Every refusal the relay makes has a test here.
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canFileDirectly, createAttachRelay, createSuggestionRelay, fileSuggestion, memoryUsage, relayFiler, relayHost, toBase64 } from '../../src/github/index.ts'

const API = 'https://api.github.com'
const ID = 'r-20261026170412-ab12cd'
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82])
const pair = (type: 'pkcs1' | 'pkcs8') => generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type, format: 'pem' } })
const KEY = pair('pkcs1') // GitHub hands out PKCS#1 keys

type Call = { method: string; url: string; auth: string; body: any }
function fakeGitHub(over: { publicKey?: string; files?: string[]; issueBody?: string; closedAt?: string | null; pr?: boolean } = {}) {
  const calls: Call[] = []
  let branch = false
  let issues = 100
  const files = new Set(over.files ?? [])
  const opened: { number: number; title: string; body: string; labels: string[] }[] = []
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
  return { fetch, calls, opened, comments }
}

// Who is calling, as the host knows them: the name, role, app and contact the issue uses come from here, never the request.
const who = (req: Request) => Promise.resolve(
  req.headers.get('authorization') === 'Bearer member' ? { account: 'amy', name: 'Pat Okafor', role: 'member' as const, appName: 'Notes', contact: { email: 'pat@example.com' } }
    : req.headers.get('authorization') === 'Bearer ben' ? { account: 'ben', name: 'Ben Okoro' } : null)
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
      expect(src, f).not.toMatch(/continentalworks|continental works|supersuit suggestions|member key|memberKey/i)
    }
  })
})

// FILING FOR PEOPLE WITH NO ACCESS. The relay opens the issue itself, as the App, for someone who cannot even read the
// repo: the privacy catch runs on the relay, the files go to the branch first, then the issue, and only the identity
// that filed a report may add to it or read its state.
const suggestions = (g: ReturnType<typeof fakeGitHub>, extra: Record<string, unknown> = {}) => createSuggestionRelay({ app: { id: 1234, privateKey: KEY.privateKey }, identity: who, fetch: g.fetch, now: () => Date.parse('2026-10-26T18:00:00Z'), ...extra })
const act = (action: string, body: unknown, auth = 'Bearer member') => new Request(`https://relay.test/api/suggestions/${action}`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) })
const report = (over: Record<string, unknown> = {}) => ({
  id: ID, kind: 'broken', words: 'The save button is gone.', who: { member: 'amy', role: 'member' },
  voice: [], media: [{ file: 'image-1.png', type: 'image/png', bytes: PNG.length }],
  where: { screen: 'Notes', route: '/notes' }, diagnostics: { appVersion: '1.2.3', at: '2026-10-26T17:04:12Z', device: 'iPhone', screen: '390x844' }, ...over,
})
const filing = (over: Record<string, unknown> = {}) => ({ repo: 'acme/app', report: report(), filerName: 'Pat Okafor', appName: 'Notes', appVersion: '1.2.3', files: [{ name: 'image-1.png', type: 'image/png', bytes: toBase64(PNG) }], ...over })

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
    expect(await status(await r(act('attach', file({ name: 'image-2.png' }), 'Bearer ben')))).toEqual([403, 'this report belongs to someone else'])
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
    // an identity with no app name gets no app label, whatever the request says
    const g3 = fakeGitHub()
    expect((await suggestions(g3)(act('file', filing({ appName: 'Evil', report: report({ id: 'r-20261026170412-cccccc', media: [] }), files: [] }), 'Bearer ben'))).status).toBe(200)
    expect(g3.opened[0].labels).toEqual(['bug'])
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
