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
  it('sending twice makes one report', async () => {
    const { store, fake, outbox, key, report } = await setup()
    await queueReport({ outbox, report, draft: key })
    await queueReport({ outbox, report, draft: key })
    await outbox.drain()
    await queueReport({ outbox, report, draft: key })
    await outbox.drain()
    expect(fake.reports.size).toBe(1)
    expect([...fake.reports.keys()]).toEqual([report.id])
    expect(fake.calls.submit).toBe(2)
    expect(await outbox.pending()).toEqual([])
    expect(await loadDraft(store, key)).toBeUndefined()
  })

  it('a failed upload keeps the draft and retries', async () => {
    const { store, fake, outbox, key, report } = await setup()
    await store.put('blobs', 'img-1', new Blob(['png'], { type: 'image/png' }))
    await queueReport({ outbox, report, draft: key, parts: [{ file: 'a.png', blob: 'img-1' }] })
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
    const { fake, outbox, key, report } = await setup()
    fake.refuse = 'too many reports today'
    await queueReport({ outbox, report, draft: key })
    await outbox.drain()
    const [kept] = await outbox.pending()
    expect(kept.error).toBe('too many reports today')
    expect(kept.body.report).toMatchObject({ words: 'the photos are small' })
    await outbox.drain()
    expect(await outbox.pending()).toHaveLength(1)
    expect(fake.reports.size).toBe(0)
  })

  it('a part whose attachment is gone is refused with a reason, not retried forever', async () => {
    const { outbox, key, report } = await setup()
    await queueReport({ outbox, report, draft: key, parts: [{ file: 'a.png', blob: 'missing' }] })
    await outbox.drain()
    const [kept] = await outbox.pending()
    expect(kept.error).toMatch(/no longer on this device/)
  })

  it('the report goes before its parts, in the order they were attached', async () => {
    const { store, fake, outbox, key, report } = await setup()
    for (const k of ['p1', 'p2', 'p3']) await store.put('blobs', k, new Blob([k]))
    await queueReport({ outbox, report, draft: key, parts: [{ file: 'one', blob: 'p1' }, { file: 'two', blob: 'p2' }, { file: 'three', blob: 'p3' }] })
    await outbox.drain()
    expect(fake.parts.map((p: string) => p.split('/')[1])).toEqual(['one#0', 'two#0', 'three#0'])
  })
})
