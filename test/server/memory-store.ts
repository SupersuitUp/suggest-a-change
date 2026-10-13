// The in-memory HostedStore this repo's tests run against. It must itself pass runStoreConformance.
// `flaw` builds a deliberately UNSAFE variant, one per rule the suite exists to enforce; the suite must fail each.
import { sniffType, type FileState, type HostedStore, type StoreHarness, type StoredReport } from '../../src/server/index.ts'

export type Flaw = 'reusable-links' | 'unconditioned-links' | 'drops-files' | 'drops-followups' | 'counts-every-put' | 'stale-write' | 'stale-claim' | 'non-atomic-create' | 'long-read-link' | 'discard-leaves-object' | 'finalize-throws-when-missing'

const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))].map((x) => x.toString(16).padStart(2, '0')).join('')
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

export function makeMemoryStore(start = Date.parse('2026-10-12T09:00:00Z'), flaw?: Flaw) {
  let clock = start
  let puts = 0
  const reports = new Map<string, StoredReport>()
  const objects = new Map<string, Uint8Array>()
  const claims = new Map<string, { until: number; settled: boolean }>()
  const approvals = new Map<string, { by: string; until: number }>()
  const upLinks = new Map<string, { reportId: string; file: string; key: string; type: string; bytes: number; used: boolean }>()
  const readLinks = new Map<string, { reportId: string; file: string; expiresAt: number }>()
  const linkLog: { reportId: string; file: string; type: string; bytes: number }[] = []
  const calls = { uploadUrl: 0, finalize: 0, discard: 0, moveCollected: 0 }
  const key = (id: string, file: string) => `reports/${id}/${file}`
  const find = (id: string, file: string) => (objects.has(`collected/${key(id, file)}`) ? `collected/${key(id, file)}` : objects.has(key(id, file)) ? key(id, file) : null)
  const copy = <T,>(x: T): T => structuredClone(x)
  const out = (r: StoredReport): StoredReport => {
    const c = copy(r)
    if (flaw === 'drops-files') delete c.files
    if (flaw === 'drops-followups') delete c.followUps
    return c
  }
  // A read-modify-write that yields in the middle: what a careless adapter does, and what loses concurrent writes.
  const rmw = async (id: string, change: (r: StoredReport) => void) => {
    const r = reports.get(id); if (!r) return
    if (flaw === 'stale-write') { const stale = copy(r); await tick(); change(stale); reports.set(id, stale) } else change(r)
  }

  const store: HostedStore = {
    async put(r, opts) {
      puts++
      if (flaw === 'non-atomic-create') { const had = reports.has(r.id); await tick(); if (had) return 'exists'; reports.set(r.id, copy(r)); return 'created' }
      if (reports.has(r.id)) return 'exists'
      if (opts?.dailyLimit !== undefined) {
        const n = [...reports.values()].filter((x) => x.who.member === r.who.member && day(Date.parse(x.receivedAt)) === day(clock)).length
        if (n >= opts.dailyLimit) return 'limit'
      }
      reports.set(r.id, copy(r)); return 'created'
    },
    async get(id) { const r = reports.get(id); return r ? out(r) : null },
    async listFor(member) { return [...reports.values()].filter((r) => r.who.member === member).map(out) },
    async listOpenFor(by, { limit, since }) {
      return [...reports.values()]
        .filter((r) => (since === undefined || Date.parse(r.receivedAt) >= since) && (() => { const c = claims.get(`${r.id}|${by}`); return !c || (!c.settled && c.until <= clock) })())
        .sort((a, b) => (a.receivedAt === b.receivedAt ? (a.id < b.id ? -1 : 1) : a.receivedAt < b.receivedAt ? -1 : 1))
        .slice(0, limit).map(out)
    },
    async uploadUrl(a) {
      calls.uploadUrl++; linkLog.push(a)
      const token = `${upLinks.size + 1}-${Math.random().toString(36).slice(2, 8)}`
      upLinks.set(token, { ...a, key: key(a.reportId, a.file), used: false })
      return { url: `memory://upload/${token}`, headers: { 'content-type': a.type, 'x-goog-content-length-range': `0,${a.bytes}`, 'x-goog-if-generation-match': '0' } }
    },
    async finalize(a) {
      calls.finalize++
      const k = find(a.reportId, a.file)
      if (!k) { if (flaw === 'finalize-throws-when-missing') throw new Error('nothing uploaded'); return null }
      const b = objects.get(k)!
      return { type: sniffType(b.subarray(0, 64)), bytes: b.length, sha256: await hex(b) }
    },
    async discard(a) { calls.discard++; if (flaw !== 'discard-leaves-object') { objects.delete(key(a.reportId, a.file)); objects.delete(`collected/${key(a.reportId, a.file)}`) } },
    async setFile(id, file, state: FileState | null) { await rmw(id, (r) => { r.files = { ...(r.files ?? {}) }; if (state) r.files[file] = copy(state); else delete r.files[file] }) },
    async addFollowUp(id, f) {
      const r = reports.get(id); if (!r) return 'missing'
      if ((r.followUps ?? []).some((x) => x.followId === f.followId)) return 'exists'
      await rmw(id, (x) => { x.followUps = [...(x.followUps ?? []), copy(f)] })
      return 'added'
    },
    async claim(id, by, leaseMs) { const c = claims.get(`${id}|${by}`); claims.set(`${id}|${by}`, { until: clock + leaseMs, settled: c?.settled ?? false }) },
    async settle(id, by) { const c = claims.get(`${id}|${by}`); if (!c) return false; c.settled = true; return true },
    async reopen(id) {
      let any = false
      for (const [k, c] of [...claims]) if (k.startsWith(`${id}|`) && c.settled) { claims.delete(k); any = true }
      return any
    },
    async setStatus(id, entry, expectFrom) {
      const r = reports.get(id); if (!r) return false
      if (expectFrom !== undefined && r.timeline[r.timeline.length - 1]?.status !== expectFrom) return false
      await rmw(id, (x) => { x.timeline = [...x.timeline, copy(entry)] })
      return true
    },
    async claimApproval(id, by, leaseMs) {
      if (flaw === 'stale-claim') { const h = approvals.get(id); await tick(); if (!h) approvals.set(id, { by, until: clock + leaseMs }); return h && h.by !== by ? { claimedBy: h.by } : { ok: true } }
      const h = approvals.get(id)
      if (!h || h.until <= clock || h.by === by) { approvals.set(id, { by, until: clock + leaseMs }); return { ok: true } }
      return { claimedBy: h.by }
    },
    async releaseApproval(id, by) { const h = approvals.get(id); if (!h || h.by !== by || h.until <= clock) return false; approvals.delete(id); return true },
    async moveCollected(id) {
      calls.moveCollected++
      for (const k of [...objects.keys()]) if (k.startsWith(`reports/${id}/`)) { objects.set(`collected/${k}`, objects.get(k)!); objects.delete(k) }
    },
    async countToday(member) {
      if (flaw === 'counts-every-put') return puts
      return [...reports.values()].filter((r) => r.who.member === member && day(Date.parse(r.receivedAt)) === day(clock)).length
    },
    async readUrl(a) {
      if (!find(a.reportId, a.file)) throw new Error('no such file')
      const token = `r${readLinks.size + 1}-${Math.random().toString(36).slice(2, 8)}`
      const expiresAt = clock + (flaw === 'long-read-link' ? 10 * 365 * 24 * 3600_000 : a.ttlMs)
      readLinks.set(token, { reportId: a.reportId, file: a.file, expiresAt })
      return { url: `memory://read/${token}`, expiresAt }
    },
  }
  const harness: StoreHarness = {
    store,
    now: () => clock,
    advance: (ms) => { clock += ms },
    // What a storage service does with a PUT on an upload link: it checks the link's conditions and refuses if they fail.
    putViaLink: async (link, bytes, contentType) => {
      const l = upLinks.get(link.url.split('/').pop()!)
      if (!l) return 'refused'
      if (flaw !== 'reusable-links') { if (l.used) return 'refused'; if (find(l.reportId, l.file)) return 'refused' }
      if (flaw !== 'unconditioned-links') { if (contentType !== l.type) return 'refused'; if (bytes.length > l.bytes) return 'refused' }
      objects.set(l.key, bytes); l.used = true
      return 'ok'
    },
    getViaLink: async (url) => {
      const l = readLinks.get(url.split('/').pop()!)
      if (!l || l.expiresAt <= clock) return null
      const k = find(l.reportId, l.file)
      return k ? objects.get(k)! : null
    },
    objectKeys: (id) => [...objects.keys()].filter((k) => k.includes(`reports/${id}/`)),
  }
  /** Direct write of an object, for tests that do not care about links. */
  const upload = async (id: string, file: string, bytes: Uint8Array) => { objects.set(key(id, file), bytes) }
  const collectedKeys = (id: string) => (harness.objectKeys(id) as string[]).filter((k: string) => k.startsWith('collected/'))
  return { ...harness, collectedKeys, reports, objects, linkLog, calls, claims, approvals, upload }
}
