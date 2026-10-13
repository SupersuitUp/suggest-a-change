// THE PHONE SIDE OF THE SCREENS: the local database, the outbox wired to the app's StoreAdapter, what
// each attachment is doing, and which reports the adapter has said `done` to. The receipt reads
// `acked`, so it cannot say "received" for anything the adapter has not answered.
import { useEffect, useState } from 'react'
import type { Adapters } from './adapters.ts'
import { openStore, type Store } from './idb.ts'
import { makeOutbox, type Op, type Sent } from './outbox.ts'
import { makeReportSender, type Report } from './reports.ts'

export type PartState = { state: 'waiting' | 'sending' | 'sent' | 'failed'; reason?: string }
export type Outbox = ReturnType<typeof makeOutbox>

export interface Runtime {
  store: Store
  outbox: Outbox
  /** True once the adapter answered `done` to the report itself. */
  acked(reportId: string): boolean
  part(reportId: string, file: string): PartState
  onProgress(fn: () => void): () => void
  drain(): Promise<void>
  /** Clears the refusal on every waiting write of a report and sends again. */
  retry(reportId: string): Promise<void>
  /** Reports that are on this phone and not yet fully landed. */
  waiting(): Promise<{ id: string; at: number; error?: string }[]>
}

const cache = new WeakMap<Adapters, Promise<Runtime>>()
export const belongsTo = (o: Op, id: string) => o.body.reportId === id || (o.body.report as Report | undefined)?.id === id

export function getRuntime(adapters: Adapters): Promise<Runtime> {
  let p = cache.get(adapters)
  if (!p) { p = build(adapters); cache.set(adapters, p) }
  return p
}

async function build(adapters: Adapters): Promise<Runtime> {
  const store = adapters.phone?.store ?? await openStore(`suggest-a-change:${adapters.words.app}`)
  const acked = new Set<string>()
  const parts = new Map<string, PartState>()
  const listeners = new Set<() => void>()
  const note = () => { for (const l of listeners) l() }
  const base = makeReportSender({ store, adapter: adapters.store })
  const reach = adapters.phone?.reach ?? { check: async () => typeof navigator === 'undefined' || navigator.onLine !== false, mark() {} }

  async function send(op: Op): Promise<Sent> {
    const k = op.kind === 'reportPart' ? `${op.body.reportId}\u0000${op.body.file}` : undefined
    if (k) { parts.set(k, { state: 'sending' }); note() }
    let r: Sent
    try { r = await base(op) } catch (e) { if (k) { parts.set(k, { state: 'waiting' }); note() } throw e }
    if (r === 'done') {
      if (op.kind === 'report') acked.add((op.body.report as Report).id)
      if (k) parts.set(k, { state: 'sent' })
    } else if (k) parts.set(k, { state: 'failed', reason: r.refused })
    note()
    return r
  }
  const outbox = makeOutbox({ store, send, reach })
  const rt: Runtime = {
    store, outbox,
    acked: (id) => acked.has(id),
    part: (id, file) => parts.get(`${id}\u0000${file}`) ?? { state: 'waiting' },
    onProgress(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
    drain: () => outbox.drain(),
    async retry(id) {
      for (const o of await outbox.pending()) {
        if (belongsTo(o, id) && o.error) {
          const { error: _gone, ...clean } = o
          await outbox.enqueue(clean)
        }
      }
      note()
      await outbox.drain()
    },
    async waiting() {
      const seen = new Map<string, { id: string; at: number; error?: string }>()
      for (const o of await outbox.pending()) {
        const id = o.kind === 'report' ? (o.body.report as Report).id : o.kind === 'reportPart' ? String(o.body.reportId) : undefined
        if (!id) continue
        const had = seen.get(id)
        seen.set(id, { id, at: had ? Math.min(had.at, o.at) : o.at, error: had?.error ?? o.error })
      }
      return [...seen.values()]
    },
  }
  return rt
}

/** The runtime for these adapters once the phone's database is open, and the outbox kept moving while mounted. */
export function useRuntime(adapters: Adapters): Runtime | null {
  const [rt, setRt] = useState<Runtime | null>(null)
  useEffect(() => {
    let live = true
    let cleanup = () => {}
    getRuntime(adapters).then((r) => {
      if (!live) return
      setRt(r)
      const again = () => { void r.drain() }
      addEventListener('online', again)
      const t = setInterval(again, 15_000)
      void r.drain()
      cleanup = () => { removeEventListener('online', again); clearInterval(t) }
    }, () => {})
    return () => { live = false; cleanup() }
  }, [adapters])
  return rt
}

/** Re-renders when the outbox or an attachment's state changes. */
export function useTick(rt: Runtime | null): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!rt) return
    const bump = () => setN((x) => x + 1)
    const a = rt.outbox.subscribe(bump)
    const b = rt.onProgress(bump)
    return () => { a(); b() }
  }, [rt])
  return n
}
