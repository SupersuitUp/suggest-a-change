import { describe, expect, it } from 'vitest'
import { createReportHandlers, reportRevision, TOLD, type SubmitterNews, type TellEvent } from '../../src/server/index.ts'
import { makeMemoryStore } from './memory-store.ts'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82])
const sha = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))].map((x) => x.toString(16).padStart(2, '0')).join('')

let n = 0
let lastSetup: { h: ReturnType<typeof createReportHandlers>; mem: ReturnType<typeof makeMemoryStore>; call: (m: string, p: string, w: { user?: string; agent?: string } | null, b?: unknown) => Request }
/** The settle a Mac makes: it carries the revision of what it was shown (the stored report as it stands). */
const settle = async (agent: string, id: string) => lastSetup.h.agentSettle(lastSetup.call('POST', 'x', { agent }, { revision: reportRevision((await lastSetup.mem.store.get(id))!) }), id)
const newId = () => `r-20261012090000-${String(100000 + ++n).slice(1).padStart(6, 'a')}`
const rid = () => `r-20261012090000-a${String(++n).padStart(5, '0')}`

function setup(extra: { limits?: Record<string, number>; tell?: (e: TellEvent) => void; tellSubmitter?: ((e: SubmitterNews) => void | Promise<void>) | { none: string }; app?: Record<string, string>; maintainersSince?: Record<string, number | string> } = {}) {
  const mem = makeMemoryStore()
  const h = createReportHandlers({
    store: mem.store,
    identity: async (req) => { const u = req.headers.get('x-user'); return u ? { account: u } : null },
    agent: async (req) => req.headers.get('x-agent'),
    maintainers: ['mo', 'lee'],
    now: () => mem.now(),
    tellSubmitter: { none: 'these tests do not tell anyone' },
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
  lastSetup = { h, mem, call }
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
    expect(mem.reports.get(id)!.files?.['a.png']?.sha256).toBeUndefined()
    expect(await mem.objectKeys(id)).toEqual([]) // the refused object is gone from storage
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
    // another member sending an existing id is REFUSED (409): nothing is created or overwritten, and it is not dropped silently
    const clash = await h.submit(call('POST', 'x', { user: 'ben' }, { ...first.body, words: 'overwritten' }))
    expect(clash.status).toBe(409)
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

  it('settle sets With Pluma and moves attachments under collected/', async () => {
    const { h, call, mem, withPhoto } = setup()
    const id = await withPhoto()
    expect(await mem.collectedKeys(id)).toEqual([])
    const list = (await (await h.agentList(call('GET', 'x', { agent: 'mo' }))).json()) as { reports: { id: string }[] }
    expect(list.reports.map((r) => r.id)).toEqual([id])
    expect((await settle('lee', id)).status).toBe(409) // lee never claimed it
    const res = await settle('mo', id)
    expect(res.status).toBe(200)
    expect(mem.reports.get(id)!.timeline.map((t) => t.status)).toEqual(['received', 'with-freeda'])
    expect(await mem.collectedKeys(id)).toEqual([`collected/reports/${id}/a.png`])
    // the member sees it, and can still be collected by the other maintainer
    const mine = (await (await h.mine(call('GET', 'x', { user: 'amy' }))).json()) as { status: string }[]
    expect(mine[0].status).toBe('with-freeda')
    const file = await h.agentFile(call('GET', 'x', { agent: 'mo' }), id, 'a.png')
    expect(file.status).toBe(200)
    expect(((await file.json()) as { sha256: string }).sha256).toBe(await sha(PNG))
    expect((await settle('mo', id)).status).toBe(200) // twice is fine
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


describe('ceilings and sizes', () => {
  it('media is pictures and videos only; audio is only ever a voice note', async () => {
    const { send } = setup()
    expect((await send('amy', { media: [{ file: 'a.webm', type: 'audio/webm', bytes: 10 }] })).res.status).toBe(400)
    expect((await send('amy', { media: [{ file: 'a.bin', type: 'application/zip', bytes: 10 }] })).res.status).toBe(400)
    expect((await send('amy', { media: [{ file: 'a.avif', type: 'image/avif', bytes: 10 }] })).res.status).toBe(400)
  })

  it('voice notes need a whole number of milliseconds above zero, within the note and total ceilings, and are counted', async () => {
    const { send } = setup()
    const v = (ms: unknown, i = 1) => ({ file: `v${i}.webm`, ms })
    for (const ms of [0, -5, 1.5, '1000', null]) expect((await send('amy', { voice: [v(ms)] })).res.status, String(ms)).toBe(400)
    expect((await send('amy', { voice: [v(300_001)] })).res.status).toBe(400)
    expect((await send('amy', { voice: [v(300_000, 1), v(300_000, 2), v(300_000, 3), v(1, 4)] })).res.status).toBe(422) // total over 15 minutes
    expect((await send('amy', { voice: Array.from({ length: 11 }, (_, i) => v(1000, i)) })).res.status).toBe(400) // too many notes
    expect((await send('amy', { voice: Array.from({ length: 10 }, (_, i) => v(1000, i)) })).res.status).toBe(200)
    const low = setup({ limits: { voiceNotes: 2 } })
    expect((await low.send('amy', { voice: [v(1, 1), v(1, 2), v(1, 3)] })).res.status).toBe(400)
    expect(() => setup({ limits: { voiceNotes: 11 } })).toThrow(/never raise/)
  })

  it('a link\'s size cap comes from the declared entry, not from the type asked for', async () => {
    const { h, call, send, mem } = setup()
    const { id } = await send('amy', { media: [{ file: 'a.jpg', type: 'image/jpeg', bytes: 6 * 2 ** 20 }], voice: [{ file: 'v.webm', ms: 1000 }] })
    const ask = (over: Record<string, unknown>) => h.uploadUrl(call('POST', 'u', { user: 'amy' }, { reportId: id, file: 'a.jpg', type: 'image/jpeg', bytes: 5, ...over }))
    expect((await ask({ type: 'video/mp4', bytes: 50 * 2 ** 20 })).status).toBe(400) // an image cannot ask for a video\'s allowance
    expect((await ask({ type: 'audio/webm', bytes: 50 * 2 ** 20 })).status).toBe(400)
    expect((await ask({ bytes: 6 * 2 ** 20 + 1 })).status).toBe(413) // above what the report declared
    expect((await ask({ file: 'v.webm', type: 'audio/webm', bytes: 26 * 2 ** 20 })).status).toBe(413)
    expect((await ask({ file: 'v.webm', type: 'image/png', bytes: 5 })).status).toBe(400)
    expect(mem.calls.uploadUrl).toBe(0)
    expect((await ask({ bytes: 6 * 2 ** 20 })).status).toBe(200)
  })

  it('a link is issued only for a file the report or a follow-up declared', async () => {
    const { h, call, send, mem } = setup()
    const { id } = await send('amy')
    const ask = (file: string) => h.uploadUrl(call('POST', 'u', { user: 'amy' }, { reportId: id, file, type: 'audio/webm', bytes: 100 }))
    expect((await ask('v9.webm')).status).toBe(400)
    await h.append(call('POST', 'a', { user: 'amy' }, { followId: 'f1', voice: [{ file: 'v9.webm', ms: 500 }] }), id)
    expect((await ask('v9.webm')).status).toBe(200)
    expect(mem.calls.uploadUrl).toBe(1)
  })

  it('a report at the largest size, in a script that takes three or four bytes a character, is accepted', async () => {
    const { send, mem } = setup()
    const han = '\u6c49'.repeat(20_000); const emoji = '\u{1F600}'.repeat(10_000)
    const big = await send('amy', { kind: 'broken', words: han, answers: { happened: han, expected: emoji, steps: han } })
    expect(big.res.status).toBe(200)
    expect(new TextEncoder().encode(JSON.stringify(big.body)).length).toBeGreaterThan(200_000)
    expect(mem.reports.size).toBe(1)
  })
})

describe('what a report may carry', () => {
  it('app is stamped from the server\'s config and where and diagnostics are short text only', async () => {
    const { send, mem } = setup({ app: { name: 'Notes', template: 'acme/notes' } })
    const ok = await send('amy', { app: { name: 'Somebody else\'s app' }, diagnostics: { device: 'iPhone', screen: '390x844' } })
    expect(ok.res.status).toBe(200)
    expect(mem.reports.get(ok.id)!.app).toEqual({ name: 'Notes', template: 'acme/notes' })
    expect((await send('amy', { diagnostics: { device: { deep: 'object' } } })).res.status).toBe(400)
    expect((await send('amy', { diagnostics: { device: 'x'.repeat(201) } })).res.status).toBe(400)
    expect((await send('amy', { where: { screen: 'x'.repeat(201), route: '/' } })).res.status).toBe(400)
    expect((await send('amy', { where: { screen: 'Home', route: '/a?token=1' } })).res.status).toBe(422)
    expect((await send('amy', { diagnostics: { cookie: 'x' } })).res.status).toBe(422)
  })

  it('a member is shown a whitelist: nothing an adapter keeps on the document reaches them', async () => {
    const { h, call, send, mem } = setup()
    const { id } = await send('amy')
    mem.reports.get(id)!.approvalHeldBy = 'mo'; mem.reports.get(id)!.files = { 'a.png': { sha256: 'x' } }
    const view = (await (await h.one(call('GET', 'x', { user: 'amy' }), id)).json()) as Record<string, unknown>
    expect(view.approvalHeldBy).toBeUndefined()
    expect(view.files).toBeUndefined()
    expect(Object.keys(view).sort()).toEqual(['diagnostics', 'followUps', 'id', 'kind', 'media', 'receivedAt', 'timeline', 'voice', 'where', 'who', 'words', 'app'].sort())
  })
})

describe('submit and the existence of other members\' reports', () => {
  it('an id that belongs to someone else is refused, nothing is overwritten, and at the limit it answers as a fresh one does', async () => {
    const { h, call, send, mem } = setup()
    const first = await send('amy')
    const clash = await h.submit(call('POST', 'x', { user: 'ben' }, { ...first.body, words: 'mine' }))
    expect(clash.status).toBe(409)
    expect(mem.reports.get(first.id)).toMatchObject({ words: 'make the photos bigger', who: { member: 'amy' } })
    expect([...mem.reports.values()].filter((r) => r.who.member === 'ben')).toHaveLength(0)
    for (let i = 0; i < 20; i++) await send('ben')
    const fresh = await send('ben')
    const atLimit = await h.submit(call('POST', 'x', { user: 'ben' }, { ...first.body }))
    expect([fresh.res.status, atLimit.status]).toEqual([429, 429]) // the same answer as a fresh submit
    // but a member repeating their own stored report at the limit is still a repeat
    const own = await send('cat'); for (let i = 0; i < 19; i++) await send('cat')
    expect((await h.submit(call('POST', 'x', { user: 'cat' }, own.body))).status).toBe(200)
  })

  it('a double submit does not wipe the files already verified', async () => {
    const { h, call, mem, withPhoto } = setup()
    const id = await withPhoto()
    const stored = mem.reports.get(id)!
    await Promise.all([1, 2, 3].map(() => h.submit(call('POST', 'x', { user: 'amy' }, { id, kind: 'change', words: 'again', media: stored.media, voice: [], where: {}, diagnostics: {} }))))
    expect(mem.reports.get(id)!.files!['a.png'].sha256).toBeTruthy()
    expect(mem.reports.get(id)!.words).toBe('make the photos bigger')
  })
})

describe('what is added after the Mac collected it reaches the Mac', () => {
  const list = async (h: ReturnType<typeof setup>['h'], call: ReturnType<typeof setup>['call'], agent = 'mo') => ((await (await h.agentList(call('GET', 'x', { agent }))).json()) as { reports: { id: string }[] }).reports.map((r) => r.id)

  it('a follow-up added after settle offers the report again', async () => {
    const { h, call, send } = setup()
    const { id } = await send('amy')
    expect(await list(h, call)).toEqual([id])
    await settle('mo', id)
    expect(await list(h, call)).toEqual([])
    await h.append(call('POST', 'a', { user: 'amy' }, { followId: 'f1', words: 'one more thing' }), id)
    expect(await list(h, call)).toEqual([id])
    expect((await settle('mo', id)).status).toBe(200) // settle runs again
    expect(await list(h, call)).toEqual([])
  })

  it('an attachment verified after settle offers the report again, and is moved when settled again', async () => {
    const { h, call, send, mem } = setup()
    const media = [{ file: 'a.png', type: 'image/png', bytes: PNG.length }, { file: 'b.png', type: 'image/png', bytes: PNG.length }]
    const { id } = await send('amy', { media })
    const put = async (file: string) => {
      const l = (await (await h.uploadUrl(call('POST', 'u', { user: 'amy' }, { reportId: id, file, type: 'image/png', bytes: PNG.length }))).json()) as { url: string; headers: Record<string, string> }
      expect(await mem.putViaLink(l, PNG, 'image/png')).toBe('ok')
      expect((await h.finalize(call('POST', 'f', { user: 'amy' }, { file }), id)).status).toBe(200)
    }
    await put('a.png')
    mem.advance(61 * 60_000) // b.png never came, so the Mac is given the report without it
    expect(await list(h, call)).toEqual([id])
    await settle('mo', id)
    expect(await mem.collectedKeys(id)).toHaveLength(1)
    expect(await list(h, call)).toEqual([])
    await put('b.png')
    expect(await list(h, call)).toEqual([id])
    await settle('mo', id)
    expect(await mem.collectedKeys(id)).toHaveLength(2)
    expect((await mem.objectKeys(id)).every((k) => k.startsWith('collected/'))).toBe(true)
  })

  it('a report is offered in pages, oldest first, and not to a maintainer added after it came', async () => {
    const { h, call, send, mem } = setup({ maintainersSince: { lee: '2026-10-12T09:30:00Z' } })
    const ids: string[] = []
    for (let i = 0; i < 25; i++) { ids.push((await send(`m${i}`)).id); mem.advance(1000) }
    const first = await list(h, call); expect(first).toEqual(ids.slice(0, 20))
    expect(await list(h, call)).toEqual(ids.slice(20))
    mem.advance(40 * 60_000)
    const late = (await send('amy')).id
    expect(await list(h, call, 'lee')).toEqual([late]) // lee was added at 09:30: earlier reports are not his
  })

  it('a follow-up count and a follow-up\'s voice notes are capped, and an app may lower and never raise them', async () => {
    const { h, call, send } = setup()
    const { id } = await send('amy')
    const add = (followId: string, voice: unknown[] = []) => h.append(call('POST', 'a', { user: 'amy' }, { followId, voice }), id)
    expect((await add('f0', Array.from({ length: 6 }, (_, i) => ({ file: `x${i}.webm`, ms: 10 })))).status).toBe(400)
    for (let i = 0; i < 10; i++) expect((await add(`g${i}`)).status).toBe(200)
    expect((await add('g10')).status).toBe(400)
    expect(() => setup({ limits: { followUps: 11 } })).toThrow(/never raise/)
  })
})

describe('who holds the approval', () => {
  const walk = async (h: ReturnType<typeof setup>['h'], call: ReturnType<typeof setup>['call'], id: string, to: string[]) => {
    for (const status of to) expect((await h.agentStatus(call('POST', 'x', { agent: 'mo' }, { status }), id)).status, status).toBe(200)
  }

  it('moves before the approval need no claim; leaving waiting-on-owner, being-made and an end status need the holder', async () => {
    const { h, call, send } = setup()
    const { id } = await send('amy')
    const st = (agent: string, status: string) => h.agentStatus(call('POST', 'x', { agent }, { status }), id)
    await walk(h, call, id, ['with-freeda', 'planned', 'waiting-on-owner']) // mo made these without holding anything
    expect((await h.agentClaimApproval(call('POST', 'x', { agent: 'lee' }, {}), id)).status).toBe(200) // lee takes the approval
    const blocked = await st('mo', 'being-made')
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toMatchObject({ claimedBy: 'lee' })
    expect((await st('mo', 'not-now')).status).toBe(409)
    expect((await st('lee', 'being-made')).status).toBe(200)
    expect((await st('mo', 'live')).status).toBe(409)
    expect((await st('mo', 'filed')).status).toBe(409)
    expect((await st('lee', 'live')).status).toBe(200)
  })

  it('planned to being-made takes the claim when nobody holds it, and then the other Mac is blocked', async () => {
    const { h, call, send } = setup()
    const { id } = await send('amy')
    await walk(h, call, id, ['with-freeda', 'planned', 'waiting-on-owner'])
    expect((await h.agentStatus(call('POST', 'x', { agent: 'lee' }, { status: 'being-made' }), id)).status).toBe(200)
    expect(await (await h.agentClaimApproval(call('POST', 'x', { agent: 'mo' }, {}), id)).json()).toEqual({ claimedBy: 'lee' })
    const direct = await send('amy')
    await walk(h, call, direct.id, ['with-freeda', 'planned'])
    expect((await h.agentStatus(call('POST', 'x', { agent: 'lee' }, { status: 'being-made' }), direct.id)).status).toBe(200) // planned -> being-made also needs, and takes, the claim
    expect((await h.agentStatus(call('POST', 'x', { agent: 'mo' }, { status: 'live' }), direct.id)).status).toBe(409)
  })

  it('the holder can release the approval, and after a week another Mac may take it', async () => {
    const { h, call, send, mem } = setup()
    const { id } = await send('amy')
    const claim = (agent: string) => h.agentClaimApproval(call('POST', 'x', { agent }, {}), id)
    const release = (agent: string) => h.agentReleaseApproval(call('POST', 'x', { agent }, {}), id)
    expect((await claim('mo')).status).toBe(200)
    expect((await release('lee')).status).toBe(409)
    expect((await release('mo')).status).toBe(200)
    expect((await claim('lee')).status).toBe(200)
    mem.advance(7 * 24 * 3600_000 + 1)
    expect((await claim('mo')).status).toBe(200)
    expect((await release('ben')).status).toBe(401)
  })
})

describe('a closed or held report', () => {
  const WEEK = 7 * 24 * 3600_000
  const walk = async (h: ReturnType<typeof setup>['h'], call: ReturnType<typeof setup>['call'], id: string, agent: string, to: string[]) => {
    for (const status of to) expect((await h.agentStatus(call('POST', 'x', { agent }, { status }), id)).status, status).toBe(200)
  }

  it('the owner may decline a report Pluma has not planned yet, or has planned', async () => {
    const { h, call, send, mem } = setup()
    const unplanned = await send('amy')
    await walk(h, call, unplanned.id, 'mo', ['with-freeda', 'not-now'])
    expect(mem.reports.get(unplanned.id)!.timeline.map((t) => [t.status, t.by])).toEqual([['received', 'app'], ['with-freeda', 'mac'], ['not-now', 'owner']])
    const planned = await send('amy')
    await walk(h, call, planned.id, 'mo', ['with-freeda', 'planned', 'not-now'])
    const mine = (await (await h.mine(call('GET', 'x', { user: 'amy' }))).json()) as { id: string; status: string }[]
    expect(mine.map((r) => r.status).sort()).toEqual(['not-now', 'not-now'])
  })

  it('a claim on a shipped or declined report answers 409 with the holder, however long after', async () => {
    const { h, call, send } = setup()
    const claim = (agent: string, id: string) => h.agentClaimApproval(call('POST', 'x', { agent }, {}), id)
    const shipped = await send('amy')
    await walk(h, call, shipped.id, 'mo', ['with-freeda', 'planned', 'waiting-on-owner', 'being-made', 'live'])
    const declined = await send('amy')
    await walk(h, call, declined.id, 'mo', ['with-freeda', 'planned', 'waiting-on-owner', 'not-now'])
    for (const id of [shipped.id, declined.id]) {
      const now = await claim('lee', id)
      expect(now.status).toBe(409)
      expect(await now.json()).toMatchObject({ claimedBy: 'mo', closed: true })
    }
    lastSetup.mem.advance(WEEK + 24 * 3600_000) // eight days: the old seven-day lease would have lapsed
    for (const id of [shipped.id, declined.id]) {
      const later = await claim('lee', id)
      expect(later.status).toBe(409)
      expect(await later.json()).toMatchObject({ claimedBy: 'mo', closed: true })
      expect((await claim('mo', id)).status).toBe(409) // closed for the holder too: there is nothing left to approve
    }
  })

  it('a closed report nobody is named on still answers 409, and the claim writes nothing', async () => {
    const { h, call, send, mem } = setup()
    const { id } = await send('amy')
    // A report closed before the holder was recorded on the timeline.
    mem.reports.get(id)!.timeline.push({ status: 'with-freeda', by: 'mac', at: 'x' }, { status: 'not-now', by: 'owner', at: 'y' })
    const res = await h.agentClaimApproval(call('POST', 'x', { agent: 'lee' }, {}), id)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ closed: true, status: 'not-now' })
    // and lee did not quietly become the holder
    expect((await h.agentReleaseApproval(call('POST', 'x', { agent: 'lee' }, {}), id)).status).toBe(409)
  })

  it('a report being made stays with the Mac that started it, past a week', async () => {
    const { h, call, send, mem } = setup()
    const { id } = await send('amy')
    await walk(h, call, id, 'mo', ['with-freeda', 'planned', 'waiting-on-owner', 'being-made'])
    mem.advance(WEEK + 24 * 3600_000)
    const taken = await h.agentClaimApproval(call('POST', 'x', { agent: 'lee' }, {}), id)
    expect(taken.status).toBe(409)
    expect(await taken.json()).toMatchObject({ claimedBy: 'mo' })
    expect((await h.agentStatus(call('POST', 'x', { agent: 'lee' }, { status: 'live' }), id)).status).toBe(409)
    expect((await h.agentClaimApproval(call('POST', 'x', { agent: 'mo' }, {}), id)).status).toBe(200) // the holder keeps it
    expect((await h.agentStatus(call('POST', 'x', { agent: 'mo' }, { status: 'live' }), id)).status).toBe(200)
  })

  it('before the work starts, an unrenewed approval still lapses after a week', async () => {
    const { h, call, send, mem } = setup()
    const { id } = await send('amy')
    await walk(h, call, id, 'mo', ['with-freeda', 'planned', 'waiting-on-owner'])
    expect((await h.agentClaimApproval(call('POST', 'x', { agent: 'mo' }, {}), id)).status).toBe(200)
    expect((await h.agentClaimApproval(call('POST', 'x', { agent: 'lee' }, {}), id)).status).toBe(409)
    mem.advance(WEEK + 1)
    expect((await h.agentClaimApproval(call('POST', 'x', { agent: 'lee' }, {}), id)).status).toBe(200)
  })

  it('the list never offers a report another maintainer closed, and settles it for this one', async () => {
    const { h, call, send } = setup({ limits: { agentPage: 2 } })
    const list = async (agent: string) => ((await (await h.agentList(call('GET', 'x', { agent }))).json()) as { reports: { id: string; heldBy?: string }[] }).reports
    const closed: string[] = []
    for (let i = 0; i < 7; i++) {
      const { id } = await send('amy')
      await walk(h, call, id, 'mo', ['with-freeda', i % 2 ? 'not-now' : 'planned'])
      if (!(i % 2)) await walk(h, call, id, 'mo', ['being-made', 'live'])
      closed.push(id)
    }
    const fresh = await send('amy')
    // Seven closed reports sit ahead of the new one; a page of two (three times over) would never reach it if they were offered.
    expect((await list('lee')).map((r) => r.id)).toEqual([fresh.id])
    lastSetup.mem.advance(11 * 60_000)
    expect((await list('lee')).map((r) => r.id)).toEqual([fresh.id]) // the closed ones were settled for lee, not merely skipped once
  })

  it('the list marks a report another maintainer is making', async () => {
    const { h, call, send } = setup()
    const { id } = await send('amy')
    await walk(h, call, id, 'mo', ['with-freeda', 'planned', 'being-made'])
    const got = ((await (await h.agentList(call('GET', 'x', { agent: 'lee' }))).json()) as { reports: { id: string; heldBy?: string }[] }).reports
    expect(got.map((r) => [r.id, r.heldBy])).toEqual([[id, 'mo']])
    const own = ((await (await h.agentList(call('GET', 'x', { agent: 'mo' }))).json()) as { reports: { id: string; heldBy?: string }[] }).reports
    expect(own.map((r) => [r.id, r.heldBy])).toEqual([[id, undefined]])
  })

  it('a member never sees which maintainer holds a report', async () => {
    const { h, call, send } = setup()
    const { id } = await send('amy')
    await walk(h, call, id, 'mo', ['with-freeda', 'planned', 'being-made', 'live'])
    const view = await (await h.one(call('GET', 'x', { user: 'amy' }), id)).text()
    expect(view).not.toContain('"mo"')
  })
})

describe('the file link the Mac is given', () => {
  it('serves the verified bytes and sha256, expires, and the collected copy is the one served', async () => {
    const { h, call, mem, withPhoto } = setup()
    const id = await withPhoto()
    await h.agentList(call('GET', 'x', { agent: 'mo' }))
    await settle('mo', id)
    const got = (await (await h.agentFile(call('GET', 'x', { agent: 'mo' }), id, 'a.png')).json()) as { url: string; sha256: string; bytes: number; expiresAt: number }
    expect(got).toMatchObject({ sha256: await sha(PNG), bytes: PNG.length })
    expect(Array.from((await mem.getViaLink(got.url))!)).toEqual(Array.from(PNG))
    mem.advance(5 * 60_000 + 1)
    expect(await mem.getViaLink(got.url)).toBeNull()
  })

  it('a verified file cannot be swapped by a live link', async () => {
    const { h, call, mem, withPhoto } = setup()
    const id = await withPhoto()
    const again = await h.uploadUrl(call('POST', 'u', { user: 'amy' }, { reportId: id, file: 'a.png', type: 'image/png', bytes: PNG.length }))
    expect(await again.json()).toEqual({ done: true }) // no link is issued for a verified file
    expect(mem.calls.uploadUrl).toBe(1)
  })
})

describe('races between a Mac and a member', () => {
  const list = async (h: ReturnType<typeof setup>['h'], call: ReturnType<typeof setup>['call']) => ((await (await h.agentList(call('GET', 'x', { agent: 'mo' }))).json()) as { reports: { id: string; revision: string }[] }).reports

  it('a settle needs the revision the list gave; one that grew since is refused and offered again with the addition', async () => {
    const { h, call, send } = setup()
    const { id } = await send('amy')
    const [seen] = await list(h, call)
    expect(seen.id).toBe(id)
    expect((await h.agentSettle(call('POST', 'x', { agent: 'mo' }, {}), id)).status).toBe(400)
    // something arrives between the Mac's list and its settle
    expect((await h.append(call('POST', 'a', { user: 'amy' }, { followId: 'f1', words: 'one more thing' }), id)).status).toBe(200)
    const stale = await h.agentSettle(call('POST', 'x', { agent: 'mo' }, { revision: seen.revision }), id)
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ stale: true })
    const [again] = await list(h, call)
    expect(again.id).toBe(id)
    expect(again.revision).not.toBe(seen.revision)
    expect(((again as unknown) as { followUps: unknown[] }).followUps).toHaveLength(1)
    expect((await h.agentSettle(call('POST', 'x', { agent: 'mo' }, { revision: again.revision }), id)).status).toBe(200)
  })

  it('fifteen follow-ups at once make ten', async () => {
    const { h, call, send, mem } = setup()
    const { id } = await send('amy')
    const got = await Promise.all(Array.from({ length: 15 }, (_, i) => h.append(call('POST', 'a', { user: 'amy' }, { followId: `f${i}`, words: 'w' }), id)))
    expect(got.filter((r) => r.status === 200)).toHaveLength(10)
    expect(mem.reports.get(id)!.followUps).toHaveLength(10)
  })

  it('a verified file is not replaced by a stale pending write', async () => {
    const { h, call, mem, withPhoto } = setup()
    const id = await withPhoto()
    expect(await mem.store.setFile(id, 'a.png', { pending: { type: 'image/png', bytes: 1, issuedAt: Date.now() + 1e9 } })).toBe(false)
    const again = await h.finalize(call('POST', 'f', { user: 'amy' }, { file: 'a.png' }), id)
    expect(again.status).toBe(200)
    expect(mem.calls.discard).toBe(0)
  })
})

describe('who may add to a report, and when', () => {
  it('only the report\'s owner adds to it: a maintainer\'s follow-up is refused like a missing report', async () => {
    const { h, call, send } = setup()
    const { id } = await send('amy')
    const add = (user: string) => h.append(call('POST', 'a', { user }, { followId: 'f1', words: 'hello' }), id)
    const theirs = await add('mo'); const missing = await h.append(call('POST', 'a', { user: 'mo' }, { followId: 'f1', words: 'hello' }), 'r-20261012090000-zzzzzz')
    expect([theirs.status, await theirs.text()]).toEqual([missing.status, await missing.text()])
    expect((await add('amy')).status).toBe(200)
  })

  it('a follow-up on an ended report is refused and does not reopen it', async () => {
    const { h, call, send, mem } = setup()
    const { id } = await send('amy')
    const st = (status: string) => h.agentStatus(call('POST', 'x', { agent: 'mo' }, { status }), id)
    await h.agentList(call('GET', 'x', { agent: 'mo' })); expect((await settle('mo', id)).status).toBe(200)
    for (const s of ['planned', 'waiting-on-owner', 'not-now']) expect((await st(s)).status, s).toBe(200)
    const res = await h.append(call('POST', 'a', { user: 'amy' }, { followId: 'late', words: 'wait' }), id)
    expect(res.status).toBe(409)
    expect(mem.reports.get(id)!.followUps ?? []).toHaveLength(0)
    expect(((await (await h.agentList(call('GET', 'x', { agent: 'mo' }))).json()) as { reports: unknown[] }).reports).toHaveLength(0)
  })

  it('a voice file\'s link is capped by its declared length, so ten seconds cannot claim 25 MB', async () => {
    const { h, call, send } = setup()
    const { id } = await send('amy', { voice: [{ file: 'v.webm', ms: 10_000 }] })
    const ask = (bytes: number) => h.uploadUrl(call('POST', 'u', { user: 'amy' }, { reportId: id, file: 'v.webm', type: 'audio/webm', bytes }))
    expect((await ask(25 * 2 ** 20)).status).toBe(413)
    expect((await ask(2 * 2 ** 20)).status).toBe(413)
    expect((await ask(1_000_000)).status).toBe(200)
  })
})


describe('telling the person who suggested it', () => {
  const told = () => {
    const heard: SubmitterNews[] = []
    const t = setup({ tellSubmitter: (e) => { heard.push(e) }, app: { name: 'Notes', owner: 'Gary' } })
    const st = (id: string, status: string, agent = 'mo', extra: Record<string, unknown> = {}) => t.h.agentStatus(t.call('POST', 'x', { agent }, { status, ...extra }), id)
    const walk = async (id: string, to: string[], agent = 'mo') => { for (const s of to) expect((await st(id, s, agent)).status, s).toBe(200) }
    return { ...t, heard, st, walk }
  }

  it('tells the submitter once on each telling move, with the module words', async () => {
    for (const end of ['live', 'sent-to-template', 'filed', 'not-now']) {
      const { send, walk, heard } = told()
      const { id } = await send('amy')
      await walk(id, ['with-freeda', 'planned', 'being-made', end])
      expect(heard.map((e) => e.status)).toEqual(['being-made', end])
      const last = heard[1]
      expect(last).toMatchObject({ member: 'amy', reportId: id, status: end, ended: true })
      const { wordsFor, meaningFor } = await import('../../src/contract.mjs')
      expect(last.words).toBe(wordsFor(end, { owner: 'Gary' }))
      expect(last.meaning).toBe(meaningFor(end, { owner: 'Gary' }))
      expect(heard[0]).toMatchObject({ status: 'being-made', ended: false, words: 'Being made' })
    }
    expect([...TOLD]).toEqual(['being-made', 'live', 'sent-to-template', 'filed', 'not-now'])
  })

  it('stays quiet on the planning steps and on a repeat', async () => {
    const { send, walk, st, heard } = told()
    const { id } = await send('amy')
    await walk(id, ['with-freeda', 'planned', 'waiting-on-owner'])
    expect(heard).toEqual([])
    await walk(id, ['being-made'])
    expect((await st(id, 'being-made')).status).toBe(200) // a repeat
    expect(heard).toHaveLength(1)
  })

  it('tells nobody when the store refused the move, and a throwing hook still answers 200', async () => {
    const { send, walk, st, heard, mem } = told()
    const { id } = await send('amy')
    await walk(id, ['with-freeda', 'planned'])
    const real = mem.store.setStatus
    mem.store.setStatus = async () => false
    expect((await st(id, 'being-made')).status).toBe(409)
    mem.store.setStatus = real
    expect(heard).toEqual([])
    const boom = setup({ tellSubmitter: () => { throw new Error('the push service is down') } })
    const r = await boom.send('amy')
    for (const s of ['with-freeda', 'planned', 'being-made', 'live']) expect((await boom.h.agentStatus(boom.call('POST', 'x', { agent: 'mo' }, { status: s }), r.id)).status, s).toBe(200)
  })

  it("a maintainer's own report is not told it is being made, and is told it ended", async () => {
    const { send, walk, heard } = told()
    const { id } = await send('mo')
    await walk(id, ['with-freeda', 'planned', 'being-made', 'live'])
    expect(heard.map((e) => e.status)).toEqual(['live'])
    const other = await send('mo')
    await walk(other.id, ['with-freeda', 'planned', 'being-made'], 'lee') // another maintainer making it is news to mo
    expect(heard.map((e) => e.status)).toEqual(['live', 'being-made'])
  })

  it('not-now passes the note and no other status does; words never carry the report', async () => {
    const { send, walk, st, heard } = told()
    const { id } = await send('amy', { words: 'my secret words' })
    await walk(id, ['with-freeda', 'planned', 'being-made'])
    expect((await st(id, 'not-now', 'mo', { note: 'too big for now' })).status).toBe(200)
    const other = await send('amy')
    await walk(other.id, ['with-freeda', 'planned'])
    expect((await st(other.id, 'being-made', 'mo', { note: 'starting', step: 'reading' })).status).toBe(200)
    expect(heard.find((e) => e.status === 'not-now')!.note).toBe('too big for now')
    for (const e of heard.filter((e) => e.status !== 'not-now')) expect(e.note).toBeUndefined()
    expect(JSON.stringify(heard)).not.toContain('secret')
  })

  it('the status tell event carries the member and the status', async () => {
    const events: TellEvent[] = []
    const t = setup({ tell: (e) => { events.push(e) } })
    const { id } = await t.send('amy')
    expect((await t.h.agentStatus(t.call('POST', 'x', { agent: 'mo' }, { status: 'with-freeda' }), id)).status).toBe(200)
    expect(events.at(-1)).toEqual({ type: 'status', reportId: id, member: 'amy', status: 'with-freeda' })
  })

  it('refuses to start without the hook, and accepts an explicit none with a reason', async () => {
    const mem = makeMemoryStore()
    const base = { store: mem.store, identity: async () => null, agent: async () => null, maintainers: ['mo'] }
    expect(() => createReportHandlers(base as never)).toThrow(/tellSubmitter[\s\S]*none/)
    expect(() => createReportHandlers({ ...base, tellSubmitter: { none: '' } })).toThrow(/reason/)
    expect(() => createReportHandlers({ ...base, tellSubmitter: { none: '   ' } })).toThrow(/reason/)
    const quiet = setup({ tellSubmitter: { none: 'only the maintainer uses this app' } })
    const { id } = await quiet.send('amy')
    for (const s of ['with-freeda', 'planned', 'being-made', 'live']) expect((await quiet.h.agentStatus(quiet.call('POST', 'x', { agent: 'mo' }, { status: s }), id)).status, s).toBe(200)
  })
})
