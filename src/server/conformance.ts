// THE SUITE EVERY APP'S STORAGE ADAPTER MUST PASS. `runStoreConformance(makeStore)` registers one test per
// rule with the runner the template already uses (node:test, vitest or jest: pass its `test`), against a
// fresh store each time. It needs a harness around the store because only the adapter knows how to put
// bytes in its storage and how to move its clock.
import type { HostedStore, StoredReport } from './handlers.ts'

export interface StoreHarness {
  store: HostedStore
  /** Puts bytes where the upload link would have put them. */
  upload(reportId: string, file: string, bytes: Uint8Array): Promise<void>
  /** The store's clock now, in ms. */
  now(): number
  /** Moves the store's clock forward. */
  advance(ms: number): Promise<void> | void
  /** The storage keys of this report's attachments under the `collected/` prefix. */
  collectedKeys(reportId: string): Promise<string[]> | string[]
}
export type MakeStore = () => StoreHarness | Promise<StoreHarness>
export type ConformanceTest = (name: string, fn: () => Promise<void> | void) => unknown

const ok = (cond: unknown, msg: string): void => { if (!cond) throw new Error(`store conformance: ${msg}`) }
const rejects = async (p: Promise<unknown>, msg: string): Promise<void> => { try { await p } catch { return } throw new Error(`store conformance: ${msg}`) }
const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))].map((x) => x.toString(16).padStart(2, '0')).join('')

let seq = 0
const report = (member: string, id = `r-20261012${String(100000 + ++seq).slice(1).padStart(6, '0')}-abc${String(seq).padStart(3, '0')}`): StoredReport => ({
  id, kind: 'change', words: 'w', who: { member, role: 'member' }, media: [], voice: [],
  receivedAt: new Date().toISOString(), timeline: [{ status: 'received', by: 'app', at: new Date().toISOString() }],
})
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82])
const TEXT = new TextEncoder().encode('this is plainly not an image at all')

export const checks: { name: string; run(h: StoreHarness): Promise<void> }[] = [
  { name: 'a report put is returned by get, and a missing id is null', async run({ store }) {
    const r = report('amy'); await store.put(r)
    ok((await store.get(r.id))?.id === r.id, 'get did not return the report that was put')
    ok((await store.get('r-20260101000000-zzzzzz')) === null, 'get of a missing id is not null')
  } },
  { name: 'get returns a copy: changing it does not change the stored report', async run({ store }) {
    const r = report('amy'); await store.put(r)
    const got = (await store.get(r.id))!; got.words = 'changed'; got.timeline.length = 0
    const again = (await store.get(r.id))!
    ok(again.words === 'w' && again.timeline.length === 1, 'the stored report changed through a returned copy')
  } },
  { name: 'listFor returns a member\'s own reports and no one else\'s', async run({ store }) {
    const a = report('amy'); const b = report('ben'); await store.put(a); await store.put(b)
    const got = (await store.listFor('amy')).map((x) => x.id)
    ok(got.includes(a.id) && !got.includes(b.id), 'listFor leaked or lost a report')
    ok((await store.listFor('nobody')).length === 0, 'listFor of a member with none is not empty')
  } },
  { name: 'countToday counts one member\'s reports for today and starts over the next day', async run({ store, advance, now }) {
    for (let i = 0; i < 3; i++) await store.put({ ...report('amy'), receivedAt: new Date(now()).toISOString() })
    await store.put({ ...report('ben'), receivedAt: new Date(now()).toISOString() })
    ok((await store.countToday('amy')) === 3, 'countToday did not count the member\'s three')
    ok((await store.countToday('ben')) === 1, 'countToday counted another member\'s reports')
    await advance(26 * 3600_000)
    ok((await store.countToday('amy')) === 0, 'countToday did not start over the next day')
  } },
  { name: 'a claim hides the report from that maintainer for the lease and offers it again after', async run({ store, advance }) {
    const r = report('amy'); await store.put(r)
    ok((await store.listOpenFor('mo')).some((x) => x.id === r.id), 'an unclaimed report is not open')
    await store.claim(r.id, 'mo', 600_000)
    ok(!(await store.listOpenFor('mo')).some((x) => x.id === r.id), 'a claimed report is still offered within its lease')
    ok((await store.listOpenFor('lee')).some((x) => x.id === r.id), 'one maintainer\'s claim hid the report from another')
    await advance(600_001)
    ok((await store.listOpenFor('mo')).some((x) => x.id === r.id), 'a claim that never settled was not offered again')
  } },
  { name: 'settle needs a claim, is per maintainer, and removes the report only for that maintainer', async run({ store }) {
    const r = report('amy'); await store.put(r)
    ok((await store.settle(r.id, 'mo')) === false, 'settle without a claim said yes')
    await store.claim(r.id, 'mo', 600_000)
    ok((await store.settle(r.id, 'mo')) === true, 'settle after a claim said no')
    ok((await store.settle(r.id, 'mo')) === true, 'settling twice is not idempotent')
    ok(!(await store.listOpenFor('mo')).some((x) => x.id === r.id), 'a settled report is still open for the maintainer who settled it')
    ok((await store.listOpenFor('lee')).some((x) => x.id === r.id), 'one maintainer settling closed the report for another')
  } },
  { name: 'claimApproval is first-wins, repeats for the holder, and is atomic', async run({ store }) {
    const r = report('amy'); await store.put(r)
    const both = await Promise.all([store.claimApproval(r.id, 'mo'), store.claimApproval(r.id, 'lee')])
    const winners = both.filter((x) => 'ok' in x)
    ok(winners.length === 1, `${winners.length} maintainers won a claim that only one may hold`)
    const loser = both.find((x) => 'claimedBy' in x) as { claimedBy: string }
    const holder = both[0] === winners[0] ? 'mo' : 'lee'
    ok(loser.claimedBy === holder, 'the loser was not told who holds it')
    ok('ok' in (await store.claimApproval(r.id, holder)), 'the holder asking again lost it')
  } },
  { name: 'setStatus appends to the timeline in order', async run({ store }) {
    const r = report('amy'); await store.put(r)
    await store.setStatus(r.id, { status: 'with-freeda', by: 'mac', at: '2026-10-12T10:00:00.000Z' })
    const t = (await store.get(r.id))!.timeline
    ok(t.length === 2 && t[0].status === 'received' && t[1].status === 'with-freeda', 'the timeline did not gain the new entry at the end')
  } },
  { name: 'uploadUrl answers a url and headers', async run({ store }) {
    const r = report('amy'); await store.put(r)
    const l = await store.uploadUrl({ reportId: r.id, file: 'a.png', type: 'image/png', bytes: 16 })
    ok(typeof l.url === 'string' && l.url.length > 0 && l.headers && typeof l.headers === 'object', 'uploadUrl did not answer { url, headers }')
  } },
  { name: 'finalize answers the real type from the bytes, the size and the sha256', async run({ store, upload }) {
    const r = report('amy'); await store.put(r)
    await store.uploadUrl({ reportId: r.id, file: 'a.png', type: 'image/png', bytes: PNG.length })
    await upload(r.id, 'a.png', PNG)
    const f = await store.finalize({ reportId: r.id, file: 'a.png' })
    ok(f.type === 'image/png' && f.bytes === PNG.length && f.sha256 === (await hex(PNG)), 'finalize did not report the type, size and sha256 of the bytes')
  } },
  { name: 'finalize judges the bytes, not the type the link was issued for', async run({ store, upload }) {
    const r = report('amy'); await store.put(r)
    await store.uploadUrl({ reportId: r.id, file: 'a.png', type: 'image/png', bytes: TEXT.length })
    await upload(r.id, 'a.png', TEXT)
    ok((await store.finalize({ reportId: r.id, file: 'a.png' })).type === null, 'finalize believed a declared type over the bytes')
  } },
  { name: 'finalize of a file that never arrived fails', async run({ store }) {
    const r = report('amy'); await store.put(r)
    await rejects(store.finalize({ reportId: r.id, file: 'nope.png' }), 'finalize of a missing file did not fail')
  } },
  { name: 'moveCollected moves attachments under collected/, keeps them readable, and is idempotent', async run({ store, upload, collectedKeys }) {
    const r = report('amy'); await store.put(r)
    await upload(r.id, 'a.png', PNG)
    ok((await collectedKeys(r.id)).length === 0, 'an attachment started out under collected/')
    await store.moveCollected(r.id); await store.moveCollected(r.id)
    const keys = await collectedKeys(r.id)
    ok(keys.length === 1 && keys.every((k) => k.startsWith('collected/')), 'the attachment is not under collected/ after moveCollected')
    ok(typeof (await store.readUrl({ reportId: r.id, file: 'a.png' })).url === 'string', 'a collected attachment is no longer readable')
    ok((await store.finalize({ reportId: r.id, file: 'a.png' })).sha256 === (await hex(PNG)), 'a collected attachment no longer verifies')
  } },
  { name: 'readUrl of a file that is not there fails', async run({ store }) {
    const r = report('amy'); await store.put(r)
    await rejects(store.readUrl({ reportId: r.id, file: 'nope.png' }), 'readUrl of a missing file did not fail')
  } },
]

/** Registers every check with the runner (`test` defaults to the global `test` or `it`, else node:test). */
export async function runStoreConformance(makeStore: MakeStore, opts: { test?: ConformanceTest } = {}): Promise<void> {
  let t: ConformanceTest | undefined = opts.test ?? (globalThis as { test?: ConformanceTest }).test ?? (globalThis as { it?: ConformanceTest }).it
  if (!t) t = ((await import(/* webpackIgnore: true */ 'node:' + 'test')) as { test: ConformanceTest }).test
  for (const c of checks) t(`store conformance: ${c.name}`, async () => c.run(await makeStore()))
}
