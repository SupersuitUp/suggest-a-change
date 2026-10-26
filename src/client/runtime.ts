'use client'
// THE PHONE SIDE OF THE SCREENS: the local database, the outbox wired to the app's StoreAdapter, and what
// each attachment is doing. One runtime per app AND account: it is cached by that pair (never by the
// adapters object, which an app may rebuild on every render), and it reads the newest adapters each time
// it sends. Its outbox sees only the writes made under its own account, so a report queued by one person
// is sent only while that person is signed in. "Received" is derived from the outbox: a report has landed
// when none of its writes is left there, because a write leaves only after the adapter said `done`.
import { useEffect, useRef, useState } from 'react'
import type { Adapters, Identity } from './adapters.ts'
import { installContextListeners } from './context.ts'
import { draftKey } from './drafts.ts'
import { openStore, type Store } from './idb.ts'
import { makeOutbox, type Op, type Sent } from './outbox.ts'
import { makeReportSender, type Report } from './reports.ts'

export type PartState = { state: 'waiting' | 'sending' | 'sent' | 'failed'; reason?: string }
export type Outbox = ReturnType<typeof makeOutbox>
export interface Waiting { id: string; at: number; error?: string; words?: string; /** Nothing of the report itself is waiting, only a follow-up to it. */ onlyFollowUp?: boolean }
export interface FollowUp { followId: string; words: string; error?: string }

export interface Runtime {
  /** The phone's database, for blobs and drafts. */
  store: Store
  outbox: Outbox
  who: Identity
  /** The adapters of the latest render. */
  adapters: Adapters
  part(reportId: string, file: string): PartState
  onProgress(fn: () => void): () => void
  drain(): Promise<void>
  /** Clears the refusal on every waiting write of a report and sends again. */
  retry(reportId: string): Promise<void>
  /** Reports of this account that are on this phone and not yet fully landed. */
  waiting(): Promise<Waiting[]>
  /** Follow-ups to a report that have not landed yet. */
  followUps(reportId: string): Promise<FollowUp[]>
  /** Drops a follow-up the person has chosen not to keep: its write, its voice parts and their local copies. */
  discardFollowUp(reportId: string, followId: string): Promise<void>
  /** The copy of a report that is still on this phone, with the app's refusal if there is one. */
  local(reportId: string): Promise<{ report: Report; error?: string } | undefined>
  /** Keeps the outbox moving (on reconnect and every 15 s) while something is mounted. */
  retain(): () => void
}

const cache = new Map<string, Promise<Runtime>>()
export const belongsTo = (o: Op, id: string) => o.body.reportId === id || (o.body.report as Report | undefined)?.id === id

export function getRuntime(adapters: Adapters, who: Identity): Promise<Runtime> {
  const k = `${adapters.words.app}\u0000${who.account}`
  let p = cache.get(k)
  if (!p) { p = build(adapters, who); cache.set(k, p) }
  return p
}

/** The outbox as this account sees it: only writes made under its own draft key. */
function scoped(store: Store, draft: string): Store {
  return {
    ...store,
    async all<T = unknown>(s: Parameters<Store['all']>[0], prefix?: string) {
      const rows = await store.all<T>(s, prefix)
      return s === 'outbox' ? rows.filter((r) => (r.value as Op).body?.draft === draft) : rows
    },
  }
}

async function build(first: Adapters, who: Identity): Promise<Runtime> {
  const store = first.phone?.store ?? await openStore(`suggest-a-change:${first.words.app}`)
  const view = scoped(store, draftKey({ app: first.words.app, account: who.account }))
  const parts = new Map<string, PartState>()
  const listeners = new Set<() => void>()
  const note = () => { for (const l of listeners) l() }
  const rt = { adapters: first } as Runtime
  // The adapter is read at send time, so a rebuilt `adapters` object is used from the next write on.
  const base = makeReportSender({ store: view, adapter: {
    submit: (r) => rt.adapters.store.submit(r),
    uploadPart: (id, f, p, b) => rt.adapters.store.uploadPart(id, f, p, b),
    mine: () => rt.adapters.store.mine(),
    one: (id) => rt.adapters.store.one(id),
    append: (id, m) => rt.adapters.store.append(id, m),
  } })
  const reach = first.phone?.reach ?? { check: async () => typeof navigator === 'undefined' || navigator.onLine !== false, mark() {} }

  async function send(op: Op): Promise<Sent> {
    // Confirm the account before every write: a report queued by one person is never sent under another's session.
    let now: Identity | null = null
    try { now = await rt.adapters.identity() } catch { now = null }
    if (!now || now.account !== who.account) throw new Error('the signed-in account is not the one that queued this')
    if (op.kind === 'followUp') {
      const b = op.body
      return rt.adapters.store.append(String(b.reportId), { words: b.words, at: b.at, voice: b.voice, followId: b.followId })
    }
    const k = op.kind === 'reportPart' ? `${op.body.reportId}\u0000${op.body.file}` : undefined
    if (k) { parts.set(k, { state: 'sending' }); note() }
    let r: Sent
    try { r = await base(op) } catch (e) { if (k) { parts.set(k, { state: 'waiting' }); note() } throw e }
    if (k) parts.set(k, r === 'done' ? { state: 'sent' } : { state: 'failed', reason: r.refused })
    note()
    return r
  }
  const outbox = makeOutbox({ store: view, send, reach })
  let users = 0
  let stop = () => {}
  Object.assign(rt, {
    store, outbox, who,
    part: (id: string, file: string) => parts.get(`${id}\u0000${file}`) ?? { state: 'waiting' },
    onProgress(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
    drain: () => outbox.drain(),
    async retry(id: string) {
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
      const seen = new Map<string, Waiting>()
      for (const o of await outbox.pending()) {
        const rep = o.kind === 'report' ? (o.body.report as Report) : undefined
        const id = rep ? rep.id : o.kind === 'reportPart' || o.kind === 'followUp' ? String(o.body.reportId) : undefined
        if (!id) continue
        const follow = o.kind === 'followUp' || o.body.followId !== undefined
        const had = seen.get(id)
        seen.set(id, { id, at: had ? Math.min(had.at, o.at) : o.at, error: had?.error ?? o.error, words: had?.words ?? (rep && typeof rep.words === 'string' ? rep.words : undefined), onlyFollowUp: (had ? had.onlyFollowUp : true) && follow })
      }
      return [...seen.values()]
    },
    async followUps(id: string) {
      const by = new Map<string, FollowUp>()
      for (const o of (await outbox.pending()).filter((x) => belongsTo(x, id) && x.body.followId !== undefined)) {
        const f = String(o.body.followId)
        const had = by.get(f)
        by.set(f, { followId: f, words: had?.words || (o.kind === 'followUp' ? String(o.body.words ?? '') : ''), ...(had?.error || o.error ? { error: had?.error ?? o.error } : {}) })
      }
      return [...by.values()]
    },
    async discardFollowUp(id: string, followId: string) {
      for (const o of await outbox.pending()) {
        if (belongsTo(o, id) && o.body.followId === followId) {
          await store.del('outbox', o.id)
          if (o.blob) await store.del('blobs', o.blob)
        }
      }
      await outbox.refresh()
    },
    async local(id: string) {
      const mine = (await outbox.pending()).filter((o) => belongsTo(o, id) && o.body.followId === undefined)
      const rep = mine.find((o) => o.kind === 'report')
      if (!rep) return undefined
      return { report: rep.body.report as Report, error: mine.find((o) => o.error)?.error }
    },
    retain() {
      if (users++ === 0) {
        const again = () => { void outbox.drain() }
        addEventListener('online', again)
        const t = setInterval(again, 15_000)
        void outbox.drain()
        stop = () => { removeEventListener('online', again); clearInterval(t) }
      }
      return () => { if (--users === 0) stop() }
    },
  })
  return rt
}

const identityListeners = new Set<() => void>()
/** Tell every mounted screen to ask `identity()` again: call it after a sign-in, sign-out or account switch.
 *  (Changing the `adapters` object a screen is given does the same.) */
export function refreshIdentity(): void { for (const l of identityListeners) l() }

/** Who is signed in (undefined while asking, null when no one is) and, once known, their runtime. The
 *  question is asked again whenever the adapters change and whenever `refreshIdentity()` is called; when the
 *  account differs, the old account's runtime is let go and nothing of it stays on screen. Adapters should be
 *  stable, but a parent that rebuilds them every render is safe: the runtime is shared and always sends
 *  through the newest adapters. */
export function useRuntime(adapters: Adapters): { rt: Runtime | null; who: Identity | null | undefined } {
  const [state, setState] = useState<{ rt: Runtime | null; who: Identity | null | undefined }>({ rt: null, who: undefined })
  const [signal, setSignal] = useState(0)
  const current = useRef<{ account: string | null; release: () => void }>({ account: null, release: () => {} })
  const alive = useRef(true)
  // Every screen of the module mounts this, so the trail (pages, taps, errors) starts with the first one; it installs once.
  useEffect(() => { installContextListeners() }, [])
  useEffect(() => { alive.current = true; return () => { alive.current = false; current.current.release(); current.current = { account: null, release: () => {} } } }, [])
  useEffect(() => { const l = () => setSignal((n) => n + 1); identityListeners.add(l); return () => { identityListeners.delete(l) } }, [])
  useEffect(() => { if (state.rt) state.rt.adapters = adapters })
  useEffect(() => {
    let live = true
    void (async () => {
      let who: Identity | null = null
      try { who = await adapters.identity() } catch { who = null }
      if (!live || !alive.current) return
      const had = current.current
      if ((who?.account ?? null) === had.account && had.account !== null) {
        if (state.rt) state.rt.adapters = adapters
        return
      }
      had.release()
      current.current = { account: null, release: () => {} }
      if (!who) { setState((prev) => (prev.who === null ? prev : { rt: null, who: null })); return }
      const rt = await getRuntime(adapters, who)
      if (!live || !alive.current) return
      rt.adapters = adapters
      current.current = { account: who.account, release: rt.retain() }
      setState({ rt, who })
    })()
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapters, signal])
  return state
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
