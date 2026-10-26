// THE PRIVACY CATCH (suggestions-as-github-issues design, section 5). Runs over everything a person SAID before any of it
// becomes an issue: the words, the transcript and the follow-ups. Screenshots are not read for text in this version; the
// sheet's list is what tells the sender they are going. A hit holds the report for the owner; a credential is never
// filed as it is, whatever the tap (`mayFileAsIs`).

export type HitKind = 'credential' | 'email' | 'phone' | 'person'
export interface Hit { kind: HitKind; text: string; field: string }
export interface Person { name: string; aliases?: string[] }
export interface CatchOptions {
  /** Third parties: anyone in the workspace's people records other than the sender and the owner. */
  people?: Person[]
  /** Secrets the app knows, such as the sender's own account key; one under 12 characters is a name, not a secret, and is not looked for. */
  secrets?: string[]
}
/** What the catch reads: report fields, plus a `transcript` the Mac wrote. */
export interface Readable { words?: unknown; transcript?: unknown; followUps?: unknown; [k: string]: unknown }

const CREDENTIALS: RegExp[] = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
]
// A long random value after a name that says it is secret. The value alone is the hit, so "token=" survives redaction.
const ASSIGNED = /\b(?:api[_-]?key|key|token|secret|password|passwd)\s*[=:]\s*["']?([A-Za-z0-9+/_=-]{20,})/gi
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const PHONES: RegExp[] = [
  /(?<![\w.])(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?![\w.])/g,
  /(?<![\w.])\+\d{8,15}(?![\w.])/g,
]

/** Shannon entropy in bits per character: random keys score high, "aaaa..." and ordinary words low. */
function entropy(s: string): number {
  const n = new Map<string, number>()
  for (const ch of s) n.set(ch, (n.get(ch) ?? 0) + 1)
  let e = 0
  for (const c of n.values()) { const p = c / s.length; e -= p * Math.log2(p) }
  return e
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The context fields the catch reads too: each list, and the one text field in each entry.
const CONTEXT_FIELDS = [['items', 'value'], ['routes', 'route'], ['taps', 'label'], ['errors', 'message'], ['errors', 'frame']] as const

/** Every field the catch reads, with its name: words, transcript, followUps.<i>.words, and the context's
 *  context.items.<i>.value, context.routes.<i>.route, context.taps.<i>.label, context.errors.<i>.message and .frame. */
function fields(r: Readable): [string, string][] {
  const out: [string, string][] = []
  if (typeof r.words === 'string') out.push(['words', r.words])
  if (typeof r.transcript === 'string') out.push(['transcript', r.transcript])
  if (Array.isArray(r.followUps)) r.followUps.forEach((f, i) => { if (f && typeof (f as { words?: unknown }).words === 'string') out.push([`followUps.${i}.words`, (f as { words: string }).words]) })
  const ctx = r.context as Record<string, unknown> | undefined
  if (ctx && typeof ctx === 'object') {
    for (const [list, field] of CONTEXT_FIELDS) {
      const v = ctx[list]
      if (Array.isArray(v)) v.forEach((x, i) => { const t = (x as Record<string, unknown> | null)?.[field]; if (typeof t === 'string') out.push([`context.${list}.${i}.${field}`, t]) })
    }
  }
  return out
}
const digits = (s: string) => s.replace(/\D/g, '')

export function privacyCatch(report: Readable, { people = [], secrets = [] }: CatchOptions = {}): { hits: Hit[] } {
  const hits: Hit[] = []
  const seen = new Set<string>()
  // The sender's own way to be reached is theirs to share: it is never a hit, while anyone else's still is.
  const own = (report.who as { contact?: { email?: unknown; phone?: unknown } } | undefined)?.contact
  const ownEmail = typeof own?.email === 'string' ? own.email.toLowerCase() : null
  const ownPhone = typeof own?.phone === 'string' && digits(own.phone).length >= 7 ? digits(own.phone) : null
  const add = (kind: HitKind, text: string, field: string) => {
    if (kind === 'email' && ownEmail && text.toLowerCase() === ownEmail) return
    if (kind === 'phone' && ownPhone && digits(text) === ownPhone) return
    const k = `${field}\u0000${text}`
    if (seen.has(k)) return
    // A value already caught as a credential is not caught again as something smaller inside it.
    if (hits.some((h) => h.field === field && h.kind === 'credential' && h.text.includes(text))) return
    seen.add(k); hits.push({ kind, text, field })
  }
  const keys = secrets.filter((k) => typeof k === 'string' && k.length >= 12)
  const names = people.flatMap((p) => [p.name, ...(p.aliases ?? [])]).filter((n) => typeof n === 'string' && n.trim().split(/\s+/).length >= 2)
  for (const [field, text] of fields(report)) {
    for (const re of CREDENTIALS) for (const m of text.matchAll(re)) add('credential', m[0], field)
    for (const m of text.matchAll(ASSIGNED)) if (entropy(m[1]) >= 3) add('credential', m[1], field)
    for (const k of keys) if (text.includes(k)) add('credential', k, field)
    for (const m of text.matchAll(EMAIL)) add('email', m[0], field)
    for (const re of PHONES) for (const m of text.matchAll(re)) add('phone', m[0].trim(), field)
    for (const n of names) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${escape(n.trim()).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu')
      for (const m of text.matchAll(re)) add('person', m[0], field)
    }
  }
  return { hits }
}

/** A copy of the report with every hit replaced by `[removed]` in its own field, wherever it appears there. */
export function redact<T extends Readable>(report: T, hits: Hit[]): T {
  const cut = (field: string, text: string) => {
    const mine = hits.filter((h) => h.field === field).map((h) => h.text).sort((a, b) => b.length - a.length)
    return mine.reduce((t, h) => t.split(h).join('[removed]'), text)
  }
  const out: Readable = { ...report }
  if (typeof report.words === 'string') out.words = cut('words', report.words)
  if (typeof report.transcript === 'string') out.transcript = cut('transcript', report.transcript)
  if (Array.isArray(report.followUps)) {
    out.followUps = report.followUps.map((f, i) => (f && typeof (f as { words?: unknown }).words === 'string' ? { ...(f as object), words: cut(`followUps.${i}.words`, (f as { words: string }).words) } : f))
  }
  const ctx = report.context as Record<string, unknown> | undefined
  if (ctx && typeof ctx === 'object') {
    const next: Record<string, unknown> = { ...ctx }
    for (const list of ['items', 'routes', 'taps', 'errors'] as const) {
      const v = ctx[list]
      if (!Array.isArray(v)) continue
      next[list] = v.map((x, i) => {
        if (!x || typeof x !== 'object') return x
        const copy: Record<string, unknown> = { ...(x as Record<string, unknown>) }
        for (const [l, field] of CONTEXT_FIELDS) if (l === list && typeof copy[field] === 'string') copy[field] = cut(`context.${list}.${i}.${field}`, copy[field] as string)
        return copy
      })
    }
    out.context = next
  }
  return out as T
}

/** No credential among the hits: the owner may file it as it is. A credential only ever files without the flagged part. */
export const mayFileAsIs = (hits: Hit[]): boolean => !hits.some((h) => h.kind === 'credential')
