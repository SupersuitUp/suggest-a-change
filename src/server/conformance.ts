// THE SUITE EVERY APP'S STORAGE ADAPTER MUST PASS. `runStoreConformance(makeStore, { test })` registers one
// test per rule with the runner the template already uses (node:test, vitest or jest: pass its `test`), against
// a fresh store each time. It needs a harness around the store because only the adapter knows how to do what a
// storage service does (PUT on an upload link, GET on a read link) and how to move its clock.
//
// It is written to FAIL an unsafe adapter: reusable or unconditioned upload links, files or follow-ups lost on a
// round trip, a day's count that includes every put, a stale write that erases a status or a claim, a create
// that is not atomic, a read link that outlives its time limit, a refused object left in storage.
import type { HostedStore, StoredReport } from './handlers.ts'

export interface StoreHarness {
  store: HostedStore
  /** The store's clock now, in ms. */
  now(): number
  /** Moves the store's clock forward. */
  advance(ms: number): Promise<void> | void
  /** What the storage service does with a PUT on an upload link: 'ok' when it stored the object, 'refused' when a condition of the link failed (size, type, already used, object exists). */
  putViaLink(link: { url: string; headers: Record<string, string> }, bytes: Uint8Array, contentType: string): Promise<'ok' | 'refused'>
  /** What the storage service does with a GET on a read link: the bytes, or null when the link is expired or wrong. */
  getViaLink(url: string): Promise<Uint8Array | null>
  /** The storage keys of this report's attachments, wherever they live (collected or not). */
  objectKeys(reportId: string): Promise<string[]> | string[]
}
export type MakeStore = () => StoreHarness | Promise<StoreHarness>
export type ConformanceTest = (name: string, fn: () => Promise<void> | void) => unknown

const ok = (cond: unknown, msg: string): void => { if (!cond) throw new Error(`store conformance: ${msg}`) }
const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))].map((x) => x.toString(16).padStart(2, '0')).join('')

let seq = 0
const mk = (member: string, receivedAt = '2026-10-12T09:00:00.000Z'): StoredReport => {
  seq++
  return {
    id: `r-20261012090000-s${String(seq).padStart(5, '0')}`, kind: 'change', words: 'w', who: { member, role: 'member' }, media: [], voice: [],
    receivedAt, timeline: [{ status: 'received', by: 'app', at: receivedAt }],
  }
}
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82])
const TEXT = new TextEncoder().encode('this is plainly not an image at all')
const link = (h: StoreHarness, id: string, file: string, type: string, bytes: number) => h.store.uploadUrl({ reportId: id, file, type, bytes })
const FUP = { followId: 'f1', words: 'more', at: '2026-10-12T10:00:00.000Z', by: 'member', voice: [{ file: 'v.webm', ms: 1000 }] }

export const checks: { name: string; run(h: StoreHarness): Promise<void> }[] = [
  { name: 'put is create-only: the second put of an id changes nothing', async run({ store }) {
    const r = mk('amy'); ok((await store.put(r)) === 'created', 'the first put was not created')
    ok((await store.put({ ...r, words: 'overwritten' })) === 'exists', 'the second put of an id was not exists')
    ok((await store.get(r.id))?.words === 'w', 'the second put overwrote the report')
    ok((await store.get('r-20260101000000-zzzzzz')) === null, 'get of a missing id is not null')
  } },
  { name: 'put is atomic: of two racing puts of one id exactly one creates', async run({ store }) {
    const r = mk('amy')
    const got = await Promise.all([store.put(r), store.put({ ...r, words: 'other' })])
    ok(got.filter((x) => x === 'created').length === 1, `${got.filter((x) => x === 'created').length} puts of one id were created`)
  } },
  { name: 'the daily limit is counted inside the create: five racing puts against a limit of three make three', async run({ store }) {
    const rs = Array.from({ length: 5 }, () => mk('amy'))
    const got = await Promise.all(rs.map((r) => store.put(r, { dailyLimit: 3 })))
    ok(got.filter((x) => x === 'created').length === 3 && got.filter((x) => x === 'limit').length === 2, `racing puts gave ${got.join(',')}`)
    ok((await store.countToday('amy')) === 3, 'countToday is not 3')
    ok((await store.put(mk('ben'), { dailyLimit: 3 })) === 'created', 'one member\'s limit stopped another member')
  } },
  { name: 'countToday counts reports, not puts: refused duplicates and other writes do not add to it', async run({ store, now, advance }) {
    const r = mk('amy', new Date(now()).toISOString()); await store.put(r)
    await store.put(r); await store.put({ ...r }); await store.setFile(r.id, 'a.png', { pending: { type: 'image/png', bytes: 1 } }); await store.addFollowUp(r.id, FUP)
    ok((await store.countToday('amy')) === 1, `countToday counted ${await store.countToday('amy')} for one report`)
    ok((await store.countToday('ben')) === 0, 'countToday counted another member')
    await advance(26 * 3600_000)
    ok((await store.countToday('amy')) === 0, 'countToday did not start over the next day')
  } },
  { name: 'files and follow-ups survive a round trip through get and listFor, and get returns a copy', async run({ store }) {
    const r = mk('amy'); await store.put(r)
    await store.setFile(r.id, 'a.png', { type: 'image/png', bytes: 16, sha256: 'ab'.repeat(32) })
    await store.addFollowUp(r.id, FUP)
    for (const got of [(await store.get(r.id))!, (await store.listFor('amy')).find((x) => x.id === r.id)!]) {
      ok(got.files?.['a.png']?.sha256 === 'ab'.repeat(32), 'a verified file did not come back')
      ok(got.followUps?.length === 1 && got.followUps[0].followId === 'f1' && got.followUps[0].voice[0].file === 'v.webm', 'a follow-up did not come back')
    }
    const got = (await store.get(r.id))!; got.words = 'changed'; got.timeline.length = 0
    const again = (await store.get(r.id))!
    ok(again.words === 'w' && again.timeline.length === 1, 'the stored report changed through a returned copy')
  } },
  { name: 'setFile sets and removes one file; addFollowUp is once per followId and says when the report is missing', async run({ store }) {
    const r = mk('amy'); await store.put(r)
    await store.setFile(r.id, 'a.png', { pending: { type: 'image/png', bytes: 1 } }); await store.setFile(r.id, 'b.png', { pending: { type: 'image/png', bytes: 1 } })
    await store.setFile(r.id, 'a.png', null)
    const f = (await store.get(r.id))!.files ?? {}
    ok(!('a.png' in f) && 'b.png' in f, 'setFile did not touch only the one file')
    ok((await store.addFollowUp(r.id, FUP)) === 'added' && (await store.addFollowUp(r.id, FUP)) === 'exists', 'addFollowUp is not once per followId')
    ok((await store.get(r.id))!.followUps!.length === 1, 'a repeated follow-up was stored twice')
    ok((await store.addFollowUp('r-20260101000000-zzzzzz', FUP)) === 'missing', 'addFollowUp on a missing report did not say so')
  } },
  { name: 'a stale write cannot erase a status, a claim, a file or a follow-up written at the same moment', async run({ store }) {
    const r = mk('amy'); await store.put(r)
    await store.claim(r.id, 'mo', 600_000)
    await Promise.all([
      store.setFile(r.id, 'a.png', { pending: { type: 'image/png', bytes: 1 } }),
      store.setStatus(r.id, { status: 'with-freeda', by: 'mac', at: '2026-10-12T10:00:00.000Z' }),
      store.claimApproval(r.id, 'mo', 600_000),
      store.addFollowUp(r.id, FUP),
    ])
    const got = (await store.get(r.id))!
    ok(got.timeline.length === 2 && got.timeline[1].status === 'with-freeda', 'a concurrent write erased the status')
    ok(!!got.files?.['a.png'] && got.followUps?.length === 1, 'a concurrent write erased a file or a follow-up')
    const c = await store.claimApproval(r.id, 'lee', 600_000)
    ok('claimedBy' in c && c.claimedBy === 'mo', 'a concurrent write erased the approval claim')
    ok(!(await store.listOpenFor('mo', { limit: 10 })).some((x) => x.id === r.id), 'a concurrent write erased the lease')
  } },
  { name: 'setStatus appends in order, and refuses when the last status is not the one expected', async run({ store }) {
    const r = mk('amy'); await store.put(r)
    ok((await store.setStatus(r.id, { status: 'planned', by: 'freeda', at: 'x' }, 'with-freeda')) === false, 'setStatus ignored its precondition')
    ok((await store.get(r.id))!.timeline.length === 1, 'a refused setStatus still appended')
    ok((await store.setStatus(r.id, { status: 'with-freeda', by: 'mac', at: 'y' }, 'received')) === true, 'setStatus refused a satisfied precondition')
    const t = (await store.get(r.id))!.timeline
    ok(t.length === 2 && t[0].status === 'received' && t[1].status === 'with-freeda', 'the timeline did not gain the new entry at the end')
  } },
  { name: 'listFor returns a member\'s own reports and no one else\'s', async run({ store }) {
    const a = mk('amy'); const b = mk('ben'); await store.put(a); await store.put(b)
    const got = (await store.listFor('amy')).map((x) => x.id)
    ok(got.includes(a.id) && !got.includes(b.id), 'listFor leaked or lost a report')
    ok((await store.listFor('nobody')).length === 0, 'listFor of a member with none is not empty')
  } },
  { name: 'listOpenFor is oldest first, bounded by limit, and skips reports before `since`', async run({ store }) {
    const old = mk('amy', '2026-10-10T09:00:00.000Z'); const mid = mk('amy', '2026-10-11T09:00:00.000Z'); const fresh = mk('amy', '2026-10-12T08:00:00.000Z')
    for (const r of [fresh, old, mid]) await store.put(r)
    const ids = (await store.listOpenFor('mo', { limit: 10 })).map((x) => x.id)
    ok(ids.join() === [old.id, mid.id, fresh.id].join(), 'listOpenFor is not oldest first')
    ok((await store.listOpenFor('mo', { limit: 2 })).length === 2, 'listOpenFor ignored its limit')
    ok((await store.listOpenFor('mo', { limit: 10, since: Date.parse('2026-10-11T00:00:00Z') })).map((x) => x.id).join() === [mid.id, fresh.id].join(), 'listOpenFor ignored since')
  } },
  { name: 'a claim hides the report from that maintainer for the lease and offers it again after', async run({ store, advance }) {
    const r = mk('amy'); await store.put(r)
    ok((await store.listOpenFor('mo', { limit: 10 })).some((x) => x.id === r.id), 'an unclaimed report is not open')
    await store.claim(r.id, 'mo', 600_000)
    ok(!(await store.listOpenFor('mo', { limit: 10 })).some((x) => x.id === r.id), 'a claimed report is still offered within its lease')
    ok((await store.listOpenFor('lee', { limit: 10 })).some((x) => x.id === r.id), 'one maintainer\'s claim hid the report from another')
    await advance(600_001)
    ok((await store.listOpenFor('mo', { limit: 10 })).some((x) => x.id === r.id), 'a claim that never settled was not offered again')
  } },
  { name: 'settle needs a claim, is per maintainer, and reopen offers the report again', async run({ store }) {
    const r = mk('amy'); await store.put(r)
    ok((await store.settle(r.id, 'mo')) === false, 'settle without a claim said yes')
    await store.claim(r.id, 'mo', 600_000)
    ok((await store.settle(r.id, 'mo')) === true && (await store.settle(r.id, 'mo')) === true, 'settle is not idempotent')
    ok(!(await store.listOpenFor('mo', { limit: 10 })).some((x) => x.id === r.id), 'a settled report is still open for the maintainer who settled it')
    ok((await store.listOpenFor('lee', { limit: 10 })).some((x) => x.id === r.id), 'one maintainer settling closed the report for another')
    ok((await store.reopen(r.id)) === true, 'reopen of a settled report said nothing was cleared')
    ok((await store.listOpenFor('mo', { limit: 10 })).some((x) => x.id === r.id), 'reopen did not offer the report again')
    ok((await store.reopen(r.id)) === false, 'reopen of an unsettled report said it cleared something')
  } },
  { name: 'claimApproval is first-wins and atomic; the holder keeps it; it can be released; it expires', async run({ store, advance }) {
    const r = mk('amy'); await store.put(r)
    const both = await Promise.all([store.claimApproval(r.id, 'mo', 1000), store.claimApproval(r.id, 'lee', 1000)])
    const winners = both.filter((x) => 'ok' in x)
    ok(winners.length === 1, `${winners.length} maintainers won a claim that only one may hold`)
    const holder = both[0] === winners[0] ? 'mo' : 'lee'; const other = holder === 'mo' ? 'lee' : 'mo'
    ok((both.find((x) => 'claimedBy' in x) as { claimedBy: string }).claimedBy === holder, 'the loser was not told who holds it')
    ok('ok' in (await store.claimApproval(r.id, holder, 1000)), 'the holder asking again lost it')
    ok((await store.releaseApproval(r.id, other)) === false, 'a maintainer who does not hold it released it')
    ok((await store.releaseApproval(r.id, holder)) === true, 'the holder could not release it')
    ok('ok' in (await store.claimApproval(r.id, other, 1000)), 'a released approval could not be taken')
    await advance(1001)
    ok('ok' in (await store.claimApproval(r.id, holder, 1000)), 'an expired approval could not be taken by another maintainer')
  } },
  { name: 'upload links are conditioned and one-time: oversize, wrong type, a second PUT and a PUT after finalize are all refused', async run(h) {
    const { store } = h
    const r = mk('amy'); await store.put(r)
    const l = await link(h, r.id, 'a.png', 'image/png', PNG.length)
    ok(typeof l.url === 'string' && l.url.length > 0 && l.headers && typeof l.headers === 'object', 'uploadUrl did not answer { url, headers }')
    ok((await h.putViaLink(l, new Uint8Array(PNG.length + 1), 'image/png')) === 'refused', 'a PUT larger than the link\'s size was accepted')
    ok((await h.putViaLink(l, PNG, 'image/jpeg')) === 'refused', 'a PUT of another type than the link\'s was accepted')
    ok((await h.putViaLink(l, PNG, 'image/png')) === 'ok', 'the right PUT was refused')
    ok((await h.putViaLink(l, PNG, 'image/png')) === 'refused', 'the same link wrote twice')
    const again = await link(h, r.id, 'a.png', 'image/png', PNG.length)
    ok((await h.putViaLink(again, TEXT.subarray(0, 16), 'image/png')) === 'refused', 'a second link overwrote an existing object')
    const f = await store.finalize({ reportId: r.id, file: 'a.png' })
    ok(f?.type === 'image/png' && f.bytes === PNG.length && f.sha256 === (await hex(PNG)), 'finalize did not report the type, size and sha256 of the bytes')
    ok((await h.putViaLink(l, TEXT.subarray(0, 16), 'image/png')) === 'refused', 'a PUT after finalize was accepted')
    ok((await h.putViaLink(again, TEXT.subarray(0, 16), 'image/png')) === 'refused', 'a PUT on a second link after finalize was accepted')
    ok((await store.finalize({ reportId: r.id, file: 'a.png' }))!.sha256 === (await hex(PNG)), 'the verified bytes changed')
  } },
  { name: 'finalize says null for a file that never arrived, and judges bytes rather than the type the link was issued for', async run(h) {
    const { store } = h
    const r = mk('amy'); await store.put(r)
    ok((await store.finalize({ reportId: r.id, file: 'nope.png' })) === null, 'finalize of a missing file was not null')
    const l = await link(h, r.id, 'a.png', 'image/png', TEXT.length)
    ok((await h.putViaLink(l, TEXT, 'image/png')) === 'ok', 'the PUT was refused')
    ok((await store.finalize({ reportId: r.id, file: 'a.png' }))?.type === null, 'finalize believed a declared type over the bytes')
  } },
  { name: 'discard removes a refused object, and a clean one can then be uploaded', async run(h) {
    const { store } = h
    const r = mk('amy'); await store.put(r)
    const l = await link(h, r.id, 'a.png', 'image/png', TEXT.length)
    await h.putViaLink(l, TEXT, 'image/png')
    await store.discard({ reportId: r.id, file: 'a.png' })
    ok((await h.objectKeys(r.id)).length === 0, 'a discarded object is still in storage')
    ok((await store.finalize({ reportId: r.id, file: 'a.png' })) === null, 'a discarded object still finalizes')
    const l2 = await link(h, r.id, 'a.png', 'image/png', PNG.length)
    ok((await h.putViaLink(l2, PNG, 'image/png')) === 'ok', 'a clean upload after a discard was refused')
  } },
  { name: 'moveCollected moves attachments under collected/, is idempotent, keeps them readable, and an old link cannot recreate the old path', async run(h) {
    const { store } = h
    const r = mk('amy'); await store.put(r)
    const l = await link(h, r.id, 'a.png', 'image/png', PNG.length)
    await h.putViaLink(l, PNG, 'image/png')
    ok((await h.objectKeys(r.id)).every((k) => !k.startsWith('collected/')), 'an attachment started out under collected/')
    await store.moveCollected(r.id); await store.moveCollected(r.id)
    const keys = await h.objectKeys(r.id)
    ok(keys.length === 1 && keys.every((k) => k.startsWith('collected/')), 'the attachment is not under collected/ after moveCollected')
    ok((await h.putViaLink(l, TEXT.subarray(0, 16), 'image/png')) === 'refused', 'the old link wrote after the move')
    const fresh = await link(h, r.id, 'a.png', 'image/png', PNG.length)
    ok((await h.putViaLink(fresh, TEXT.subarray(0, 16), 'image/png')) === 'refused', 'a new link recreated the old path beside the collected copy')
    ok((await h.objectKeys(r.id)).length === 1, 'a second copy of the attachment exists')
    const read = await store.readUrl({ reportId: r.id, file: 'a.png', ttlMs: 60_000 })
    ok(await hex((await h.getViaLink(read.url))!) === (await hex(PNG)), 'the read link did not serve the collected copy')
    ok((await store.finalize({ reportId: r.id, file: 'a.png' }))!.sha256 === (await hex(PNG)), 'a collected attachment no longer verifies')
  } },
  { name: 'a read link stops working after its time limit', async run(h) {
    const { store } = h
    const r = mk('amy'); await store.put(r)
    await h.putViaLink(await link(h, r.id, 'a.png', 'image/png', PNG.length), PNG, 'image/png')
    const read = await store.readUrl({ reportId: r.id, file: 'a.png', ttlMs: 60_000 })
    ok((await h.getViaLink(read.url)) !== null, 'a fresh read link did not work')
    await h.advance(60_001)
    ok((await h.getViaLink(read.url)) === null, 'a read link still worked after its time limit')
    let threw = false
    try { await store.readUrl({ reportId: r.id, file: 'nope.png', ttlMs: 60_000 }) } catch { threw = true }
    ok(threw, 'readUrl of a missing file did not fail')
  } },
]

/** Registers every check with the runner you pass (`test` from node:test, vitest or jest), or the global `test` or `it`. */
export async function runStoreConformance(makeStore: MakeStore, opts: { test?: ConformanceTest } = {}): Promise<void> {
  const t: ConformanceTest | undefined = opts.test ?? (globalThis as { test?: ConformanceTest }).test ?? (globalThis as { it?: ConformanceTest }).it
  if (!t) throw new Error('runStoreConformance needs a test runner: pass { test } from node:test, vitest or jest')
  for (const c of checks) t(`store conformance: ${c.name}`, async () => c.run(await makeStore()))
}
