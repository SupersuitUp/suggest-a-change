'use client'
// WHAT THE PERSON LAST LOOKED AT. Per app and account, the status each of their reports had the last time they
// opened it. A report whose status has since moved to one they should hear about (`TOLD`: the work starting, and
// every end) is "moved": the entry shows a dot, My suggestions marks the row New, and one toast says it. Opening
// the report marks it seen. The record sits beside the cached views, under the same app-and-account key, so another
// account never reads it and signing out clears it with them (clearViewCache).
import { TOLD, currentStatus } from '../contract.mjs'
import { draftKey } from './drafts.ts'
import type { Store } from './idb.ts'
import { readCache, writeCache } from './view-cache.ts'

type Id = { app: string; account: string }
export type Seen = Record<string, string>
export const seenKey = (id: Id) => `${draftKey(id)}#view:seen`

const listeners = new Set<() => void>()
/** Called whenever something is marked seen, so a dot drawn elsewhere can clear. */
export function onSeen(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn) } }

// One write at a time per key, so two screens recording at once never drop each other's entries.
const chains = new Map<string, Promise<unknown>>()
function serial<T>(key: string, job: () => Promise<T>): Promise<T> {
  const next = (chains.get(key) ?? Promise.resolve()).then(job, job)
  chains.set(key, next.catch(() => {}))
  return next
}

export async function seenStatuses(store: Store, id: Id): Promise<Seen> {
  const v = await readCache<Seen>(store, seenKey(id))
  return v && typeof v === 'object' ? { ...v } : {}
}

/** The person has looked at this report at this status. */
export function markSeen(store: Store, id: Id, reportId: string, status: string): Promise<void> {
  return serial(seenKey(id), async () => {
    const seen = await seenStatuses(store, id)
    const now = currentStatus(status) // kept in the new words, so an old status and the one it means are the same news
    if (seen[reportId] === now) return
    seen[reportId] = now
    await writeCache(store, seenKey(id), seen)
    for (const l of listeners) l()
  })
}

/** The rows that moved to a telling status since the person last looked, in the order given. A report seen for the first
 *  time is recorded silently (so an app taking this release does not announce every old report), and so is a move to a
 *  quiet status (the planning steps); a telling move stays unrecorded until the person opens the report. */
export function moved(store: Store, id: Id, rows: { id: string; status: string }[]): Promise<{ id: string; status: string }[]> {
  return serial(seenKey(id), async () => {
    const seen = await seenStatuses(store, id)
    const out: { id: string; status: string }[] = []
    let changed = false
    for (const r of rows) {
      if (typeof r?.id !== 'string' || typeof r.status !== 'string' || r.status === 'on-phone') continue
      const had = seen[r.id] === undefined ? undefined : currentStatus(seen[r.id])
      const now = currentStatus(r.status)
      if (had === now) continue
      if (had === undefined || !TOLD.includes(now)) { seen[r.id] = now; changed = true; continue }
      out.push({ id: r.id, status: r.status })
    }
    if (changed) await writeCache(store, seenKey(id), seen)
    return out
  })
}

/** One toast per page load, per account, whoever asks: a remounted entry (a menu that remounts it on every open) or a
 *  root-mounted SuggestNews beside it never says it again until the page is loaded again. */
const toasted = new Set<string>()
export function firstToastThisOpen(id: Id): boolean {
  const k = seenKey(id)
  if (toasted.has(k)) return false
  toasted.add(k)
  return true
}

/** WHAT THE LAST PAGE LOAD ALREADY SAW. The moves (report and status) that were already news the last time the app was
 *  loaded, so a move the person was told about, or could have been, is not toasted again on the next load; it keeps
 *  only the dot and the New mark until they open it. Returns the moves in `m` that are new since then, and records `m`
 *  as what this load saw. With no record yet (the first load on this release) every move is fresh, as before. */
export const noticedKey = (id: Id) => `${draftKey(id)}#view:noticed`
export function fresh(store: Store, id: Id, m: { id: string; status: string }[]): Promise<{ id: string; status: string }[]> {
  return serial(noticedKey(id), async () => {
    const had = await readCache<Seen>(store, noticedKey(id))
    const before = had && typeof had === 'object' ? had : {}
    const out = m.filter((r) => before[r.id] !== r.status)
    const now: Seen = { ...before }
    for (const r of m) now[r.id] = r.status
    // A report no longer moved (opened, or gone) drops out, so the record stays the size of the dot.
    for (const k of Object.keys(now)) if (!m.some((r) => r.id === k)) delete now[k]
    await writeCache(store, noticedKey(id), now)
    return out
  })
}
