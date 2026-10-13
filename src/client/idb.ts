// The phone's own database: a few object stores in IndexedDB, behind four promises. `kv` holds the
// cached views and drafts, `outbox` the writes waiting for the Mac, `blobs` the recorded takes. A
// write the UI calls saved is in here first, so a closed app, a dead battery or a lost signal loses
// nothing.
export type StoreName = 'kv' | 'outbox' | 'blobs'
const STORES: StoreName[] = ['kv', 'outbox', 'blobs']

export interface Store {
  get<T = unknown>(store: StoreName, key: string): Promise<T | undefined>
  put(store: StoreName, key: string, value: unknown): Promise<void>
  del(store: StoreName, key: string): Promise<void>
  /** Every record, or only those whose key starts with `prefix` (read without touching the rest). */
  all<T = unknown>(store: StoreName, prefix?: string): Promise<{ key: string; value: T }[]>
}

const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })

export async function openStore(name = 'suggest-a-change'): Promise<Store> {
  const open = indexedDB.open(name, 1)
  open.onupgradeneeded = () => { for (const s of STORES) if (!open.result.objectStoreNames.contains(s)) open.result.createObjectStore(s) }
  const db = await req(open)
  const tx = (s: StoreName, mode: IDBTransactionMode) => db.transaction(s, mode).objectStore(s)
  const done = (t: IDBObjectStore) => new Promise<void>((res, rej) => { t.transaction.oncomplete = () => res(); t.transaction.onerror = () => rej(t.transaction.error); t.transaction.onabort = () => rej(t.transaction.error) })
  return {
    get: (s, k) => req(tx(s, 'readonly').get(k)),
    async put(s, k, v) { const t = tx(s, 'readwrite'); t.put(v, k); await done(t) },
    async del(s, k) { const t = tx(s, 'readwrite'); t.delete(k); await done(t) },
    async all(s, prefix) {
      const t = tx(s, 'readonly')
      const range = prefix ? IDBKeyRange.bound(prefix, `${prefix}￿`) : undefined
      const [keys, values] = await Promise.all([req(t.getAllKeys(range)), req(t.getAll(range))])
      return keys.map((k, i) => ({ key: String(k), value: values[i] }))
    },
  }
}
