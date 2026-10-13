// THE LAST ANSWER, KEPT ON THE PHONE. My suggestions and the detail view draw from this at once and then
// refresh from the app, so opening them never waits on the app being reachable. The key names the app and
// the account exactly as a draft's does, so one person's cache is never read for another.
import { draftKey } from './drafts.ts'
import type { Store } from './idb.ts'

const base = (id: { app: string; account: string }) => `${draftKey(id)}#view`
export const mineCacheKey = (id: { app: string; account: string }) => `${base(id)}:mine`
export const oneCacheKey = (id: { app: string; account: string }, reportId: string) => `${base(id)}:one:${reportId}`

export async function readCache<T>(store: Store, key: string): Promise<T | undefined> {
  try { return await store.get<T>('kv', key) } catch { return undefined }
}
export async function writeCache(store: Store, key: string, value: unknown): Promise<void> {
  try { await store.put('kv', key, value) } catch { /* a full or blocked database only costs the next open its head start */ }
}
