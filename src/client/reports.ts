// THE REPORT'S WAY THROUGH THE OUTBOX. A report is one 'report' write plus one 'reportPart' write per
// attachment, all made durable on the phone before anything is sent. The outbox sends them in order, one
// at a time, so the report exists before its parts arrive. The op ids come from the report id, so a
// second send of the same report replaces the first in the queue instead of adding to it, and the
// adapter (which also dedupes by id) lands it once.
//
// The draft stays until the last write of its report has landed. A failed upload therefore keeps the
// words and the attachments, and the next drain retries only what is left.
import { clearDraft, loadDraft } from './drafts.ts'
import type { Store } from './idb.ts'
import { opId } from './op-id.ts'
import type { Op, Sent } from './outbox.ts'

export interface Report { id: string; [field: string]: unknown }
export interface Summary { id: string; status: string; kind?: string; at?: number; [field: string]: unknown }

/** The things an app supplies for the receiving side. Adapters for particular apps come later.
 *  REQUIREMENT: `submit` and `uploadPart` must dedupe by report id (and file and part). The outbox sends a
 *  write at least once: a reply lost after the receiver stored it, a replay after landing, or two tabs
 *  draining the same queue all send the same write again, and only the receiver can make that one report. */
export interface StoreAdapter {
  submit(report: Report): Promise<'done' | { refused: string }>
  uploadPart(reportId: string, file: string, part: number, bytes: Blob): Promise<'done' | { refused: string }>
  mine(): Promise<Summary[]>
  one(id: string): Promise<Report>
  append(id: string, more: Record<string, unknown>): Promise<'done' | { refused: string }>
}

export interface PartRef { file: string; part?: number; blob: string }

/** Puts a report, and each attachment already held in `blobs`, in the outbox. Nothing is sent here.
 *  Queuing marks the draft as queued, so the next save starts a fresh draft.
 *  Queuing the same report again replaces its waiting writes (still one report). It also replaces a
 *  refused write with a clean one, on purpose: the drain skips a refused write forever, so keeping its
 *  reason on the new write would make the retry impossible; the old reason shows until the retry. */
export async function queueReport(
  { store, outbox, report, parts = [], draft, now = () => Date.now() }: {
    store: Store
    outbox: { enqueue(op: Op): Promise<void> }
    report: Report
    parts?: PartRef[]
    /** The draft key; the draft is cleared once every write of this report has landed. */
    draft?: string
    now?: () => number
  },
): Promise<void> {
  const at = now()
  await outbox.enqueue({ id: opId('report', report.id), kind: 'report', body: { report, draft }, at })
  // Marked only AFTER the report is safely in the outbox: if the enqueue throws, the draft is still the
  // person's live draft. A save between the two writes joins this report, and the clear is guarded by the
  // report id, so those words are never wiped.
  if (draft) {
    const d = await loadDraft(store, draft)
    if (d && d.reportId === report.id && !d.queued) await store.put('kv', draft, { ...d, queued: true })
  }
  let n = 0
  for (const p of parts) {
    n++
    // One tick apart, so the order the person attached them in is the order they are sent.
    await outbox.enqueue({
      id: opId('part', report.id, p.file, String(p.part ?? 0)),
      kind: 'reportPart',
      body: { reportId: report.id, file: p.file, part: p.part ?? 0, draft },
      blob: p.blob,
      at: at + n,
    })
  }
}

/** The outbox's `send` for a host whose only writes are reports. A host with other writes wraps this. */
export function makeReportSender({ store, adapter }: { store: Store; adapter: StoreAdapter }) {
  return async function send(op: Op): Promise<Sent> {
    let r: 'done' | { refused: string }
    let reportId: string
    if (op.kind === 'report') {
      const report = op.body.report as Report
      reportId = report.id
      r = await adapter.submit(report)
    } else if (op.kind === 'reportPart') {
      reportId = String(op.body.reportId)
      const bytes = op.blob ? await store.get<Blob>('blobs', op.blob) : undefined
      if (!bytes) return { refused: 'the attachment is no longer on this device' }
      r = await adapter.uploadPart(reportId, String(op.body.file), Number(op.body.part ?? 0), bytes)
    } else {
      return { refused: `not a report write: ${op.kind}` }
    }
    if (r === 'done' && typeof op.body.draft === 'string') {
      // The outbox deletes this op only after we return, so look at the others.
      const others = (await store.all<Op>('outbox')).map((o) => o.value)
        .filter((o) => o.id !== op.id && !o.error && (o.body.reportId === reportId || (o.body.report as Report | undefined)?.id === reportId))
      if (!others.length) await clearDraft(store, op.body.draft, reportId)
    }
    return r
  }
}
