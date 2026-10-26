// THE HOSTED HALF (design sections 4, 5 and 9). Framework-neutral `(Request) => Promise<Response>`
// handlers a hosted app mounts, and the agent routes the owner's Mac collects through.
//
// ISOLATION IS THE POINT. Every member route resolves the report through `readable()`, which answers
// "not found" for a report that is missing AND for a report that belongs to someone else, with the same
// status and the same body, so no answer says whether another member's report exists. The role stored on
// a report is decided here from the signed-in member and the explicit maintainers list, never from the
// request. Nothing is uploaded through this server: `uploadUrl` issues a direct-to-storage link with the
// size and type fixed, and `finalize` checks what actually landed.
import { END, FLOW, LEGACY, STATUSES, TOLD, currentStatus, isAcceptedMedia, isReportId, mayMove, meaningFor, validIssue, validateReport, wordsFor } from '../contract.mjs'
import { fileSuggestion, privacyCatch, type AttachmentHost, type Fetch, type Person } from '../github/index.ts'
import { effectiveLimits, type Limits } from './rate.ts'
import { ACCEPTED_TYPES, canonicalType, sameType } from './sniff.ts'
import { json, notFound, signIn, cappedText } from './http.ts'
import { withPlace, type GeoHook } from './geo.ts'

export interface IssueRef { repo: string; number: number; url: string }
/** `by` is the actor (contract FLOW). `holder` is the maintainer whose Mac filed or closed the issue, written on that
 *  entry: the approval on such a report never lapses, and it is how the list and the claim name who has it. `issue` is
 *  written on the move to open. `flags` are the kinds the privacy catch found (never the words), on a held entry; the
 *  member's own view never shows them. */
export interface TimelineEntry { status: string; by: string; at: string; step?: string; note?: string; holder?: string; issue?: IssueRef; flags?: string[] }
export interface FileState { pending?: { type: string; bytes: number; issuedAt?: number }; type?: string; bytes?: number; sha256?: string; at?: string }
export interface FollowUp { followId: string; words: string; at: string; by: string; voice: { file: string; ms: number }[] }
export interface StoredReport {
  id: string
  who: { member: string; role: string }
  timeline: TimelineEntry[]
  receivedAt: string
  /** Server-side state per attachment: the upload link that was issued, and what finalize verified. */
  files?: Record<string, FileState>
  followUps?: FollowUp[]
  [field: string]: unknown
}

/** What a collector saw of a report: its verified files and its follow-ups. A store computes this from its own copy,
 *  inside `settle`, and settles only when it equals what the collector says it collected. */
export function reportRevision(r: Pick<StoredReport, 'files' | 'followUps'>): string {
  const files = Object.entries(r.files ?? {}).filter(([, v]) => v.sha256).map(([k, v]) => `${k}=${String(v.sha256).slice(0, 12)}`).sort()
  const ups = (r.followUps ?? []).map((f) => f.followId).sort()
  return `f:${files.join(',')}|u:${ups.join(',')}`
}

/** What an app's storage adapter implements, and must pass `runStoreConformance` against its real storage.
 *  Every method that changes a report is NARROW and atomic: a real adapter implements each with a transaction
 *  or a precondition, never "read the report, change a copy, write it back", which would roll back a status or
 *  a claim written in between. */
export interface HostedStore {
  /** CREATE-ONLY and atomic. 'exists' when the id is taken (nothing is written); 'limit' when `dailyLimit`
   *  reports from this member already exist today (counted in the same transaction as the create). */
  put(report: StoredReport, opts?: { dailyLimit?: number }): Promise<'created' | 'exists' | 'limit'>
  get(id: string): Promise<StoredReport | null>
  listFor(member: string): Promise<StoredReport[]>
  /** Reports this maintainer has not settled and holds no live lease on, oldest first, at most `limit`, none received before `since` (ms). */
  listOpenFor(maintainer: string, opts: { limit: number; since?: number }): Promise<StoredReport[]>
  /** A direct-to-storage upload link. REQUIRED: it can create the object once and never overwrite (create-only
   *  precondition), the size and type are fixed in its conditions, and it dies once used or expired. */
  uploadUrl(a: { reportId: string; file: string; type: string; bytes: number }): Promise<{ url: string; headers: Record<string, string> }>
  /** Reads the stored object and answers what it REALLY is: the type sniffed from its bytes (null if unrecognised), its size and sha256. Null when nothing has arrived yet; throws on a store error. */
  finalize(a: { reportId: string; file: string }): Promise<{ type: string | null; bytes: number; sha256: string } | null>
  /** Deletes the object (a refused one) so nothing unverified stays in storage. */
  discard(a: { reportId: string; file: string }): Promise<void>
  /** Conditionally sets (or with null removes) one entry of the report's `files`, touching nothing else. A verified
   *  entry is NEVER replaced or removed. A pending entry is replaced by a verified one, or by a pending one at least as
   *  recent (`issuedAt`), never by an older pending one. True when it applied. */
  setFile(id: string, file: string, state: FileState | null): Promise<boolean>
  /** Adds a follow-up once per followId, enforcing the caps INSIDE the atomic write: at most `max` follow-ups, at most
   *  `maxVoice` voice notes across them, at most `voiceTotalMs` of voice across the whole report, no reused file name,
   *  and none when the report's last status is one of `closed`. */
  addFollowUp(id: string, followUp: FollowUp, caps: { max: number; maxVoice: number; voiceTotalMs: number; closed: string[] }): Promise<'added' | 'exists' | 'missing' | 'full' | 'clash' | 'closed'>
  /** Records that `by` holds this report for `leaseMs`; offered again to `by` when it passes without a settle. */
  claim(id: string, by: string, leaseMs: number): Promise<void>
  /** Settles the report for `by` only if the report is still what the collector saw (`revision`, from `reportRevision`).
   *  'stale' when something was added since: the claim is dropped so the next list offers the report again. */
  settle(id: string, by: string, revision: string): Promise<'settled' | 'stale' | 'unclaimed'>
  /** Clears every maintainer's settled mark so the report is offered again. True when any was cleared. */
  reopen(id: string): Promise<boolean>
  /** Appends to the timeline only when the last status is still `expectFrom` (when given); false when it is not. */
  setStatus(id: string, entry: TimelineEntry, expectFrom?: string): Promise<boolean>
  /** First wins and is atomic; the holder asking again keeps it (the lease renews). Another maintainer may take it once `leaseMs` has passed without renewal. */
  claimApproval(id: string, by: string, leaseMs: number): Promise<{ ok: true } | { claimedBy: string }>
  /** The holder gives the approval up. False when `by` does not hold it. */
  releaseApproval(id: string, by: string): Promise<boolean>
  /** Moves the report's attachments under `collected/`. Idempotent; files stay readable. */
  moveCollected(id: string): Promise<void>
  countToday(member: string): Promise<number>
  /** A read link for one verified attachment (the collected copy when there is one) that stops working after `ttlMs`. */
  readUrl(a: { reportId: string; file: string; ttlMs: number }): Promise<{ url: string; expiresAt: number }>
}

/** `status` events also carry the report's member and its new status. */
export interface TellEvent { type: 'submitted' | 'followed-up' | 'status' | 'settled'; reportId: string; member?: string; status?: string }
export { TOLD }
/** What `tellSubmitter` is handed. `words` and `meaning` are the module's own words for the status (`wordsFor`/`meaningFor`),
 *  never the report's text, so a lock screen never shows what someone wrote. `note` is the one-line reason, on `not-now` only. */
export interface SubmitterNews { member: string; reportId: string; status: string; words: string; meaning: string; ended: boolean; note?: string; /** The issue it became, so a push can link it. */ issue?: IssueRef }
/** Filing straight from the app's server: each complete report becomes an issue, with no Mac in the loop. */
export interface GitHubFiling {
  /** owner/name of the repo the issues go to. */
  repo: string
  /** A token that can open issues there (and push, when `attachments` is a branchHost with it). */
  token: string
  /** Where screenshots and recordings go. Without one they are listed as still being added. */
  attachments?: AttachmentHost
  /** Third parties the privacy catch looks for (anyone but the sender and the owner). */
  people?: Person[]
  /** The sender's name as the issue says it; without it the issue says "A member". Never their key or email. */
  nameOf?(member: string): string | undefined | Promise<string | undefined>
  /** For GitHub calls and for reading the stored files back through their read links. */
  fetch?: Fetch
}
export interface ReportHandlerOptions {
  store: HostedStore
  /** The signed-in member, or null. Anything but `account` is ignored: the role is decided here. */
  identity(req: Request): Promise<{ account: string } | null>
  /** Member keys with maintainer permission. Ordinary membership is never this. */
  maintainers: string[]
  /** Which maintainer's Mac is calling (by its agent key), or null. */
  agent(req: Request): Promise<string | null>
  limits?: Limits
  /** Stamped into every report as `app`, from the app's own config; an `app` in the request body is ignored. */
  app?: Record<string, string>
  /** When a maintainer was added (ms or ISO). Reports received before that are not offered to them; with none, every open report is. */
  maintainersSince?: Record<string, number | string>
  /** Told when something happens, with ids and never words. A failure here never fails the request. */
  tell?(event: TellEvent): void | Promise<void>
  /** REQUIRED: tells the person who suggested a change that it is being made or has ended, on the app's own channel (push,
   *  email, an activity row). Called once per telling move (`TOLD`), never on a repeat, never when the store refused the move,
   *  and never to a maintainer about their own report being made. A failure never fails the move. An app that genuinely
   *  has nobody to tell passes `{ none: "<reason>" }`; leaving it out throws at startup. */
  tellSubmitter: ((news: SubmitterNews) => void | Promise<void>) | { none: string }
  /** When given, a report is filed as an issue the moment it is complete: at submit when it has no files, else when its
   *  last file is verified. A privacy hit holds it for the owner instead; GitHub failing leaves it received for a Mac. */
  github?: GitHubFiling
  /** Roughly where the sender was, from the request (never a browser prompt). Added to the report's context as one item;
   *  a place the phone claims is dropped. On Vercel: `(req) => ({ city: decodeURIComponent(req.headers.get('x-vercel-ip-city') ?? ''),
   *  region: req.headers.get('x-vercel-ip-country-region') ?? '', country: req.headers.get('x-vercel-ip-country') ?? '' })`. */
  geo?: GeoHook
  now?: () => number
}

export const LEASE_MS = 10 * 60_000
const WORDS_MAX = 20_000
// Sized from the field limits: words and the three answers at 4 bytes a character (any script), plus the rest.
// A maximal report in Chinese or emoji fits; the whole is still a small fraction of the 4 MB no handler may exceed.
export const BODY_CAP = 4 * WORDS_MAX * 4 + 64 * 1024
export const APPROVAL_LEASE_MS = 7 * 24 * 3600_000
/** The approval's lease once the work has started or ended: in effect it never lapses (finite, so every store can keep it). */
export const HELD_MS = 100 * 365 * 24 * 3600_000
export const READ_TTL_MS = 5 * 60_000
export const VOICE_FILE_BYTES = 25 * 2 ** 20
/** A voice file may be this many bytes per declared second (768 kbit/s, generous for any recorder) plus a little slack: ten seconds cannot claim 25 MB. */
export const VOICE_BYTES_PER_SECOND = 200_000
/** How long a report with missing attachments waits before it is offered to a Mac anyway. */
export const INCOMPLETE_GRACE_MS = 60 * 60_000
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const FOLLOW = /^[A-Za-z0-9_-]{1,64}$/
const FORBIDDEN = ['timeline', 'status', 'plan', 'decision', 'issue', 'files', 'receivedAt', 'followUps', 'claimedBy', 'settledBy']
/** Every stored status that means closed, old ones included: what a store's atomic follow-up write refuses on. */
const CLOSED_STORED = [...END, ...Object.keys(LEGACY).filter((k) => END.includes(LEGACY[k as keyof typeof LEGACY]))]

const bad = (error: string) => json(400, { error })
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

type Body = { body: Record<string, unknown> } | { res: Response }
/** Reads a JSON object body, refusing past `BODY_CAP` by the header and again by counting what arrives. */
async function readBody(req: Request, cap = BODY_CAP, optional = false): Promise<Body> {
  if (!req.body && !(Number(req.headers.get('content-length')) > cap)) return optional ? { body: {} } : { res: bad('a JSON body is needed') }
  const text = await cappedText(req, cap)
  if (typeof text !== 'string') return { res: text }
  try {
    const v = JSON.parse(text)
    return isObj(v) ? { body: v } : optional ? { body: {} } : { res: bad('a JSON object is needed') }
  } catch { return optional ? { body: {} } : { res: bad('the body is not JSON') } }
}

const iso = (ms: number) => new Date(ms).toISOString()
/** The status as stored (a store's precondition compares this one). */
const lastStatus = (r: StoredReport) => r.timeline[r.timeline.length - 1]?.status ?? 'received'
/** The status it means now: an old (0.1.x) status folded into the new one. Every decision below reads this. */
const cur = (r: StoredReport) => currentStatus(lastStatus(r))
/** Filed or closed: whoever holds the approval keeps it. */
const FILED = [...TOLD]
const issueOf = (r: StoredReport): IssueRef | undefined => {
  for (let i = r.timeline.length - 1; i >= 0; i--) if (r.timeline[i].issue) return r.timeline[i].issue
  return undefined
}
/** The maintainer named on the latest move that filed or closed it (or an old one that started or ended the work). */
const holderOf = (r: StoredReport): string | undefined => {
  for (let i = r.timeline.length - 1; i >= 0; i--) if (r.timeline[i].holder) return r.timeline[i].holder
  return undefined
}
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null)
const fileNames = (r: StoredReport): string[] => [
  ...((r.media as { file: string }[] | undefined) ?? []).map((m) => m.file),
  ...((r.voice as { file: string }[] | undefined) ?? []).map((v) => v.file),
  ...(r.followUps ?? []).flatMap((f) => f.voice.map((v) => v.file)),
]

interface Declared { kind: 'media' | 'voice'; type?: string; bytes?: number; sha256?: string; ms?: number }
function declaredFile(r: StoredReport, file: string): Declared | null {
  const m = ((r.media as { file: string; type: string; bytes: number; sha256?: string }[] | undefined) ?? []).find((x) => x.file === file)
  if (m) return { kind: 'media', type: m.type, bytes: m.bytes, ...(m.sha256 ? { sha256: m.sha256 } : {}) }
  const v = ((r.voice as { file: string; ms: number }[] | undefined) ?? []).find((x) => x.file === file) ?? (r.followUps ?? []).flatMap((f) => f.voice).find((x) => x.file === file)
  return v ? { kind: 'voice', ms: v.ms } : null
}

export function createReportHandlers(opts: ReportHandlerOptions) {
  const { store, identity, agent } = opts
  const hook = opts.tellSubmitter as unknown
  if (typeof hook !== 'function') {
    const reason = hook && typeof hook === 'object' ? (hook as { none?: unknown }).none : undefined
    if (hook === undefined || hook === null) throw new Error('createReportHandlers needs tellSubmitter: a function that tells the person who suggested a change when it is being made and when it ends, or { none: "<reason>" } when the app has nobody to tell')
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('tellSubmitter { none } needs a reason: say why this app tells nobody, as { none: "<reason>" }')
  }
  const tellSubmitter = typeof hook === 'function' ? (hook as (n: SubmitterNews) => void | Promise<void>) : null
  const maintainers = [...opts.maintainers]
  const limits = effectiveLimits(opts.limits)
  const contractCeilings = { images: limits.images, imageBytes: limits.imageBytes, videos: limits.videos, videoBytes: limits.videoBytes, videoMs: limits.videoMs, voiceMs: limits.voiceMs, voiceTotalMs: limits.voiceTotalMs, perPersonPerDay: limits.perPersonPerDay }
  const now = opts.now ?? (() => Date.now())
  const since = (m: string) => { const v = opts.maintainersSince?.[m]; const t = typeof v === 'string' ? Date.parse(v) : v; return t !== undefined && Number.isFinite(t) ? t : undefined }
  const tell = async (e: TellEvent) => { try { await opts.tell?.(e) } catch { /* telling is best effort */ } }
  const owner = typeof opts.app?.owner === 'string' && opts.app.owner ? opts.app.owner : 'the owner'
  const news = async (n: SubmitterNews) => { try { await tellSubmitter?.(n) } catch { /* telling is best effort */ } }
  const isMaintainer = (m: string) => maintainers.includes(m)
  const roleOf = (m: string) => (isMaintainer(m) ? 'maintainer' : 'member')

  const wrongMethod = (req: Request, m: string) => (req.method === m ? null : json(405, { error: 'method not allowed' }))
  const whoIs = async (req: Request) => { const me = await identity(req); return me && typeof me.account === 'string' && me.account ? me.account : null }
  const maintainerFor = async (req: Request) => { const k = await agent(req); return k && isMaintainer(k) ? k : null }

  /** The report if this member may see it, else null: the same null for missing and for someone else's. */
  async function readable(id: string, member: string, { ownerOnly = false } = {}): Promise<StoredReport | null> {
    if (!isReportId(id)) return null
    const r = await store.get(id)
    if (!r) return null
    if (r.who?.member === member) return r
    return !ownerOnly && isMaintainer(member) ? r : null
  }
  /** What a member is shown: a whitelist, so a field an adapter keeps on the document (claims, maintainer keys, upload state) never reaches them. */
  const publicView = (r: StoredReport) => ({
    id: r.id, kind: r.kind, words: r.words, who: r.who, receivedAt: r.receivedAt,
    ...(r.answers !== undefined ? { answers: r.answers } : {}),
    ...(r.app !== undefined ? { app: r.app } : {}),
    where: r.where, diagnostics: r.diagnostics, media: r.media ?? [], voice: r.voice ?? [],
    ...(issueOf(r) ? { issue: issueOf(r) } : {}),
    ...(r.context !== undefined ? { context: r.context } : {}),
    timeline: (r.timeline ?? []).map((t) => ({ status: t.status, by: t.by, at: t.at, ...(t.step ? { step: t.step } : {}), ...(t.note ? { note: t.note } : {}) })),
    followUps: (r.followUps ?? []).map((f) => ({ followId: f.followId, words: f.words, at: f.at, by: f.by, voice: f.voice })),
  })

  /** Validates voice entries: integer ms above zero, within the per-note ceiling, a count cap, no clash of names. */
  function voiceEntries(list: unknown, cap: number, taken: Set<string>): { voice: { file: string; ms: number; field?: string }[] } | { error: string } {
    const arr = Array.isArray(list) ? list : []
    if (arr.length > cap) return { error: `at most ${cap} voice notes` }
    const voice: { file: string; ms: number; field?: string }[] = []
    for (const x of arr) {
      if (!isObj(x) || typeof x.file !== 'string' || !FILE.test(x.file) || !Number.isInteger(x.ms) || (x.ms as number) < 1) return { error: 'a voice note is not valid' }
      if ((x.ms as number) > limits.voiceMs) return { error: 'a voice note is too long' }
      if (taken.has(x.file)) return { error: 'a voice note reuses a file name' }
      taken.add(x.file)
      voice.push({ file: x.file, ms: x.ms as number, ...(typeof x.field === 'string' ? { field: x.field.slice(0, 64) } : {}) })
    }
    return { voice }
  }

  async function submit(req: Request): Promise<Response> {
    const m = wrongMethod(req, 'POST'); if (m) return m
    const member = await whoIs(req); if (!member) return signIn()
    const got = await readBody(req); if ('res' in got) return got.res
    const raw = got.body
    for (const k of FORBIDDEN) if (k in raw) return bad(`${k} is set by the server and is not accepted in a report`)
    // `who` and `app` from the phone are ignored: identity and role come from the signed-in member, the app from the app's config.
    const words = raw.words === undefined ? '' : str(raw.words, WORDS_MAX)
    if (words === null) return bad('words is too long or not text')
    const taken = new Set<string>()
    const media: unknown[] = []
    for (const x of Array.isArray(raw.media) ? raw.media : []) {
      // Pictures and videos only: audio is a voice note, and a voice note is counted and capped as one.
      if (!isObj(x) || typeof x.file !== 'string' || !FILE.test(x.file) || typeof x.type !== 'string' || !isAcceptedMedia(x.type) || !Number.isInteger(x.bytes) || (x.bytes as number) < 1 || taken.has(x.file)) return bad('an attachment is not valid')
      taken.add(x.file)
      media.push({ file: x.file, type: canonicalType(x.type), bytes: x.bytes, ...(Number.isInteger(x.ms) && (x.ms as number) >= 0 ? { ms: x.ms } : {}), ...(typeof x.sha256 === 'string' && /^[0-9a-f]{64}$/.test(x.sha256) ? { sha256: x.sha256 } : {}) })
    }
    const v = voiceEntries(raw.voice, limits.voiceNotes, taken); if ('error' in v) return bad(v.error)
    let answers: unknown
    if (isObj(raw.answers)) {
      const a: Record<string, string> = {}
      for (const k of ['happened', 'expected', 'steps']) { const t = raw.answers[k] === undefined ? '' : str(raw.answers[k], WORDS_MAX); if (t === null) return bad('an answer is too long or not text'); a[k] = t }
      answers = a
    }
    const where: Record<string, string> = {}
    if (isObj(raw.where)) {
      if (raw.where.screen !== undefined) { const t = str(raw.where.screen, 200); if (t === null) return bad('where.screen is short text'); where.screen = t }
      if (raw.where.route !== undefined) { const t = str(raw.where.route, 500); if (t === null) return bad('where.route is short text'); where.route = t }
    }
    const diagnostics: Record<string, string | number> = {}
    if (isObj(raw.diagnostics)) {
      for (const [k, d] of Object.entries(raw.diagnostics)) {
        if (typeof d === 'number' && Number.isFinite(d)) diagnostics[k] = d
        else if (typeof d === 'string' && d.length <= 200) diagnostics[k] = d
        else return bad('diagnostics values are short text')
      }
    }
    // The sender's own way to be reached is the one part of `who` the phone may send; the contract checks its shape.
    const contact = isObj(raw.who) && raw.who.contact !== undefined ? raw.who.contact : undefined
    const context = raw.context === undefined && !opts.geo ? undefined : await withPlace(raw.context, req, opts.geo)
    const report: Record<string, unknown> = {
      id: raw.id, kind: raw.kind, words, media, voice: v.voice,
      who: { member, role: roleOf(member), ...(contact !== undefined ? { contact } : {}) },
      ...(context !== undefined ? { context } : {}),
      ...(answers ? { answers } : {}),
      app: { ...(opts.app ?? {}) },
      where, diagnostics,
    }
    const problems = validateReport(report, { ceilings: contractCeilings })
    if (problems.length) return json(422, { error: 'the report is not valid', problems })
    const id = report.id as string
    const existing = await store.get(id)
    // The same member sending the same id again is a repeat, even at the day's limit: it was stored.
    if (existing?.who?.member === member) return json(200, { id, status: cur(existing) })
    if ((await store.countToday(member)) >= limits.perPersonPerDay) return json(429, { error: 'you have reached today\'s limit of suggestions' })
    const at = iso(now())
    const made = await store.put(
      { ...(report as { id: string; who: { member: string; role: string } }), receivedAt: at, timeline: [{ status: 'received', by: 'app', at }] },
      { dailyLimit: limits.perPersonPerDay },
    )
    if (made === 'limit') return json(429, { error: 'you have reached today\'s limit of suggestions' })
    if (made === 'exists') {
      // Lost a race with the same member (a repeat), or the id belongs to someone else. Someone else's id is REFUSED
      // (not re-issued, not dropped silently): nothing is created or overwritten, and the phone is told to start again.
      const now2 = await store.get(id)
      return now2?.who?.member === member ? json(200, { id, status: cur(now2) }) : json(409, { error: 'that suggestion cannot use this id; start it again' })
    }
    await tell({ type: 'submitted', reportId: id, member })
    // Nothing to wait for: with the github option it becomes an issue now.
    if (opts.github && !fileNames(report as unknown as StoredReport).length) await fileNow(id)
    const after = await store.get(id)
    return json(200, { id, status: after ? cur(after) : 'received' })
  }

  async function mine(req: Request): Promise<Response> {
    const m = wrongMethod(req, 'GET'); if (m) return m
    const member = await whoIs(req); if (!member) return signIn()
    // Filtered again here: a store that over-returns still cannot show another member's report.
    const rows = (await store.listFor(member)).filter((r) => r.who?.member === member)
    rows.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1))
    // A declined report carries its one-line reason, which the member's own view already shows; no other note is listed.
    const reason = (r: StoredReport) => { const t = r.timeline[r.timeline.length - 1]; return cur(r) === 'not-planned' && t?.note ? { note: t.note } : {} }
    return json(200, rows.map((r) => ({ id: r.id, status: cur(r), kind: r.kind, at: Date.parse(r.receivedAt), ...reason(r), ...(issueOf(r) ? { issue: issueOf(r) } : {}) })))
  }

  async function one(req: Request, id: string): Promise<Response> {
    const m = wrongMethod(req, 'GET'); if (m) return m
    const member = await whoIs(req); if (!member) return signIn()
    const r = await readable(id, member)
    return r ? json(200, publicView(r)) : notFound()
  }

  async function append(req: Request, id: string): Promise<Response> {
    const m = wrongMethod(req, 'POST'); if (m) return m
    const member = await whoIs(req); if (!member) return signIn()
    const got = await readBody(req); if ('res' in got) return got.res
    const raw = got.body
    const followId = typeof raw.followId === 'string' && FOLLOW.test(raw.followId) ? raw.followId : null
    const words = raw.words === undefined ? '' : str(raw.words, WORDS_MAX)
    if (!followId) return bad('followId is needed')
    if (words === null) return bad('words is too long or not text')
    // Only the report's owner adds to it (a follow-up's voice is uploaded with owner-only links, so a maintainer's could never arrive);
    // a maintainer speaks to the member through status notes.
    const r = await readable(id, member, { ownerOnly: true }); if (!r) return notFound()
    if ((r.followUps ?? []).some((f) => f.followId === followId)) return json(200, { id, followId }) // a repeat
    if (END.includes(cur(r))) return json(409, { error: 'this suggestion is closed; start a new one' })
    const v = voiceEntries(raw.voice, limits.followUpVoiceNotes, new Set(fileNames(r))); if ('error' in v) return bad(v.error)
    // The caps are enforced again inside the store's atomic write: the read above is only a fast path.
    const added = await store.addFollowUp(id, { followId, words, at: iso(now()), by: roleOf(member), voice: v.voice.map(({ file, ms }) => ({ file, ms })) },
      { max: limits.followUps, maxVoice: limits.followUps * limits.followUpVoiceNotes, voiceTotalMs: limits.voiceTotalMs, closed: CLOSED_STORED })
    if (added === 'missing') return notFound()
    if (added === 'closed') return json(409, { error: 'this suggestion is closed; start a new one' })
    if (added === 'full') return bad('this report has all the follow-ups or voice it can take')
    if (added === 'clash') return bad('a voice note reuses a file name')
    if (added === 'added') {
      await store.reopen(id) // a Mac that already collected this report is offered it again, with what is new
      await tell({ type: 'followed-up', reportId: id, member })
    }
    return json(200, { id, followId })
  }

  async function uploadUrl(req: Request): Promise<Response> {
    const m = wrongMethod(req, 'POST'); if (m) return m
    const member = await whoIs(req); if (!member) return signIn()
    const got = await readBody(req); if ('res' in got) return got.res
    const { reportId, file, type, bytes } = got.body
    if (typeof reportId !== 'string' || typeof file !== 'string' || !FILE.test(file) || typeof type !== 'string' || !Number.isInteger(bytes) || (bytes as number) < 1) return bad('reportId, file, type and bytes are needed')
    const r = await readable(reportId, member, { ownerOnly: true }); if (!r) return notFound()
    const want = declaredFile(r, file)
    if (!want) return bad('that file is not part of the report')
    const t = canonicalType(type)
    if (!(ACCEPTED_TYPES as readonly string[]).includes(t)) return bad('that kind of file is not accepted')
    // Everything below is judged against what the REPORT declared for this file, never against what was asked for.
    if (want.kind === 'media' && !sameType(want.type, t)) return bad('the type is not the one the report declared')
    if (want.kind === 'voice' && !t.startsWith('audio/')) return bad('a voice note must be audio')
    const n = bytes as number
    const cap = want.kind === 'voice' ? Math.min(VOICE_FILE_BYTES, Math.ceil(((want.ms ?? 0) / 1000) * VOICE_BYTES_PER_SECOND) + 65_536) : String(want.type).startsWith('video/') ? limits.videoBytes : limits.imageBytes
    if (n > cap || (want.bytes !== undefined && n > want.bytes)) return json(413, { error: 'that file is larger than this report allows' })
    if (r.files?.[file]?.sha256) return json(200, { done: true }) // already stored and verified: a retry has nothing to do
    const link = await store.uploadUrl({ reportId, file, type: t, bytes: n })
    await store.setFile(reportId, file, { pending: { type: t, bytes: n, issuedAt: now() } })
    return json(200, { url: link.url, headers: link.headers, maxBytes: n })
  }

  async function finalize(req: Request, id: string): Promise<Response> {
    const m = wrongMethod(req, 'POST'); if (m) return m
    const member = await whoIs(req); if (!member) return signIn()
    const got = await readBody(req); if ('res' in got) return got.res
    const file = typeof got.body.file === 'string' && FILE.test(got.body.file) ? got.body.file : null
    if (!file) return bad('file is needed')
    const r = await readable(id, member, { ownerOnly: true }); if (!r) return notFound()
    const state = r.files?.[file]
    if (state?.sha256) return json(200, { file, type: state.type, bytes: state.bytes, sha256: state.sha256 })
    if (!state?.pending) return json(409, { error: 'no upload link was issued for that file' })
    let real: { type: string | null; bytes: number; sha256: string } | null
    try { real = await store.finalize({ reportId: id, file }) } catch { return json(502, { error: 'the file store could not be read; try again' }) }
    if (!real) return json(409, { error: 'that file has not arrived yet' })
    const declared = declaredFile(r, file)
    const refuse = async (error: string) => {
      // Drop the pending entry first and delete the object only if that really removed it: a verified entry that won a race is never orphaned.
      if (await store.setFile(id, file, null)) await store.discard({ reportId: id, file }) // nothing unverified stays in storage
      return json(422, { error })
    }
    if (!sameType(state.pending.type, real.type) || !sameType(declared?.type ?? state.pending.type, real.type)) return refuse('the file\'s contents are not the type it was declared as')
    if (real.bytes < 1 || real.bytes > state.pending.bytes) return refuse('the file is not the size it was declared as')
    if (declared?.sha256 && declared.sha256 !== real.sha256) return refuse('the file is not the one that was declared')
    const verified: FileState = { type: real.type as string, bytes: real.bytes, sha256: real.sha256, at: iso(now()) }
    await store.setFile(id, file, verified)
    await store.reopen(id) // verified after a Mac collected the report: it is offered again with this file
    if (opts.github) await fileNow(id) // its last file: with the github option it becomes an issue now
    return json(200, { file, type: verified.type, bytes: verified.bytes, sha256: verified.sha256 })
  }

  const complete = (r: StoredReport) => fileNames(r).every((f) => r.files?.[f]?.sha256)

  async function agentList(req: Request): Promise<Response> {
    const m = wrongMethod(req, 'GET'); if (m) return m
    const by = await maintainerFor(req); if (!by) return signIn()
    const out: StoredReport[] = []
    // A page, oldest first. Reports from before this maintainer was added are skipped when `maintainersSince` says so.
    // A report another maintainer already closed is never offered: it is settled for this maintainer here, unseen, so
    // it neither raises a notice on this Mac nor sits at the head of every page. Settling one frees a slot, so the
    // store is asked again (a few times at most) until the page fills or nothing more was settled.
    for (let round = 0; round < 4 && out.length < limits.agentPage; round++) {
      const batch = await store.listOpenFor(by, { limit: limits.agentPage * 3, since: since(by) })
      let settled = 0
      for (const r of batch) {
        if (out.length >= limits.agentPage) break
        if (END.includes(cur(r)) && holderOf(r) !== by) {
          await store.claim(r.id, by, LEASE_MS)
          if ((await store.settle(r.id, by, reportRevision(r))) === 'settled') settled++
          continue
        }
        // A report still waiting for its attachments is held back, so the Mac never copies half of one.
        if (!complete(r) && now() - Date.parse(r.receivedAt) < INCOMPLETE_GRACE_MS) continue
        await store.claim(r.id, by, LEASE_MS)
        out.push(r)
      }
      if (!settled || batch.length < limits.agentPage * 3) break
    }
    // `revision` is what this Mac is being shown; it goes back with the settle so a report that grew in between is not settled.
    // `heldBy` names another maintainer whose Mac filed the issue, so this Mac leaves it to that one.
    return json(200, { reports: out.map((r) => {
      const holder = cur(r) === 'open' ? holderOf(r) : undefined
      return { ...r, revision: reportRevision(r), ...(holder && holder !== by ? { heldBy: holder } : {}) }
    }) })
  }

  async function agentFile(req: Request, id: string, file: string): Promise<Response> {
    const m = wrongMethod(req, 'GET'); if (m) return m
    const by = await maintainerFor(req); if (!by) return signIn()
    const r = isReportId(id) ? await store.get(id) : null
    const v = r?.files?.[file]
    if (!r || !FILE.test(file) || !v?.sha256) return notFound()
    const link = await store.readUrl({ reportId: id, file, ttlMs: READ_TTL_MS })
    // The collector MUST check what it downloads against this bytes and sha256 before it trusts the file.
    return json(200, { url: link.url, expiresAt: link.expiresAt, type: v.type, bytes: v.bytes, sha256: v.sha256 })
  }

  async function agentSettle(req: Request, id: string): Promise<Response> {
    const m = wrongMethod(req, 'POST'); if (m) return m
    const by = await maintainerFor(req); if (!by) return signIn()
    const got = await readBody(req, BODY_CAP, true); if ('res' in got) return got.res // no body is expected; one past the cap is refused
    const r = isReportId(id) ? await store.get(id) : null
    if (!r) return notFound()
    const revision = typeof got.body.revision === 'string' ? got.body.revision : null
    if (!revision) return bad('revision is needed: the one the list gave for this report')
    const settled = await store.settle(id, by, revision)
    if (settled === 'unclaimed') return json(409, { error: 'this report was not claimed by this Mac' })
    if (settled === 'stale') return json(409, { error: 'this report changed after it was listed; list again', stale: true })
    // Collecting is not filing: the report stays received until the Mac files the issue or holds it.
    await store.moveCollected(id)
    await tell({ type: 'settled', reportId: id })
    return json(200, { id, status: cur(r) })
  }

  /** Takes (or renews) the approval for `by`. A closed report is never taken, except to reopen it by the Mac that
   *  filed it (or by anyone when nobody is named); otherwise it answers who closed it. An open issue stays with the Mac
   *  that filed it. Taken for filing or closing, or on an open issue, the lease is HELD_MS, so it does not lapse; before
   *  that, a week. Writes nothing when refused. */
  async function takeApproval(r: StoredReport, by: string, to?: string): Promise<{ ok: true } | { closed: string; claimedBy?: string } | { claimedBy: string }> {
    const from = cur(r)
    const holder = holderOf(r)
    if (END.includes(from) && !(to === 'open' && (!holder || holder === by))) return { closed: from, ...(holder ? { claimedBy: holder } : {}) }
    if (from === 'open' && holder && holder !== by) return { claimedBy: holder }
    const lasting = FILED.includes(from) || (to !== undefined && FILED.includes(to))
    return store.claimApproval(r.id, by, lasting ? HELD_MS : APPROVAL_LEASE_MS)
  }

  async function agentClaimApproval(req: Request, id: string): Promise<Response> {
    const m = wrongMethod(req, 'POST'); if (m) return m
    const by = await maintainerFor(req); if (!by) return signIn()
    const body = await readBody(req, BODY_CAP, true); if ('res' in body) return body.res
    const r = isReportId(id) ? await store.get(id) : null
    if (!r) return notFound()
    const got = await takeApproval(r, by)
    if ('closed' in got) return json(409, { error: 'this suggestion is closed', closed: true, status: got.closed, ...(got.claimedBy ? { claimedBy: got.claimedBy } : {}) })
    return 'ok' in got ? json(200, { ok: true, claimedBy: by }) : json(409, { claimedBy: got.claimedBy })
  }

  async function agentReleaseApproval(req: Request, id: string): Promise<Response> {
    const m = wrongMethod(req, 'POST'); if (m) return m
    const by = await maintainerFor(req); if (!by) return signIn()
    const body = await readBody(req, BODY_CAP, true); if ('res' in body) return body.res
    if (!isReportId(id) || !(await store.get(id))) return notFound()
    return (await store.releaseApproval(id, by)) ? json(200, { released: true }) : json(409, { error: 'this Mac does not hold the approval' })
  }

  async function agentStatus(req: Request, id: string): Promise<Response> {
    const m = wrongMethod(req, 'POST'); if (m) return m
    const by = await maintainerFor(req); if (!by) return signIn()
    const got = await readBody(req); if ('res' in got) return got.res
    const status = got.body.status
    if (typeof status !== 'string' || !STATUSES.includes(status)) return bad('status is not one of the report statuses')
    const step = got.body.step === undefined ? undefined : str(got.body.step, 200)
    const note = got.body.note === undefined ? undefined : str(got.body.note, 200)
    if (step === null || note === null) return bad('step and note are short text')
    const rawIssue = got.body.issue
    if (rawIssue !== undefined && validIssue(rawIssue).length) return bad(`the issue is not valid: ${validIssue(rawIssue).join('; ')}`)
    const given = rawIssue as IssueRef | undefined
    const r = isReportId(id) ? await store.get(id) : null
    if (!r) return notFound()
    const from = cur(r)
    if (from === status) return json(200, { id, status }) // a repeat
    if (!mayMove(from, status)) return json(409, { error: `a report cannot go from ${from} to ${status}` })
    const issue = given ? { repo: given.repo, number: given.number, url: given.url } : undefined
    if (status === 'open' && !issue && !issueOf(r)) return bad('a move to open names the issue it became: { repo, number, url }')
    // Once it is held for the owner, the Mac that holds the approval decides what happens next. Leaving held,
    // filing and closing need the claim (taken here if nobody holds it).
    const needsApproval = from === 'held' || FILED.includes(status)
    if (needsApproval) {
      const c = await takeApproval(r, by, status)
      if (!('ok' in c)) return json(409, { error: 'another Mac holds the approval for this report', ...(c.claimedBy ? { claimedBy: c.claimedBy } : {}) })
    }
    // The maintainer is named on a move that files or closes it, so the hold is known from the report itself.
    const holder = FILED.includes(status) ? { holder: by } : {}
    // Declined before it was ever filed is the owner's decision, not GitHub's.
    const actor = status === 'not-planned' && from !== 'open' ? 'owner' : FLOW[status as keyof typeof FLOW].actor
    const moved = await store.setStatus(id, { status, by: actor, at: iso(now()), ...(step ? { step } : {}), ...(note ? { note } : {}), ...holder, ...(issue ? { issue } : {}) }, lastStatus(r))
    if (!moved) {
      // The lasting lease was taken for a move that did not happen: bring it back to a week.
      if (needsApproval && !FILED.includes(from) && FILED.includes(status)) await store.claimApproval(id, by, APPROVAL_LEASE_MS)
      return json(409, { error: 'the report changed while this was sent; read it again' })
    }
    // A maintainer is not told that the issue they just filed from their own report exists; a close is still news.
    await moved_(r, status, { by, note, issue: issue ?? issueOf(r) })
    return json(200, { id, status })
  }

  /** After a move landed: the ids-only tell, and the person who suggested it on a telling move. */
  async function moved_(r: StoredReport, status: string, { by, note, issue }: { by?: string; note?: string; issue?: IssueRef }) {
    const member = r.who?.member
    await tell({ type: 'status', reportId: r.id, member, status })
    const ownFiling = status === 'open' && member === by
    if (member && TOLD.includes(status) && !ownFiling) {
      await news({ member, reportId: r.id, status, words: wordsFor(status, { owner }), meaning: meaningFor(status, { owner, issue }), ended: END.includes(status), ...(status === 'not-planned' && note ? { note } : {}), ...(issue ? { issue } : {}) })
    }
  }

  /** FILING FROM THE APP'S SERVER (the github option). Runs once a report is complete. One caller files it: the approval
   *  is taken atomically under a one-time name, the report is read again under it, and a second caller finds it taken
   *  or already filed. A privacy hit holds it for the owner (the kinds on the entry, never the words); GitHub failing
   *  leaves it received and the approval free, so a maintainer's Mac can file it. Never fails the person's request. */
  async function fileNow(id: string): Promise<void> {
    const g = opts.github
    if (!g) return
    const first = await store.get(id)
    if (!first || cur(first) !== 'received' || !complete(first)) return
    const lock = `@app:${Math.random().toString(36).slice(2, 10)}`
    const got = await store.claimApproval(id, lock, HELD_MS)
    if (!('ok' in got)) return
    try {
      const r = await store.get(id)
      if (!r || cur(r) !== 'received' || !complete(r)) return
      const report = { id: r.id, kind: r.kind as string, words: (r.words as string) ?? '', who: r.who, voice: (r.voice as { file: string; ms: number }[]) ?? [], media: (r.media as { file: string; type: string; bytes: number }[]) ?? [], where: r.where as Record<string, string>, diagnostics: r.diagnostics as Record<string, string>, followUps: r.followUps ?? [], ...(r.context ? { context: r.context as never } : {}) }
      const { hits } = privacyCatch(report, { people: g.people ?? [], secrets: [r.who.member, ...maintainers] })
      if (hits.length) {
        const flags = [...new Set(hits.map((h) => h.kind))]
        await store.setStatus(id, { status: 'held', by: FLOW.held.actor, at: iso(now()), flags }, lastStatus(r))
        return
      }
      const f = g.fetch ?? globalThis.fetch
      const files = []
      if (g.attachments) {
        for (const name of fileNames(r)) {
          const v = r.files?.[name]
          if (!v?.sha256) continue
          const link = await store.readUrl({ reportId: id, file: name, ttlMs: READ_TTL_MS })
          const res = await f(link.url)
          if (!res.ok) continue // left as still being added
          files.push({ name, type: String(v.type), bytes: new Uint8Array(await res.arrayBuffer()) })
        }
      }
      const filerName = (await g.nameOf?.(r.who.member)) || undefined
      const filed = await fileSuggestion({ repo: g.repo, token: g.token, fetch: f }, {
        report,
        compose: { appName: opts.app?.name, appVersion: typeof report.diagnostics?.appVersion === 'string' ? report.diagnostics.appVersion : undefined, filerName, filerRole: r.who.role },
        files,
        ...(g.attachments ? { attachments: g.attachments } : {}),
      })
      const issue = { repo: g.repo, number: filed.number, url: filed.url }
      if (await store.setStatus(id, { status: 'open', by: FLOW.open.actor, at: iso(now()), issue }, lastStatus(r))) await moved_(r, 'open', { issue })
    } catch { /* GitHub or storage failed: it stays received for a Mac to file */ } finally {
      await store.releaseApproval(id, lock)
    }
  }

  return { submit, uploadUrl, finalize, mine, one, append, agentList, agentFile, agentSettle, agentClaimApproval, agentReleaseApproval, agentStatus }
}
