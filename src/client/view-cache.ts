// THE LAST ANSWER, KEPT ON THE PHONE. My suggestions and the detail view draw from this at once and then
// refresh from the app, so opening them never waits on the app being reachable. The key names the app and
// the account exactly as a draft's does, so one person's cache is never read for another.
import { useEffect, useRef } from 'react'
import { draftKey } from './drafts.ts'
import type { Store } from './idb.ts'

type Id = { app: string; account: string }
const base = (id: Id) => `${draftKey(id)}#view`
export const mineCacheKey = (id: Id) => `${base(id)}:mine`
export const oneCacheKey = (id: Id, reportId: string) => `${base(id)}:one:${reportId}`

export async function readCache<T>(store: Store, key: string): Promise<T | undefined> {
  try { return await store.get<T>('kv', key) } catch { return undefined }
}
export async function writeCache(store: Store, key: string, value: unknown): Promise<void> {
  try { await store.put('kv', key, value) } catch { /* a full or blocked database only costs the next open its head start */ }
}
export async function dropCache(store: Store, key: string): Promise<void> {
  try { await store.del('kv', key) } catch { /* nothing to drop */ }
}

/** After a successful list: cached reports the app no longer lists (deleted, or no longer this person's) are dropped. */
export async function pruneOnes(store: Store, id: Id, keep: string[]): Promise<void> {
  try {
    const prefix = `${base(id)}:one:`
    const live = new Set(keep)
    for (const row of await store.all('kv', prefix)) if (!live.has(row.key.slice(prefix.length))) await store.del('kv', row.key)
  } catch { /* the next list prunes again */ }
}

/** Everything cached for one account: the list and every report. */
export async function clearViewCache(store: Store, id: Id): Promise<void> {
  try { for (const row of await store.all('kv', base(id))) await store.del('kv', row.key) } catch { /* best effort */ }
}

/** True when the app REFUSED (the report is gone, or this person may not see it), as against being unreachable.
 *  The adapter contract: `mine()` and `one()` throw an error carrying `refused: true`, or a `status` of 401, 403 or 404;
 *  `one()` may instead answer an object with a string `refused`. Anything else thrown is a failure to reach the app. */
export function isRefusal(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const x = e as { refused?: unknown; status?: unknown }
  return x.refused === true || (typeof x.refused === 'string' && x.refused !== '') || x.status === 401 || x.status === 403 || x.status === 404
}

/** When the person signs out (identity becomes null), the account that was signed in loses its cached views on this phone. */
export function useClearOnSignOut(rt: { store: Store; who: { account: string } } | null, who: unknown, app: string): void {
  const last = useRef<{ store: Store; id: Id } | null>(null)
  useEffect(() => {
    if (rt) { last.current = { store: rt.store, id: { app, account: rt.who.account } }; return }
    if (who === null && last.current) { const l = last.current; last.current = null; void clearViewCache(l.store, l.id) }
  }, [rt, who, app])
}
