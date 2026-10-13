// @vitest-environment jsdom
// A report's way through the outbox, against an in-memory fake of the receiving side.
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { draftKey, loadDraft, saveDraft } from '../../src/client/drafts.ts'
import { openStore } from '../../src/client/idb.ts'
import { makeOutbox } from '../../src/client/outbox.ts'
import { makeReportSender, queueReport, type Report, type StoreAdapter } from '../../src/client/reports.ts'

let n = 0
const fresh = () => openStore(`r-${++n}`)

/** A fake receiving side: dedupes by report id, like a real one, and can be made to fail or refuse. */
interface Fake { reports: Map<string, Report>; parts: string[]; calls: { submit: number; upload: number }; failUploads: boolean; refuse: string | null; adapter: StoreAdapter }
function fakeAdapter(): Fake {
  const reports = new Map<string, Report>()
  const parts: string[] = []
  const calls = { submit: 0, upload: 0 }
  const f: Fake = {
    reports, parts, calls,
    failUploads: false,
    refuse: null as string | null,
    adapter: {
      async submit(r: Report) { calls.submit++; if (f.refuse) return { refused: f.refuse }; reports.set(r.id, r); return 'done' as const },
      async uploadPart(id: string, file: string, part: number) { calls.upload++; if (f.failUploads) throw new TypeError('Load failed'); parts.push(`${id}/${file}#${part}`); return 'done' as const },
      async mine() { return [...reports.keys()].map((id) => ({ id, status: 'received' })) },
      async one(id: string) { return reports.get(id)! },
      async append() { return 'done' as const },
    },
  }
  return f
}

async function setup() {
  const store = await fresh()
  const fake = fakeAdapter()
  const outbox = makeOutbox({ store, reach: { check: async () => true, mark() {} }, send: makeReportSender({ store, adapter: fake.adapter }) })
  const key = draftKey({ app: 'us', account: 'alex' })
  const draft = await saveDraft(store, key, { words: 'the photos are small', attachments: ['img-1'] })
  const report: Report = { id: draft.reportId, kind: 'change', words: draft.words }
  return { store, fake, outbox, key, report }
}

describe('reports', () => {
  it('sending twice makes one report: two queues before a drain are one submit that lands', async () => {
    const { store, fake, outbox, key, report } = await setup()
    await queueReport({ store, outbox, report, draft: key })
    await queueReport({ store, outbox, report, draft: key })
    expect(await outbox.pending()).toHaveLength(1)
    await outbox.drain()
    expect(fake.calls.submit).toBe(1)
    expect([...fake.reports.keys()]).toEqual([report.id])
    expect(await outbox.pending()).toEqual([])
    expect(await loadDraft(store, key)).toBeUndefined()
  })

  it('a replay after landing reaches the adapter again, so the store adapter must dedupe by id', async () => {
    const { store, fake, outbox, key, report } = await setup()
    await queueReport({ store, outbox, report, draft: key })
    await outbox.drain()
    await queueReport({ store, outbox, report, draft: key })
    await outbox.drain()
    expect(fake.calls.submit).toBe(2)
    expect(fake.reports.size).toBe(1)
  })

  it('words typed while a report is still sending start a new draft and survive when the report lands', async () => {
    const { store, fake, outbox, key, report } = await setup()
    await queueReport({ store, outbox, report, draft: key })
    const next = await saveDraft(store, key, { words: 'a second thought' })
    expect(next.reportId).not.toBe(report.id)
    expect(next.words).toBe('a second thought')
    expect(next.attachments).toEqual([])
    await outbox.drain()
    expect([...fake.reports.keys()]).toEqual([report.id])
    expect(fake.reports.get(report.id)?.words).toBe('the photos are small')
    const kept = await loadDraft(store, key)
    expect(kept).toMatchObject({ reportId: next.reportId, words: 'a second thought' })
  })

  it('one refused part and the rest landed: the refusal stays, the draft is cleared, a re-queue retries it', async () => {
    const { store, fake, outbox, key, report } = await setup()
    await store.put('blobs', 'good', new Blob(['g']))
    await store.put('blobs', 'bad', new Blob(['b']))
    const refuseBad = { ...fake.adapter, async uploadPart(id: string, file: string, part: number, bytes: Blob) { return file === 'bad.png' ? { refused: 'that image type is not accepted' } : fake.adapter.uploadPart(id, file, part, bytes) } }
    const ob = makeOutbox({ store, reach: { check: async () => true, mark() {} }, send: makeReportSender({ store, adapter: refuseBad }) })
    await queueReport({ store, outbox: ob, report, draft: key, parts: [{ file: 'bad.png', blob: 'bad' }, { file: 'good.png', blob: 'good' }] })
    await ob.drain()
    const left = await ob.pending()
    expect(left.map((o) => o.error)).toEqual(['that image type is not accepted'])
    expect(fake.parts).toEqual([`${report.id}/good.png#0`])
    expect(await loadDraft(store, key)).toBeUndefined()
    // The person tries again: the refused write is replaced by a clean one and is sent.
    refuseBad.uploadPart = fake.adapter.uploadPart
    await queueReport({ store, outbox: ob, report, draft: key, parts: [{ file: 'bad.png', blob: 'bad' }] })
    await ob.drain()
    expect(await ob.pending()).toEqual([])
    expect(fake.parts).toContain(`${report.id}/bad.png#0`)
  })

  it('if the outbox write throws, the draft is not marked queued and the next save keeps the same draft and id', async () => {
    const { store, outbox, key, report } = await setup()
    const broken = { async enqueue() { throw new Error('storage full') } }
    await expect(queueReport({ store, outbox: broken, report, draft: key })).rejects.toThrow('storage full')
    expect((await loadDraft(store, key))?.queued).toBeUndefined()
    const again = await saveDraft(store, key, { words: 'still typing' })
    expect(again.reportId).toBe(report.id)
    expect(again.words).toBe('still typing')
    await queueReport({ store, outbox, report, draft: key })
    expect(await outbox.pending()).toHaveLength(1)
  })

  it('a failed upload keeps the draft and retries', async () => {
    const { store, fake, outbox, key, report } = await setup()
    await store.put('blobs', 'img-1', new Blob(['png'], { type: 'image/png' }))
    await queueReport({ store, outbox, report, draft: key, parts: [{ file: 'a.png', blob: 'img-1' }] })
    fake.failUploads = true
    await outbox.drain()
    // The report landed; the picture did not; the person's words and picture are still on the phone.
    expect(fake.reports.size).toBe(1)
    expect((await loadDraft(store, key))?.words).toBe('the photos are small')
    expect((await outbox.pending()).map((o) => o.kind)).toEqual(['reportPart'])
    expect(await store.get('blobs', 'img-1')).toBeDefined()
    fake.failUploads = false
    await outbox.drain()
    expect(fake.parts).toEqual([`${report.id}/a.png#0`])
    expect(await loadDraft(store, key)).toBeUndefined()
    expect(await store.get('blobs', 'img-1')).toBeUndefined()
    expect(fake.calls.submit).toBe(1)
  })

  it('a refusal is kept with its reason and never deleted', async () => {
    const { store, fake, outbox, key, report } = await setup()
    fake.refuse = 'too many reports today'
    await queueReport({ store, outbox, report, draft: key })
    await outbox.drain()
    const [kept] = await outbox.pending()
    expect(kept.error).toBe('too many reports today')
    expect(kept.body.report).toMatchObject({ words: 'the photos are small' })
    await outbox.drain()
    expect(await outbox.pending()).toHaveLength(1)
    expect(fake.reports.size).toBe(0)
  })

  it('a part whose attachment is gone is refused with a reason, not retried forever', async () => {
    const { store, outbox, key, report } = await setup()
    await queueReport({ store, outbox, report, draft: key, parts: [{ file: 'a.png', blob: 'missing' }] })
    await outbox.drain()
    const [kept] = await outbox.pending()
    expect(kept.error).toMatch(/no longer on this device/)
  })

  it('the report goes before its parts, in the order they were attached', async () => {
    const { store, fake, outbox, key, report } = await setup()
    for (const k of ['p1', 'p2', 'p3']) await store.put('blobs', k, new Blob([k]))
    await queueReport({ store, outbox, report, draft: key, parts: [{ file: 'one', blob: 'p1' }, { file: 'two', blob: 'p2' }, { file: 'three', blob: 'p3' }] })
    await outbox.drain()
    expect(fake.parts.map((p: string) => p.split('/')[1])).toEqual(['one#0', 'two#0', 'three#0'])
  })
})
