// The in-memory HostedStore this repo's tests run against. It must itself pass runStoreConformance.
import { sniffType, type HostedStore, type StoreHarness, type StoredReport } from '../../src/server/index.ts'

const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource))].map((x) => x.toString(16).padStart(2, '0')).join('')
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export function makeMemoryStore(start = Date.parse('2026-10-12T09:00:00Z')) {
  let clock = start
  const reports = new Map<string, StoredReport>()
  const objects = new Map<string, Uint8Array>()
  const claims = new Map<string, { until: number; settled: boolean }>()
  const approvals = new Map<string, string>()
  const links: { reportId: string; file: string; type: string; bytes: number }[] = []
  const calls = { uploadUrl: 0, finalize: 0, discard: 0, moveCollected: 0 }
  const key = (id: string, file: string) => `reports/${id}/${file}`
  const find = (id: string, file: string) => (objects.has(key(id, file)) ? key(id, file) : objects.has(`collected/${key(id, file)}`) ? `collected/${key(id, file)}` : null)
  const copy = <T,>(x: T): T => structuredClone(x)

  const store: HostedStore = {
    async put(r) { reports.set(r.id, copy(r)) },
    async get(id) { const r = reports.get(id); return r ? copy(r) : null },
    async listFor(member) { return [...reports.values()].filter((r) => r.who.member === member).map(copy) },
    async listOpenFor(by) {
      return [...reports.values()].filter((r) => { const c = claims.get(`${r.id}|${by}`); return !c || (!c.settled && c.until <= clock) }).map(copy)
    },
    async uploadUrl(a) { calls.uploadUrl++; links.push(a); return { url: `memory://upload/${key(a.reportId, a.file)}`, headers: { 'content-type': a.type, 'x-goog-content-length-range': `0,${a.bytes}` } } },
    async finalize(a) {
      calls.finalize++
      const k = find(a.reportId, a.file); if (!k) throw new Error('nothing uploaded')
      const b = objects.get(k)!
      return { type: sniffType(b.subarray(0, 64)), bytes: b.length, sha256: await hex(b) }
    },
    async claim(id, by, leaseMs) { const c = claims.get(`${id}|${by}`); claims.set(`${id}|${by}`, { until: clock + leaseMs, settled: c?.settled ?? false }) },
    async settle(id, by) { const c = claims.get(`${id}|${by}`); if (!c) return false; c.settled = true; return true },
    async setStatus(id, entry) { const r = reports.get(id); if (r) r.timeline.push(copy(entry)) },
    async claimApproval(id, by) { const h = approvals.get(id); if (!h) { approvals.set(id, by); return { ok: true } } return h === by ? { ok: true } : { claimedBy: h } },
    async moveCollected(id) {
      calls.moveCollected++
      for (const k of [...objects.keys()]) if (k.startsWith(`reports/${id}/`)) { objects.set(`collected/${k}`, objects.get(k)!); objects.delete(k) }
    },
    async countToday(member) { return [...reports.values()].filter((r) => r.who.member === member && day(Date.parse(r.receivedAt)) === day(clock)).length },
    async readUrl(a) { const k = find(a.reportId, a.file); if (!k) throw new Error('no such file'); return { url: `memory://read/${k}` } },
    async discard(a) { calls.discard++; objects.delete(key(a.reportId, a.file)) },
  }
  const harness: StoreHarness = {
    store,
    now: () => clock,
    advance: (ms) => { clock += ms },
    upload: async (id, file, bytes) => { objects.set(key(id, file), bytes) },
    collectedKeys: (id) => [...objects.keys()].filter((k) => k.startsWith(`collected/reports/${id}/`)),
  }
  return { ...harness, reports, objects, links, calls, claims }
}
