// THE OUTBOX: every write the phone makes goes in here FIRST, durably, and is sent to the Mac behind
// the UI. That is what lets a tap update the screen at once and still never lose anything: the write
// is on the phone before the screen moves on, and leaves the phone only when the Mac has said it has
// it. In order, one at a time, so an answer is never filed before the question it follows.
//
// A network failure stops the drain and keeps the rest for the next try (the Mac is away; nothing is
// wrong with the writes). A refusal (a 4xx with a reason) is kept with its reason and skipped, never
// deleted: the operator's words outrank a validation rule, and someone can always look at them.
import type { Store } from './idb.ts'

export interface Op {
  id: string
  /** A name the host app chooses for its own writes. The module adds 'report' and 'reportPart' (see reports.ts). */
  kind: string
  body: Record<string, unknown>
  /** A recorded take in the `blobs` store, deleted with the op once it lands. */
  blob?: string
  /** The id of the write this one belongs to (a part's report or follow-up). While that write is refused, this one is held, not sent. */
  parent?: string
  at: number
  /** The order this phone made it in, among writes with the same `at`. Written by enqueue. */
  seq?: number
  error?: string
}
export type Sent = 'done' | { refused: string }
export interface OutboxState { waiting: number; refused: number; landed?: string }

export function makeOutbox({ store, send, reach }: { store: Store; send(op: Op): Promise<Sent>; reach: { check(force?: boolean): Promise<boolean>; mark(up: boolean): void } }) {
  const listeners = new Set<(s: OutboxState) => void>()
  let running: Promise<void> | null = null
  // A drain asked for while one runs is owed another pass: the running one read the queue before
  // the new write existed. Measured on the phone: without this, a second answer sat on the phone
  // until the 15 s tick.
  let again = false
  // Two writes in one millisecond (a save, then the step that reads it) keep the order they were made
  // in. Ordering them by id instead sent the second first about half the time.
  let made = 0

  async function pending(): Promise<Op[]> {
    return (await store.all<Op>('outbox')).map((r) => r.value).sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0) || a.id.localeCompare(b.id))
  }
  async function tell(landed?: string) {
    const all = await pending()
    const s = { waiting: all.filter((o) => !o.error).length, refused: all.filter((o) => o.error).length, ...(landed ? { landed } : {}) }
    for (const l of listeners) l(s)
  }
  async function run() {
    do {
      again = false
      if (!(await pass())) return
    } while (again)
  }
  /** One pass over the queue. False when the Mac is away, so nothing more is tried now. */
  async function pass(): Promise<boolean> {
    if (!(await reach.check())) return false
    const queue = await pending()
    const refused = new Set(queue.filter((o) => o.error).map((o) => o.id))
    for (const op of queue) {
      if (op.error) continue
      if (op.parent && refused.has(op.parent)) continue
      let r: Sent
      try { r = await send(op) } catch { reach.mark(false); return false }
      if (r === 'done') {
        await store.del('outbox', op.id)
        if (op.blob) await store.del('blobs', op.blob)
        await tell(op.id)
      } else {
        await store.put('outbox', op.id, { ...op, error: r.refused })
        refused.add(op.id)
        await tell()
      }
    }
    return true
  }
  return {
    pending,
    async enqueue(op: Op) { await store.put('outbox', op.id, { ...op, seq: op.seq ?? ++made }); await tell() },
    drain(): Promise<void> {
      if (running) { again = true; return running }
      return (running = run().finally(() => { running = null }))
    },
    subscribe(fn: (s: OutboxState) => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
    refresh: () => tell(),
  }
}
