// THE GITHUB CALLS, against a fake GitHub that records every request. Web-standard fetch only.
import { describe, expect, it } from 'vitest'
import { addFollowUp, attachPending, branchHost, fileIssue, fileSuggestion, issueStates, issueStatus, relayHost, updateIssue, type AttachmentHost } from '../../src/github/index.ts'

type Call = { method: string; url: string; headers: Record<string, string>; body: any }
type Route = (c: Call) => { status: number; body?: unknown } | undefined
function fakeFetch(...routes: Route[]) {
  const calls: Call[] = []
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    const c: Call = { method: init.method ?? 'GET', url: String(input), headers, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body }
    calls.push(c)
    for (const r of routes) { const got = r(c); if (got) return new Response(got.body === undefined ? null : JSON.stringify(got.body), { status: got.status, headers: { 'content-type': 'application/json' } }) }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
  }
  return { fetch: fetch as typeof globalThis.fetch, calls }
}
const API = 'https://api.github.com'
const cfg = (f: ReturnType<typeof fakeFetch>) => ({ repo: 'acme/app', token: 'tkn', fetch: f.fetch })
const issueRoute: Route = (c) => (c.method === 'POST' && c.url === `${API}/repos/acme/app/issues` ? { status: 201, body: { number: 7, html_url: 'https://github.com/acme/app/issues/7' } } : undefined)

describe('fileIssue, updateIssue, addFollowUp', () => {
  it('creates missing labels first, ignoring one that exists or that this account may not create, then opens the issue', async () => {
    const f = fakeFetch(
      (c) => (c.url.endsWith('/labels') && c.body.name === 'bug' ? { status: 422, body: { errors: [{ code: 'already_exists' }] } } : undefined),
      (c) => (c.url.endsWith('/labels') && c.body.name === 'app:helm' ? { status: 403, body: { message: 'Must have admin rights' } } : undefined),
      (c) => (c.url.endsWith('/labels') ? { status: 201, body: {} } : undefined),
      issueRoute,
    )
    const got = await fileIssue(cfg(f), { title: 'T', body: 'B', labels: ['bug', 'feedback', 'app:helm'] })
    expect(got).toEqual({ number: 7, url: 'https://github.com/acme/app/issues/7' })
    expect(f.calls.map((c) => `${c.method} ${c.url.replace(API, '')}`)).toEqual(['POST /repos/acme/app/labels', 'POST /repos/acme/app/labels', 'POST /repos/acme/app/labels', 'POST /repos/acme/app/issues'])
    const last = f.calls.at(-1)!
    expect(last.body).toEqual({ title: 'T', body: 'B', labels: ['bug', 'feedback', 'app:helm'] })
    expect(last.headers.authorization).toBe('Bearer tkn')
    expect(last.headers.accept).toBe('application/vnd.github+json')
  })

  it('sends at most ten labels, and refuses a repo with a dot segment', async () => {
    const f = fakeFetch((c) => (c.url.endsWith('/labels') ? { status: 201, body: {} } : undefined), issueRoute)
    await fileIssue(cfg(f), { title: 'T', body: 'B', labels: Array.from({ length: 15 }, (_, i) => `l${i}`) })
    expect(f.calls.filter((c) => c.url.endsWith('/labels'))).toHaveLength(10)
    expect(f.calls.at(-1)!.body.labels).toHaveLength(10)
    await expect(fileIssue({ ...cfg(f), repo: 'acme/..' }, { title: 'T', body: 'B', labels: [] })).rejects.toThrow(/owner\/name/)
    await expect(fileIssue({ ...cfg(f), repo: '../app' }, { title: 'T', body: 'B', labels: [] })).rejects.toThrow(/owner\/name/)
  })

  it('a refused issue throws with GitHub\'s status', async () => {
    const f = fakeFetch((c) => (c.url.endsWith('/issues') ? { status: 410, body: { message: 'Issues are disabled' } } : undefined))
    await expect(fileIssue(cfg(f), { title: 'T', body: 'B', labels: [] })).rejects.toMatchObject({ status: 410 })
  })

  it('updates the body and comments a follow-up on the same issue', async () => {
    const f = fakeFetch(
      (c) => (c.method === 'PATCH' && c.url === `${API}/repos/acme/app/issues/7` ? { status: 200, body: { number: 7 } } : undefined),
      (c) => (c.method === 'POST' && c.url === `${API}/repos/acme/app/issues/7/comments` ? { status: 201, body: { id: 99, html_url: 'https://github.com/acme/app/issues/7#issuecomment-99' } } : undefined),
    )
    await updateIssue(cfg(f), 7, { body: 'final' })
    expect(f.calls[0].body).toEqual({ body: 'final' })
    expect(await addFollowUp(cfg(f), 7, 'one more thing')).toEqual({ id: 99, url: 'https://github.com/acme/app/issues/7#issuecomment-99' })
    expect(f.calls[1].body).toEqual({ body: 'one more thing' })
  })
})

describe('issueStates and issueStatus', () => {
  it('asks for every issue in one GraphQL call, with the repo names as variables', async () => {
    const f = fakeFetch((c) => (c.url === `${API}/graphql` ? { status: 200, body: { data: {
      i0: { issue: { state: 'OPEN', stateReason: null, comments: { nodes: [{ body: 'hi' }] } } },
      i1: { issue: { state: 'CLOSED', stateReason: 'NOT_PLANNED', comments: { nodes: [{ body: 'Too big for now.\nMore later.' }] } } },
      i2: { issue: { state: 'CLOSED', stateReason: 'COMPLETED', comments: { nodes: [] } } },
      i3: { issue: null },
    } } } : undefined))
    const got = await issueStates({ token: 'tkn', fetch: f.fetch }, [{ repo: 'acme/app', number: 1 }, { repo: 'acme/app', number: 2 }, { repo: 'other/x', number: 3 }, { repo: 'acme/app', number: 4 }])
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].body.variables).toMatchObject({ o0: 'acme', n0: 'app', k0: 1, o2: 'other', n2: 'x', k2: 3 })
    expect(f.calls[0].body.query).not.toContain('acme') // names travel as variables, never spliced into the query
    expect(got).toEqual([
      { repo: 'acme/app', number: 1, state: 'OPEN', stateReason: null },
      { repo: 'acme/app', number: 2, state: 'CLOSED', stateReason: 'NOT_PLANNED', reason: 'Too big for now.' },
      { repo: 'other/x', number: 3, state: 'CLOSED', stateReason: 'COMPLETED' },
      { repo: 'acme/app', number: 4, state: null, stateReason: null, missing: true },
    ])
    expect(got.map((s) => (s.state ? issueStatus(s) : null))).toEqual(['open', 'not-planned', 'done', null])
  })

  it('maps GitHub\'s states onto the person\'s three', () => {
    expect(issueStatus({ state: 'OPEN', stateReason: 'REOPENED' })).toBe('open')
    expect(issueStatus({ state: 'closed', stateReason: 'completed' })).toBe('done')
    expect(issueStatus({ state: 'CLOSED', stateReason: null })).toBe('done')
    expect(issueStatus({ state: 'CLOSED', stateReason: 'DUPLICATE' })).toBe('not-planned')
    expect(issueStatus({ state: 'CLOSED', stateReason: 'NOT_PLANNED' })).toBe('not-planned')
  })
})

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const where = { repo: 'acme/app', issue: 7, reportId: 'r-20261026170412-ab12cd' }

describe('branchHost', () => {
  it('creates the orphan branch when it is missing, then commits each file under attachments/<report id>/', async () => {
    let branch = false
    const f = fakeFetch(
      (c) => (c.method === 'GET' && c.url === `${API}/repos/acme/app/git/ref/heads/suggestion-attachments` ? (branch ? { status: 200, body: { object: { sha: 'c1' } } } : { status: 404, body: {} }) : undefined),
      (c) => (c.method === 'POST' && c.url.endsWith('/git/trees') ? { status: 201, body: { sha: 't1' } } : undefined),
      (c) => (c.method === 'POST' && c.url.endsWith('/git/commits') ? { status: 201, body: { sha: 'c1' } } : undefined),
      (c) => (c.method === 'POST' && c.url.endsWith('/git/refs') ? (branch = true, { status: 201, body: {} }) : undefined),
      (c) => (c.method === 'PUT' && c.url.includes('/contents/attachments/') ? { status: 201, body: {} } : undefined),
    )
    const host = branchHost({ repo: 'acme/app', token: 'tkn', fetch: f.fetch })
    const a = await host.put(where, { name: 'image-1.png', type: 'image/png', bytes: PNG })
    expect(a.url).toBe('https://github.com/acme/app/blob/suggestion-attachments/attachments/r-20261026170412-ab12cd/image-1.png?raw=true')
    const commit = f.calls.find((c) => c.url.endsWith('/git/commits'))!
    expect(commit.body.parents).toEqual([]) // an orphan: it shares no history with the code
    expect(f.calls.find((c) => c.url.endsWith('/git/refs'))!.body).toEqual({ ref: 'refs/heads/suggestion-attachments', sha: 'c1' })
    const put = f.calls.find((c) => c.method === 'PUT')!
    expect(put.url).toBe(`${API}/repos/acme/app/contents/attachments/r-20261026170412-ab12cd/image-1.png`)
    expect(put.body.branch).toBe('suggestion-attachments')
    expect(put.body.content).toBe('iVBORw0KGgo=')
    await host.put(where, { name: 'image-2.png', type: 'image/png', bytes: PNG })
    expect(f.calls.filter((c) => c.url.endsWith('/git/refs'))).toHaveLength(1) // the branch is made once
  })

  it('refuses a path outside the attachments folder, and a file already there is its link', async () => {
    const f = fakeFetch(
      (c) => (c.method === 'GET' ? { status: 200, body: { object: { sha: 'c1' } } } : undefined),
      (c) => (c.method === 'PUT' ? { status: 422, body: { message: '"sha" wasn\'t supplied.' } } : undefined),
    )
    const host = branchHost({ repo: 'acme/app', token: 'tkn', fetch: f.fetch })
    await expect(host.put(where, { name: '../main.ts', type: 'image/png', bytes: PNG })).rejects.toThrow(/file name/)
    await expect(host.put({ ...where, reportId: '../../x' }, { name: 'a.png', type: 'image/png', bytes: PNG })).rejects.toThrow(/report id/)
    expect((await host.put(where, { name: 'a.png', type: 'image/png', bytes: PNG })).url).toMatch(/attachments\/r-20261026170412-ab12cd\/a\.png\?raw=true$/)
  })
})

describe('relayHost', () => {
  it('posts the file, with the issue it belongs to, to the relay URL with the headers given, and answers the link', async () => {
    const f = fakeFetch((c) => (c.url === 'https://relay.example/attach' ? { status: 200, body: { url: 'https://github.com/acme/app/blob/suggestion-attachments/attachments/r-20261026170412-ab12cd/a.png?raw=true' } } : undefined))
    const host = relayHost({ url: 'https://relay.example/attach', headers: { authorization: 'Bearer some-key' }, fetch: f.fetch })
    const got = await host.put(where, { name: 'a.png', type: 'image/png', bytes: PNG })
    expect(got.url).toMatch(/^https:\/\/github\.com\/acme\/app\//)
    expect(f.calls[0].headers.authorization).toBe('Bearer some-key')
    expect(f.calls[0].body).toEqual({ repo: 'acme/app', issue: 7, reportId: 'r-20261026170412-ab12cd', name: 'a.png', type: 'image/png', bytes: 'iVBORw0KGgo=' })
  })

  it('refuses an answer that is not a GitHub link, and passes a refusal on with its status', async () => {
    const bad = fakeFetch(() => ({ status: 200, body: { url: 'https://evil.example/a.png' } }))
    await expect(relayHost({ url: 'https://relay.example/attach', fetch: bad.fetch }).put(where, { name: 'a.png', type: 'image/png', bytes: PNG })).rejects.toThrow(/github/)
    const no = fakeFetch(() => ({ status: 403, body: { error: 'the app is not installed on acme/app' } }))
    await expect(relayHost({ url: 'https://relay.example/attach', fetch: no.fetch }).put(where, { name: 'a.png', type: 'image/png', bytes: PNG })).rejects.toMatchObject({ status: 403 })
  })
})

describe('fileSuggestion and attachPending: the issue first, then the files, then the edit', () => {
  const report = { id: 'r-20261026170412-ab12cd', kind: 'broken', words: 'The button is gone.', who: { member: 'x', role: 'member' }, media: [{ file: 'a.png', type: 'image/png', bytes: 8 }, { file: 'b.png', type: 'image/png', bytes: 8 }], voice: [], where: { screen: 'Home', route: '/' }, diagnostics: {} }
  const files = [{ name: 'a.png', type: 'image/png', bytes: PNG }, { name: 'b.png', type: 'image/png', bytes: PNG }]
  const edits = (f: ReturnType<typeof fakeFetch>) => f.calls.filter((c) => c.method === 'PATCH').map((c) => c.body.body as string)

  it('opens the issue saying what is coming, saves each file against that issue, then edits the links in', async () => {
    const order: string[] = []
    const f = fakeFetch((c) => (c.url.endsWith('/labels') ? { status: 201 } : undefined), (c) => { if (c.url.endsWith('/issues')) order.push('issue'); return issueRoute(c) }, (c) => (c.method === 'PATCH' ? (order.push('edit'), { status: 200, body: {} }) : undefined))
    const host: AttachmentHost = { async put(w, file) { order.push(`put ${file.name} #${w.issue}`); return { url: `https://github.com/acme/app/blob/suggestion-attachments/attachments/${w.reportId}/${file.name}?raw=true` } } }
    const got = await fileSuggestion(cfg(f), { report, compose: { appName: 'Helm' }, files, attachments: host })
    expect(order).toEqual(['issue', 'put a.png #7', 'put b.png #7', 'edit'])
    expect(got).toMatchObject({ number: 7, url: 'https://github.com/acme/app/issues/7', pending: [] })
    const first = f.calls.find((c) => c.url.endsWith('/issues'))!.body.body as string
    expect(first).toMatch(/2 screenshots are being added/)
    expect(first).toContain('Report r-20261026170412-ab12cd.') // what the relay checks before it saves anything
    expect(edits(f)[0]).toContain('![a.png](')
    expect(edits(f)[0]).not.toMatch(/being added/)
  })

  it('a file that fails leaves the issue saying it is still coming, and attachPending finishes it later', async () => {
    const f = fakeFetch((c) => (c.url.endsWith('/labels') ? { status: 201 } : undefined), issueRoute, (c) => (c.method === 'PATCH' ? { status: 200, body: {} } : undefined))
    let down = true
    const host: AttachmentHost = { async put(w, file) { if (down && file.name === 'b.png') throw new Error('the site is down'); return { url: `https://github.com/acme/app/blob/suggestion-attachments/attachments/${w.reportId}/${file.name}?raw=true` } } }
    const first = await fileSuggestion(cfg(f), { report, compose: { appName: 'Helm' }, files, attachments: host })
    expect(first.pending).toEqual(['b.png'])
    expect(Object.keys(first.attached)).toEqual(['a.png'])
    expect(edits(f).at(-1)).toMatch(/1 screenshot is being added/)
    down = false
    const later = await attachPending(cfg(f), { number: 7, report, compose: { appName: 'Helm' }, files, attachments: host, attached: first.attached })
    expect(later.pending).toEqual([])
    expect(edits(f).at(-1)).toContain('![b.png](')
    expect(edits(f).at(-1)).not.toMatch(/being added/)
  })

  it('a report with no files is one call: the issue, final from the start', async () => {
    const f = fakeFetch((c) => (c.url.endsWith('/labels') ? { status: 201 } : undefined), issueRoute)
    const got = await fileSuggestion(cfg(f), { report: { ...report, media: [] }, compose: { appName: 'Helm' }, files: [] })
    expect(got.pending).toEqual([])
    expect(f.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0)
  })
})
