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

/** Text as it will read once rendered: compatibility forms folded (NFKC, so fullwidth letters are letters) and invisible
 *  format characters removed (zero-width spaces and joiners, soft hyphens, direction marks), so a split token still matches. */
export const normalize = (s: string) => s.normalize('NFKC').replace(/\p{Cf}/gu, '')

/** EVERY string that reaches the issue, with the path it sits at: the words, the transcript, the follow-ups, where, every
 *  diagnostic, the names given (filerName, appName), the contact's handle, and every part of the context (each item's
 *  label, value and why, and the routes, taps and errors). Each is normalized before it is read. */
function fields(r: Readable): [string, string][] {
  const out: [string, string][] = []
  const at = (path: string, v: unknown) => { if (typeof v === 'string' && v) out.push([path, normalize(v)]) }
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
  at('words', r.words)
  at('transcript', r.transcript)
  if (Array.isArray(r.followUps)) r.followUps.forEach((f, i) => at(`followUps.${i}.words`, obj(f)?.words))
  const where = obj(r.where)
  at('where.screen', where?.screen); at('where.route', where?.route)
  for (const [k, v] of Object.entries(obj(r.diagnostics) ?? {})) at(`diagnostics.${k}`, v)
  at('filerName', r.filerName); at('appName', r.appName)
  at('who.contact.handle', obj(obj(r.who)?.contact)?.handle)
  const ctx = obj(r.context)
  if (ctx) {
    for (const [list, keys] of [['items', ['label', 'value', 'why']], ['routes', ['route']], ['taps', ['label']], ['errors', ['message', 'frame']]] as const) {
      const v = ctx[list]
      if (Array.isArray(v)) v.forEach((x, i) => { for (const k of keys) at(`context.${list}.${i}.${k}`, obj(x)?.[k]) })
    }
  }
  return out
}
const digits = (s: string) => s.replace(/\D/g, '')

export function privacyCatch(report: Readable, { people = [], secrets = [] }: CatchOptions = {}): { hits: Hit[] } {
  const hits: Hit[] = []
  const seen = new Set<string>()
  // The sender's own way to be reached is theirs to share: it is never a hit, while anyone else's still is. An email
  // or phone inside the contact itself (its handle) is the sender's too; anywhere else it is a hit.
  const own = (report.who as { contact?: { email?: unknown; phone?: unknown } } | undefined)?.contact
  const ownEmail = typeof own?.email === 'string' ? normalize(own.email).toLowerCase() : null
  const ownPhone = typeof own?.phone === 'string' && digits(own.phone).length >= 7 ? digits(own.phone) : null
  const add = (kind: HitKind, text: string, field: string) => {
    if (kind === 'email' && ownEmail && text.toLowerCase() === ownEmail) return
    if (kind === 'phone' && ownPhone && digits(text) === ownPhone) return
    if ((kind === 'email' || kind === 'phone') && field === 'who.contact.handle') return
    const k = `${field}\u0000${text}`
    if (seen.has(k)) return
    // A value already caught as a credential is not caught again as something smaller inside it.
    if (hits.some((h) => h.field === field && h.kind === 'credential' && h.text.includes(text))) return
    seen.add(k); hits.push({ kind, text, field })
  }
  const keys = secrets.filter((k) => typeof k === 'string' && k.length >= 12).map(normalize)
  const names = people.flatMap((p) => [p.name, ...(p.aliases ?? [])]).filter((n) => typeof n === 'string' && n.trim().split(/\s+/).length >= 2).map(normalize)
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

/** A copy of the report with every hit replaced by `[removed]` in its own field, wherever it appears there. A field with a
 *  hit comes back normalized (the form the catch read), so a hit split by an invisible character is removed too. */
export function redact<T extends Readable>(report: T, hits: Hit[]): T {
  const out = JSON.parse(JSON.stringify(report)) as Record<string, unknown>
  for (const field of [...new Set(hits.map((h) => h.field))]) {
    const path = field.split('.')
    let at: unknown = out
    for (const p of path.slice(0, -1)) at = at && typeof at === 'object' ? (at as Record<string, unknown>)[p] : undefined
    const last = path[path.length - 1]
    if (!at || typeof at !== 'object' || typeof (at as Record<string, unknown>)[last] !== 'string') continue
    const mine = hits.filter((h) => h.field === field).map((h) => h.text).sort((a, b) => b.length - a.length)
    ;(at as Record<string, unknown>)[last] = mine.reduce((t, h) => t.split(h).join('[removed]'), normalize((at as Record<string, string>)[last]))
  }
  return out as T
}


/** No credential among the hits: the owner may file it as it is. A credential only ever files without the flagged part. */
export const mayFileAsIs = (hits: Hit[]): boolean => !hits.some((h) => h.kind === 'credential')
