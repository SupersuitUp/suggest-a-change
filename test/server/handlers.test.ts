import { describe, expect, it } from 'vitest'
import { createReportHandlers, type TellEvent } from '../../src/server/index.ts'
import { makeMemoryStore } from './memory-store.ts'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82])
const sha = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))].map((x) => x.toString(16).padStart(2, '0')).join('')

let n = 0
const newId = () => `r-20261012090000-${String(100000 + ++n).slice(1).padStart(6, 'a')}`
const rid = () => `r-20261012090000-a${String(++n).padStart(5, '0')}`

function setup(extra: { limits?: { perPersonPerDay?: number }; tell?: (e: TellEvent) => void } = {}) {
  const mem = makeMemoryStore()
  const h = createReportHandlers({
    store: mem.store,
    identity: async (req) => { const u = req.headers.get('x-user'); return u ? { account: u } : null },
    agent: async (req) => req.headers.get('x-agent'),
    maintainers: ['mo', 'lee'],
    now: () => mem.now(),
    ...extra,
  })
  const call = (method: string, path: string, who: { user?: string; agent?: string } | null, body?: unknown) => new Request(`https://app.test${path}`, {
    method,
    headers: { ...(who?.user ? { 'x-user': who.user } : {}), ...(who?.agent ? { 'x-agent': who.agent } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const draft = (over: Record<string, unknown> = {}) => ({ id: rid(), kind: 'change', words: 'make the photos bigger', who: { member: 'x', role: 'maintainer' }, voice: [], media: [], where: { screen: 'Home', route: '/' }, diagnostics: {}, ...over })
  const send = async (user: string, over: Record<string, unknown> = {}) => {
    const body = draft(over)
    const res = await h.submit(call('POST', '/api/reports', { user }, body))
    return { res, id: body.id as string, body }
  }
  /** A report with one PNG, uploaded and finalized, ready to collect. */
  const withPhoto = async (user = 'amy') => {
    const { id } = await send(user, { media: [{ file: 'a.png', type: 'image/png', bytes: PNG.length, sha256: await sha(PNG) }] })
    const link = await h.uploadUrl(call('POST', '/api/reports/upload-url', { user }, { reportId: id, file: 'a.png', type: 'image/png', bytes: PNG.length }))
    expect(link.status).toBe(200)
    await mem.upload(id, 'a.png', PNG)
    const fin = await h.finalize(call('POST', `/api/reports/${id}/finalize`, { user }, { file: 'a.png' }), id)
    expect(fin.status).toBe(200)
    return id
  }
  return { mem, h, call, draft, send, withPhoto }
}

describe('hosted report handlers', () => {
  it('someone signed out cannot send', async () => {
    const { h, call, mem, draft } = setup()
    const res = await h.submit(call('POST', '/api/reports', null, draft()))
    expect(res.status).toBe(401)
    expect(mem.reports.size).toBe(0)
    expect((await h.mine(call('GET', '/api/reports/mine', null))).status).toBe(401)
    expect((await h.one(call('GET', '/x', null), rid())).status).toBe(401)
    expect((await h.uploadUrl(call('POST', '/x', null, {}))).status).toBe(401)
    expect((await h.append(call('POST', '/x', null, {}), rid())).status).toBe(401)
    expect((await h.agentList(call('GET', '/x', null))).status).toBe(401)
  })

  it("one member cannot read another's report", async () => {
    const { h, call, send } = setup()
    const { id } = await send('amy')
    const theirs = await h.one(call('GET', `/api/reports/${id}`, { user: 'ben' }), id)
    const missing = await h.one(call('GET', `/api/reports/r-20261012090000-zzzzzz`, { user: 'ben' }), 'r-20261012090000-zzzzzz')
    expect(theirs.status).toBe(404)
    expect([theirs.status, await theirs.text()]).toEqual([missing.status, await missing.text()]) // no tell between "not yours" and "not there"
    expect((await h.one(call('GET', `/api/reports/${id}`, { user: 'amy' }), id)).status).toBe(200)
    expect(await (await h.mine(call('GET', '/m', { user: 'ben' }))).json()).toEqual([])
    // every other member route gives the same answer for someone else's report as for a missing one
    for (const [fn, path, body] of [
      [h.append, 'append', { followId: 'f1', words: 'hi' }],
    ] as const) {
      const a = await fn(call('POST', path, { user: 'ben' }, body), id)
      const b = await fn(call('POST', path, { user: 'ben' }, body), 'r-20261012090000-zzzzzz')
      expect([a.status, await a.text()]).toEqual([b.status, await b.text()])
    }
    const up = (reportId: string) => h.uploadUrl(call('POST', '/u', { user: 'ben' }, { reportId, file: 'a.png', type: 'image/png', bytes: 5 }))
    const [u1, u2] = [await up(id), await up('r-20261012090000-zzzzzz')]
    expect([u1.status, await u1.text()]).toEqual([u2.status, await u2.text()])
    const fin = (reportId: string) => h.finalize(call('POST', '/f', { user: 'ben' }, { file: 'a.png' }), reportId)
    const [f1, f2] = [await fin(id), await fin('r-20261012090000-zzzzzz')]
    expect([f1.status, await f1.text()]).toEqual([f2.status, await f2.text()])
  })

  it('a maintainer can; a plain member cannot', async () => {
    const { h, call, send, mem } = setup()
    const { id } = await send('amy')
    expect((await h.one(call('GET', 'x', { user: 'mo' }), id)).status).toBe(200)
    expect((await h.one(call('GET', 'x', { user: 'ben' }), id)).status).toBe(404)
    // the role is the server's: a member who claims to be a maintainer is stored as a member, a maintainer as one
    const sneaky = await send('ben', { who: { member: 'mo', role: 'maintainer' } })
    expect(mem.reports.get(sneaky.id)!.who).toEqual({ member: 'ben', role: 'member' })
    const real = await send('mo', { who: { member: 'amy', role: 'member' } })
    expect(mem.reports.get(real.id)!.who).toEqual({ member: 'mo', role: 'maintainer' })
    // the agent routes are for a maintainer's Mac only
    expect((await h.agentList(call('GET', 'x', { agent: 'ben' }))).status).toBe(401)
    expect((await h.agentList(call('GET', 'x', { agent: 'mo' }))).status).toBe(200)
  })

  it('a report that carries a timeline, status, plan or decision is refused', async () => {
    const { h, call, draft, mem } = setup()
    for (const field of ['timeline', 'status', 'plan', 'decision']) {
      const res = await h.submit(call('POST', 'x', { user: 'amy' }, draft({ [field]: field === 'timeline' ? [{ status: 'live' }] : 'live' })))
      expect(res.status, field).toBe(400)
    }
    expect(mem.reports.size).toBe(0)
  })

  it('an oversized upload link is never issued', async () => {
    const { h, call, send, mem } = setup()
    const big = await send('amy', { media: [{ file: 'a.png', type: 'image/png', bytes: 10 * 2 ** 20 }, { file: 'v.mp4', type: 'video/mp4', bytes: 100 * 2 ** 20 }] })
    expect(big.res.status).toBe(200)
    const ask = (over: Record<string, unknown>) => h.uploadUrl(call('POST', 'u', { user: 'amy' }, { reportId: big.id, file: 'a.png', type: 'image/png', bytes: 5, ...over }))
    expect((await ask({ bytes: 10 * 2 ** 20 + 1 })).status).toBe(413)
    expect((await ask({ file: 'v.mp4', type: 'video/mp4', bytes: 100 * 2 ** 20 + 1 })).status).toBe(413)
    expect((await ask({ file: 'other.png' })).status).toBe(400) // not part of the report
    expect((await ask({ type: 'application/x-msdownload' })).status).toBe(400)
    expect((await ask({ type: 'image/jpeg' })).status).toBe(400) // not the type the report declared
    expect(mem.calls.uploadUrl).toBe(0)
    const fine = await ask({ bytes: 5 })
    expect(fine.status).toBe(200)
    expect(mem.calls.uploadUrl).toBe(1)
    // a report that declares more than the ceiling never gets stored at all
    expect((await send('amy', { media: [{ file: 'b.png', type: 'image/png', bytes: 10 * 2 ** 20 + 1 }] })).res.status).toBe(422)
  })

  it('a file whose contents are not its type is refused at finalize', async () => {
    const { h, call, send, mem } = setup()
    const { id } = await send('amy', { media: [{ file: 'a.png', type: 'image/png', bytes: 40 }] })
    await h.uploadUrl(call('POST', 'u', { user: 'amy' }, { reportId: id, file: 'a.png', type: 'image/png', bytes: 40 }))
    await mem.upload(id, 'a.png', new TextEncoder().encode('MZ this is a program, not a picture at all.'.slice(0, 40)))
    const res = await h.finalize(call('POST', 'f', { user: 'amy' }, { file: 'a.png' }), id)
    expect(res.status).toBe(422)
    expect(mem.calls.discard).toBe(1)
    expect(mem.reports.get(id)!.files!['a.png'].sha256).toBeUndefined()
    // the Mac is never given a link to it
    expect((await h.agentFile(call('GET', 'x', { agent: 'mo' }), id, 'a.png')).status).toBe(404)
    // a real PNG declared as a JPEG is refused too
    const j = await send('amy', { media: [{ file: 'b.jpg', type: 'image/jpeg', bytes: PNG.length }] })
    await h.uploadUrl(call('POST', 'u', { user: 'amy' }, { reportId: j.id, file: 'b.jpg', type: 'image/jpeg', bytes: PNG.length }))
    await mem.upload(j.id, 'b.jpg', PNG)
    expect((await h.finalize(call('POST', 'f', { user: 'amy' }), j.id)).status).toBe(400)
    expect((await h.finalize(call('POST', 'f', { user: 'amy' }, { file: 'b.jpg' }), j.id)).status).toBe(422)
    // finalize before anything arrived is a retryable 409, not a pass
    const k = await send('amy', { media: [{ file: 'c.png', type: 'image/png', bytes: PNG.length }] })
    await h.uploadUrl(call('POST', 'u', { user: 'amy' }, { reportId: k.id, file: 'c.png', type: 'image/png', bytes: PNG.length }))
    expect((await h.finalize(call('POST', 'f', { user: 'amy' }, { file: 'c.png' }), k.id)).status).toBe(409)
  })

  it('a stored file that is smaller than declared is fine, larger is refused, and a different sha256 is refused', async () => {
    const { h, call, send, mem } = setup()
    const { id } = await send('amy', { media: [{ file: 'a.png', type: 'image/png', bytes: PNG.length, sha256: 'a'.repeat(64) }] })
    await h.uploadUrl(call('POST', 'u', { user: 'amy' }, { reportId: id, file: 'a.png', type: 'image/png', bytes: PNG.length }))
    await mem.upload(id, 'a.png', PNG)
    expect((await h.finalize(call('POST', 'f', { user: 'amy' }, { file: 'a.png' }), id)).status).toBe(422)
  })

  it('the twenty-first report in a day is refused', async () => {
    const { send, mem } = setup()
    for (let i = 0; i < 20; i++) expect((await send('amy')).res.status).toBe(200)
    expect((await send('amy')).res.status).toBe(429)
    expect((await send('ben')).res.status).toBe(200) // the limit is per member
    mem.advance(24 * 3600_000)
    expect((await send('amy')).res.status).toBe(200) // and per day
  })

  it('an app may lower the daily limit and never raise it', async () => {
    const low = setup({ limits: { perPersonPerDay: 2 } })
    expect((await low.send('amy')).res.status).toBe(200)
    expect((await low.send('amy')).res.status).toBe(200)
    expect((await low.send('amy')).res.status).toBe(429)
    expect(() => setup({ limits: { perPersonPerDay: 21 } })).toThrow(/never raise/)
  })

  it('the same id submitted twice is one report', async () => {
    const { h, call, send, mem } = setup()
    const first = await send('amy')
    const again = await h.submit(call('POST', 'x', { user: 'amy' }, first.body))
    expect(again.status).toBe(200)
    expect(mem.reports.size).toBe(1)
    expect((await send('amy')).res.status).toBe(200)
    expect(mem.reports.size).toBe(2)
    // another member sending an existing id does not replace it and learns nothing from the answer
    const clash = await h.submit(call('POST', 'x', { user: 'ben' }, { ...first.body, words: 'overwritten' }))
    expect(clash.status).toBe(200)
    expect(mem.reports.get(first.id)!.words).toBe('make the photos bigger')
    expect(mem.reports.get(first.id)!.who.member).toBe('amy')
    // a repeat does not count against the day's limit
    const m = setup()
    const s = await m.send('amy')
    for (let i = 0; i < 25; i++) await m.h.submit(m.call('POST', 'x', { user: 'amy' }, s.body))
    expect((await m.send('amy')).res.status).toBe(200)
  })

  it('a claim that never settles is offered again after ten minutes', async () => {
    const { h, call, send, mem } = setup()
    const { id } = await send('amy')
    const list = async () => ((await (await h.agentList(call('GET', 'x', { agent: 'mo' }))).json()) as { reports: { id: string }[] }).reports.map((r) => r.id)
    expect(await list()).toEqual([id])
    expect(await list()).toEqual([]) // claimed: not handed out twice
    mem.advance(9 * 60_000)
    expect(await list()).toEqual([])
    mem.advance(61_000)
    expect(await list()).toEqual([id])
  })

  it('two maintainers each collect; only the first claims the approval', async () => {
    const { h, call, send } = setup()
    const { id } = await send('amy')
    const list = async (agent: string) => ((await (await h.agentList(call('GET', 'x', { agent }))).json()) as { reports: { id: string }[] }).reports.map((r) => r.id)
    expect(await list('mo')).toEqual([id])
    expect(await list('lee')).toEqual([id]) // mo's claim did not take it from lee
    const first = await h.agentClaimApproval(call('POST', 'x', { agent: 'mo' }, {}), id)
    expect(first.status).toBe(200)
    const second = await h.agentClaimApproval(call('POST', 'x', { agent: 'lee' }, {}), id)
    expect(second.status).toBe(409)
    expect(await second.json()).toEqual({ claimedBy: 'mo' })
    expect((await h.agentClaimApproval(call('POST', 'x', { agent: 'mo' }, {}), id)).status).toBe(200)
    expect((await h.agentClaimApproval(call('POST', 'x', { agent: 'ben' }, {}), id)).status).toBe(401)
  })

  it('settle sets With Freeda and moves attachments under collected/', async () => {
    const { h, call, mem, withPhoto } = setup()
    const id = await withPhoto()
    expect(mem.collectedKeys(id)).toEqual([])
    const list = (await (await h.agentList(call('GET', 'x', { agent: 'mo' }))).json()) as { reports: { id: string }[] }
    expect(list.reports.map((r) => r.id)).toEqual([id])
    expect((await h.agentSettle(call('POST', 'x', { agent: 'lee' }, {}), id)).status).toBe(409) // lee never claimed it
    const res = await h.agentSettle(call('POST', 'x', { agent: 'mo' }, {}), id)
    expect(res.status).toBe(200)
    expect(mem.reports.get(id)!.timeline.map((t) => t.status)).toEqual(['received', 'with-freeda'])
    expect(await mem.collectedKeys(id)).toEqual([`collected/reports/${id}/a.png`])
    // the member sees it, and can still be collected by the other maintainer
    const mine = (await (await h.mine(call('GET', 'x', { user: 'amy' }))).json()) as { status: string }[]
    expect(mine[0].status).toBe('with-freeda')
    const file = await h.agentFile(call('GET', 'x', { agent: 'mo' }), id, 'a.png')
    expect(file.status).toBe(200)
    expect(((await file.json()) as { sha256: string }).sha256).toBe(await sha(PNG))
    expect((await h.agentSettle(call('POST', 'x', { agent: 'mo' }, {}), id)).status).toBe(200) // twice is fine
    expect(mem.reports.get(id)!.timeline).toHaveLength(2)
  })

  it('nothing is ever uploaded through the app\'s own server', async () => {
    const { h, call, mem } = setup()
    const five = new Uint8Array(5 * 2 ** 20)
    const post = (path: string) => new Request(`https://app.test${path}`, { method: 'POST', headers: { 'x-user': 'amy', 'x-agent': 'mo' }, body: five }) // no content-length header: counted as it arrives
    const id = rid()
    for (const res of [
      await h.submit(post('/api/reports')),
      await h.uploadUrl(post('/api/reports/upload-url')),
      await h.append(post('/x'), id),
      await h.finalize(post('/x'), id),
      await h.agentSettle(post('/x'), id),
      await h.agentClaimApproval(post('/x'), id),
      await h.agentStatus(post('/x'), id),
    ]) expect(res.status).toBe(413)
    // and by the header, before reading
    const liar = new Request('https://app.test/api/reports', { method: 'POST', headers: { 'x-user': 'amy', 'content-length': String(5 * 2 ** 20) }, body: '{}' })
    expect((await h.submit(liar)).status).toBe(413)
    expect(mem.reports.size).toBe(0)
    expect(mem.objects.size).toBe(0)
    void call
  })

  it('the agent can only make moves the flow allows, and only a maintainer\'s agent can make them', async () => {
    const { h, call, send, mem } = setup()
    const { id } = await send('amy')
    const status = (agent: string, body: unknown) => h.agentStatus(call('POST', 'x', { agent }, body), id)
    expect((await status('mo', { status: 'being-made' })).status).toBe(409) // received cannot jump to being made
    expect((await status('mo', { status: 'live' })).status).toBe(409)
    expect((await status('mo', { status: 'nonsense' })).status).toBe(400)
    expect((await status('ben', { status: 'with-freeda' })).status).toBe(401)
    expect((await h.agentStatus(call('POST', 'x', { user: 'amy' }, { status: 'with-freeda' }), id)).status).toBe(401) // a member's own session is not an agent
    expect((await status('mo', { status: 'with-freeda' })).status).toBe(200)
    expect((await status('mo', { status: 'with-freeda' })).status).toBe(200) // a retry
    expect((await status('mo', { status: 'planned' })).status).toBe(200)
    expect((await status('mo', { status: 'waiting-on-owner', step: 'Reading the plan' })).status).toBe(200)
    const last = mem.reports.get(id)!.timeline.at(-1)!
    expect(last).toMatchObject({ status: 'waiting-on-owner', by: 'owner', step: 'Reading the plan' })
    expect(JSON.stringify(mem.reports.get(id)!.timeline)).not.toContain('mo"')
  })

  it('a report with attachments still on their way is held back from the Mac, then offered after an hour', async () => {
    const { h, call, send, mem } = setup()
    const { id } = await send('amy', { media: [{ file: 'a.png', type: 'image/png', bytes: PNG.length }] })
    const list = async () => ((await (await h.agentList(call('GET', 'x', { agent: 'mo' }))).json()) as { reports: { id: string }[] }).reports.map((r) => r.id)
    expect(await list()).toEqual([])
    mem.advance(61 * 60_000)
    expect(await list()).toEqual([id])
  })

  it('a follow-up is added once, to the owner\'s report, with the voice ceilings in force', async () => {
    const { h, call, send, mem } = setup()
    const { id } = await send('amy')
    const add = (user: string, body: unknown) => h.append(call('POST', 'x', { user }, body), id)
    expect((await add('amy', { followId: 'f-1', words: 'one more thing', voice: [{ file: 'v1.webm', ms: 1000 }] })).status).toBe(200)
    expect((await add('amy', { followId: 'f-1', words: 'one more thing', voice: [{ file: 'v1.webm', ms: 1000 }] })).status).toBe(200)
    expect(mem.reports.get(id)!.followUps).toHaveLength(1)
    expect((await add('amy', { followId: 'f-2', voice: [{ file: 'v2.webm', ms: 300_001 }] })).status).toBe(400)
    expect((await add('amy', { words: 'no id' })).status).toBe(400)
    // its voice note can be uploaded as audio, and not as anything else
    const up = (type: string) => h.uploadUrl(call('POST', 'u', { user: 'amy' }, { reportId: id, file: 'v1.webm', type, bytes: 1000 }))
    expect((await up('image/png')).status).toBe(400)
    expect((await up('audio/webm;codecs=opus')).status).toBe(200)
  })

  it('tell hears ids and never words, and a failing tell does not fail the request', async () => {
    const heard: TellEvent[] = []
    const { send } = setup({ tell: (e) => { heard.push(e); throw new Error('the notifier is down') } })
    const s = await send('amy', { words: 'my secret words' })
    expect(s.res.status).toBe(200)
    expect(heard).toEqual([{ type: 'submitted', reportId: s.id, member: 'amy' }])
    expect(JSON.stringify(heard)).not.toContain('secret')
  })

  it('the member\'s own view never shows server bookkeeping, and methods are checked', async () => {
    const { h, call, withPhoto } = setup()
    const id = await withPhoto()
    const view = (await (await h.one(call('GET', 'x', { user: 'amy' }), id)).json()) as Record<string, unknown>
    expect(view.files).toBeUndefined()
    expect(view.timeline).toBeDefined()
    expect((await h.mine(call('POST', 'x', { user: 'amy' }, {}))).status).toBe(405)
  })
})
