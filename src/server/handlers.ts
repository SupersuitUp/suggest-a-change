// THE HOSTED HALF (design sections 4, 5 and 9). Framework-neutral `(Request) => Promise<Response>`
// handlers a hosted app mounts, and the agent routes the owner's Mac collects through.
//
// ISOLATION IS THE POINT. Every member route resolves the report through `readable()`, which answers
// "not found" for a report that is missing AND for a report that belongs to someone else, with the same
// status and the same body, so no answer says whether another member's report exists. The role stored on
// a report is decided here from the signed-in member and the explicit maintainers list, never from the
// request. Nothing is uploaded through this server: `uploadUrl` issues a direct-to-storage link with the
// size and type fixed, and `finalize` checks what actually landed.
import { END, FLOW, STATUSES, isAcceptedMedia, isReportId, mayMove, validateReport } from '../contract.mjs'
import { effectiveLimits, type Limits } from './rate.ts'
import { ACCEPTED_TYPES, canonicalType, sameType } from './sniff.ts'

export interface TimelineEntry { status: string; by: string; at: string; step?: string; note?: string }
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

export interface TellEvent { type: 'submitted' | 'followed-up' | 'status' | 'settled'; reportId: string; member?: string }
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
  now?: () => number
}

export const LEASE_MS = 10 * 60_000
const WORDS_MAX = 20_000
// Sized from the field limits: words and the three answers at 4 bytes a character (any script), plus the rest.
// A maximal report in Chinese or emoji fits; the whole is still a small fraction of the 4 MB no handler may exceed.
export const BODY_CAP = 4 * WORDS_MAX * 4 + 64 * 1024
export const APPROVAL_LEASE_MS = 7 * 24 * 3600_000
export const READ_TTL_MS = 5 * 60_000
export const VOICE_FILE_BYTES = 25 * 2 ** 20
/** A voice file may be this many bytes per declared second (768 kbit/s, generous for any recorder) plus a little slack: ten seconds cannot claim 25 MB. */
export const VOICE_BYTES_PER_SECOND = 96_000
/** How long a report with missing attachments waits before it is offered to a Mac anyway. */
export const INCOMPLETE_GRACE_MS = 60 * 60_000
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const FOLLOW = /^[A-Za-z0-9_-]{1,64}$/
const FORBIDDEN = ['timeline', 'status', 'plan', 'decision', 'files', 'receivedAt', 'followUps', 'claimedBy', 'settledBy']

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
const notFound = () => json(404, { error: 'not found' })
const signIn = () => json(401, { error: 'sign in first' })
const bad = (error: string) => json(400, { error })
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

type Body = { body: Record<string, unknown> } | { res: Response }
/** Reads a JSON object body, refusing past `BODY_CAP` by the header and again by counting what arrives. */
async function readBody(req: Request, cap = BODY_CAP, optional = false): Promise<Body> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > cap) return { res: json(413, { error: 'too large' }) }
  if (!req.body) return optional ? { body: {} } : { res: bad('a JSON body is needed') }
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > cap) { await reader.cancel().catch(() => {}); return { res: json(413, { error: 'too large' }) } }
    chunks.push(value)
  }
  const all = new Uint8Array(n)
  let o = 0
  for (const c of chunks) { all.set(c, o); o += c.byteLength }
  try {
    const v = JSON.parse(new TextDecoder().decode(all))
    return isObj(v) ? { body: v } : optional ? { body: {} } : { res: bad('a JSON object is needed') }
  } catch { return optional ? { body: {} } : { res: bad('the body is not JSON') } }
}

const iso = (ms: number) => new Date(ms).toISOString()
const lastStatus = (r: StoredReport) => r.timeline[r.timeline.length - 1]?.status ?? 'received'
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
  const maintainers = [...opts.maintainers]
  const limits = effectiveLimits(opts.limits)
  const contractCeilings = { images: limits.images, imageBytes: limits.imageBytes, videos: limits.videos, videoBytes: limits.videoBytes, videoMs: limits.videoMs, voiceMs: limits.voiceMs, voiceTotalMs: limits.voiceTotalMs, perPersonPerDay: limits.perPersonPerDay }
  const now = opts.now ?? (() => Date.now())
  const since = (m: string) => { const v = opts.maintainersSince?.[m]; const t = typeof v === 'string' ? Date.parse(v) : v; return t !== undefined && Number.isFinite(t) ? t : undefined }
  const tell = async (e: TellEvent) => { try { await opts.tell?.(e) } catch { /* telling is best effort */ } }
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
    const report: Record<string, unknown> = {
      id: raw.id, kind: raw.kind, words, media, voice: v.voice,
      who: { member, role: roleOf(member) },
      ...(answers ? { answers } : {}),
      app: { ...(opts.app ?? {}) },
      where, diagnostics,
    }
    const problems = validateReport(report, { ceilings: contractCeilings })
    if (problems.length) return json(422, { error: 'the report is not valid', problems })
    const id = report.id as string
    const existing = await store.get(id)
    // The same member sending the same id again is a repeat, even at the day's limit: it was stored.
    if (existing?.who?.member === member) return json(200, { id, status: lastStatus(existing) })
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
      return now2?.who?.member === member ? json(200, { id, status: lastStatus(now2) }) : json(409, { error: 'that suggestion cannot use this id; start it again' })
    }
    await tell({ type: 'submitted', reportId: id, member })
    return json(200, { id, status: 'received' })
  }

  async function mine(req: Request): Promise<Response> {
    const m = wrongMethod(req, 'GET'); if (m) return m
    const member = await whoIs(req); if (!member) return signIn()
    // Filtered again here: a store that over-returns still cannot show another member's report.
    const rows = (await store.listFor(member)).filter((r) => r.who?.member === member)
    rows.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1))
    return json(200, rows.map((r) => ({ id: r.id, status: lastStatus(r), kind: r.kind, at: Date.parse(r.receivedAt) })))
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
    if (END.includes(lastStatus(r))) return json(409, { error: 'this suggestion is closed; start a new one' })
    const v = voiceEntries(raw.voice, limits.followUpVoiceNotes, new Set(fileNames(r))); if ('error' in v) return bad(v.error)
    // The caps are enforced again inside the store's atomic write: the read above is only a fast path.
    const added = await store.addFollowUp(id, { followId, words, at: iso(now()), by: roleOf(member), voice: v.voice.map(({ file, ms }) => ({ file, ms })) },
      { max: limits.followUps, maxVoice: limits.followUps * limits.followUpVoiceNotes, voiceTotalMs: limits.voiceTotalMs, closed: [...END] })
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
      await store.discard({ reportId: id, file }) // nothing unverified stays in storage
      await store.setFile(id, file, null)
      return json(422, { error })
    }
    if (!sameType(state.pending.type, real.type) || !sameType(declared?.type ?? state.pending.type, real.type)) return refuse('the file\'s contents are not the type it was declared as')
    if (real.bytes < 1 || real.bytes > state.pending.bytes) return refuse('the file is not the size it was declared as')
    if (declared?.sha256 && declared.sha256 !== real.sha256) return refuse('the file is not the one that was declared')
    const verified: FileState = { type: real.type as string, bytes: real.bytes, sha256: real.sha256, at: iso(now()) }
    await store.setFile(id, file, verified)
    await store.reopen(id) // verified after a Mac collected the report: it is offered again with this file
    return json(200, { file, type: verified.type, bytes: verified.bytes, sha256: verified.sha256 })
  }

  const complete = (r: StoredReport) => fileNames(r).every((f) => r.files?.[f]?.sha256)

  async function agentList(req: Request): Promise<Response> {
    const m = wrongMethod(req, 'GET'); if (m) return m
    const by = await maintainerFor(req); if (!by) return signIn()
    const out: StoredReport[] = []
    // A page, oldest first. Reports from before this maintainer was added are skipped when `maintainersSince` says so.
    for (const r of await store.listOpenFor(by, { limit: limits.agentPage * 3, since: since(by) })) {
      if (out.length >= limits.agentPage) break
      // A report still waiting for its attachments is held back, so the Mac never copies half of one.
      if (!complete(r) && now() - Date.parse(r.receivedAt) < INCOMPLETE_GRACE_MS) continue
      await store.claim(r.id, by, LEASE_MS)
      out.push(r)
    }
    // `revision` is what this Mac is being shown; it goes back with the settle so a report that grew in between is not settled.
    return json(200, { reports: out.map((r) => ({ ...r, revision: reportRevision(r) })) })
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
    const moves = mayMove(lastStatus(r), 'with-freeda')
    if (moves) await store.setStatus(id, { status: 'with-freeda', by: FLOW['with-freeda'].actor, at: iso(now()) }, lastStatus(r))
    await store.moveCollected(id)
    await tell({ type: 'settled', reportId: id })
    return json(200, { id, status: moves ? 'with-freeda' : lastStatus(r) })
  }

  async function agentClaimApproval(req: Request, id: string): Promise<Response> {
    const m = wrongMethod(req, 'POST'); if (m) return m
    const by = await maintainerFor(req); if (!by) return signIn()
    const body = await readBody(req, BODY_CAP, true); if ('res' in body) return body.res
    if (!isReportId(id) || !(await store.get(id))) return notFound()
    const got = await store.claimApproval(id, by, APPROVAL_LEASE_MS)
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
    const r = isReportId(id) ? await store.get(id) : null
    if (!r) return notFound()
    const from = lastStatus(r)
    if (from === status) return json(200, { id, status }) // a repeat
    if (!mayMove(from, status)) return json(409, { error: `a report cannot go from ${from} to ${status}` })
    // Once the owner is being asked, the Mac that holds the approval decides what happens next. Leaving
    // waiting-on-owner, starting the work and ending it need the claim (taken here if nobody holds it).
    if (from === 'waiting-on-owner' || status === 'being-made' || END.includes(status)) {
      const c = await store.claimApproval(id, by, APPROVAL_LEASE_MS)
      if (!('ok' in c)) return json(409, { error: 'another Mac holds the approval for this report', claimedBy: c.claimedBy })
    }
    const moved = await store.setStatus(id, { status, by: FLOW[status as keyof typeof FLOW].actor, at: iso(now()), ...(step ? { step } : {}), ...(note ? { note } : {}) }, from)
    if (!moved) return json(409, { error: 'the report changed while this was sent; read it again' })
    await tell({ type: 'status', reportId: id })
    return json(200, { id, status })
  }

  return { submit, uploadUrl, finalize, mine, one, append, agentList, agentFile, agentSettle, agentClaimApproval, agentReleaseApproval, agentStatus }
}
