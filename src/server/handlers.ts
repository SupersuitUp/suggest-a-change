// THE HOSTED HALF (design sections 4, 5 and 9). Framework-neutral `(Request) => Promise<Response>`
// handlers a hosted app mounts, and the agent routes the owner's Mac collects through.
//
// ISOLATION IS THE POINT. Every member route resolves the report through `readable()`, which answers
// "not found" for a report that is missing AND for a report that belongs to someone else, with the same
// status and the same body, so no answer says whether another member's report exists. The role stored on
// a report is decided here from the signed-in member and the explicit maintainers list, never from the
// request. Nothing is uploaded through this server: `uploadUrl` issues a direct-to-storage link with the
// size and type fixed, and `finalize` checks what actually landed.
import { FLOW, STATUSES, isReportId, mayMove, validateReport } from '../contract.mjs'
import { effectiveLimits, type Limits } from './rate.ts'
import { ACCEPTED_TYPES, canonicalType, sameType } from './sniff.ts'

export interface TimelineEntry { status: string; by: string; at: string; step?: string; note?: string }
export interface FileState { pending?: { type: string; bytes: number }; type?: string; bytes?: number; sha256?: string; at?: string }
export interface StoredReport {
  id: string
  who: { member: string; role: string }
  timeline: TimelineEntry[]
  receivedAt: string
  /** Server-side state per attachment: the upload link that was issued, and what finalize verified. */
  files?: Record<string, FileState>
  followUps?: { followId: string; words: string; at: string; by: string; voice: { file: string; ms: number }[] }[]
  [field: string]: unknown
}

/** What an app's storage adapter implements (and must pass `runStoreConformance`). */
export interface HostedStore {
  /** Creates or replaces a report. Handlers check for an existing id first (dedupe by id). */
  put(report: StoredReport): Promise<void>
  get(id: string): Promise<StoredReport | null>
  listFor(member: string): Promise<StoredReport[]>
  /** Reports this maintainer has not settled and does not hold a live lease on. */
  listOpenFor(maintainer: string): Promise<StoredReport[]>
  /** A one-time direct-to-storage upload link with the size and type fixed in its conditions. */
  uploadUrl(a: { reportId: string; file: string; type: string; bytes: number }): Promise<{ url: string; headers: Record<string, string> }>
  /** Reads the stored object and answers what it REALLY is: the type sniffed from its bytes (null if unrecognised), its size and sha256. Throws if nothing was uploaded. */
  finalize(a: { reportId: string; file: string }): Promise<{ type: string | null; bytes: number; sha256: string }>
  /** Records that `by` holds this report for `leaseMs`; offered again to `by` when it passes without a settle. */
  claim(id: string, by: string, leaseMs: number): Promise<void>
  /** Records that `by` has the report. False when `by` never claimed it. */
  settle(id: string, by: string): Promise<boolean>
  /** Appends a status entry to the report's timeline. */
  setStatus(id: string, entry: TimelineEntry): Promise<void>
  /** First wins and is atomic; the same maintainer asking again still holds it. */
  claimApproval(id: string, by: string): Promise<{ ok: true } | { claimedBy: string }>
  /** Moves the report's attachments under `collected/`. Idempotent; files stay readable. */
  moveCollected(id: string): Promise<void>
  countToday(member: string): Promise<number>
  /** A short-lived read link for one verified attachment, wherever it now lives. */
  readUrl(a: { reportId: string; file: string }): Promise<{ url: string }>
  /** Optional: deletes a refused object so a clean one can be uploaded in its place. */
  discard?(a: { reportId: string; file: string }): Promise<void>
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
  /** Told when something happens, with ids and never words. A failure here never fails the request. */
  tell?(event: TellEvent): void | Promise<void>
  now?: () => number
}

export const LEASE_MS = 10 * 60_000
export const BODY_CAP = 256 * 1024 // far below the 4 MB no handler may exceed
export const VOICE_FILE_BYTES = 25 * 2 ** 20
/** How long a report with missing attachments waits before it is offered to a Mac anyway. */
export const INCOMPLETE_GRACE_MS = 60 * 60_000
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const FOLLOW = /^[A-Za-z0-9_-]{1,64}$/
const WORDS_MAX = 20_000
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

interface Declared { kind: 'media' | 'voice'; type?: string; bytes?: number; sha256?: string }
function declaredFile(r: StoredReport, file: string): Declared | null {
  const m = ((r.media as { file: string; type: string; bytes: number; sha256?: string }[] | undefined) ?? []).find((x) => x.file === file)
  if (m) return { kind: 'media', type: m.type, bytes: m.bytes, ...(m.sha256 ? { sha256: m.sha256 } : {}) }
  const v = ((r.voice as { file: string }[] | undefined) ?? []).some((x) => x.file === file) || (r.followUps ?? []).some((f) => f.voice.some((x) => x.file === file))
  return v ? { kind: 'voice' } : null
}

export function createReportHandlers(opts: ReportHandlerOptions) {
  const { store, identity, agent } = opts
  const maintainers = [...opts.maintainers]
  const limits = effectiveLimits(opts.limits)
  const now = opts.now ?? (() => Date.now())
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
  const publicView = (r: StoredReport) => { const { files: _files, ...rest } = r; return rest }

  async function submit(req: Request): Promise<Response> {
    const m = wrongMethod(req, 'POST'); if (m) return m
    const member = await whoIs(req); if (!member) return signIn()
    const got = await readBody(req); if ('res' in got) return got.res
    const raw = got.body
    for (const k of FORBIDDEN) if (k in raw) return bad(`${k} is set by the server and is not accepted in a report`)
    // `who` from the phone is ignored: the stored identity and role come from the signed-in member.
    const words = raw.words === undefined ? '' : str(raw.words, WORDS_MAX)
    if (words === null) return bad('words is too long or not text')
    const media: unknown[] = []
    for (const x of Array.isArray(raw.media) ? raw.media : []) {
      if (!isObj(x) || typeof x.file !== 'string' || !FILE.test(x.file) || typeof x.type !== 'string' || !(ACCEPTED_TYPES as readonly string[]).includes(canonicalType(x.type)) || !Number.isInteger(x.bytes) || (x.bytes as number) < 1) return bad('an attachment is not valid')
      media.push({ file: x.file, type: canonicalType(x.type), bytes: x.bytes, ...(typeof x.ms === 'number' ? { ms: x.ms } : {}), ...(typeof x.sha256 === 'string' && /^[0-9a-f]{64}$/.test(x.sha256) ? { sha256: x.sha256 } : {}) })
    }
    const voice: unknown[] = []
    for (const x of Array.isArray(raw.voice) ? raw.voice : []) {
      if (!isObj(x) || typeof x.file !== 'string' || !FILE.test(x.file) || typeof x.ms !== 'number') return bad('a voice note is not valid')
      voice.push({ file: x.file, ms: x.ms, ...(typeof x.field === 'string' ? { field: x.field.slice(0, 64) } : {}) })
    }
    const names = [...media, ...voice].map((x) => (x as { file: string }).file)
    if (new Set(names).size !== names.length) return bad('two attachments have the same file name')
    let answers: unknown
    if (isObj(raw.answers)) {
      const a: Record<string, string> = {}
      for (const k of ['happened', 'expected', 'steps']) { const s = raw.answers[k] === undefined ? '' : str(raw.answers[k], WORDS_MAX); if (s === null) return bad('an answer is too long or not text'); a[k] = s }
      answers = a
    }
    const report: Record<string, unknown> = {
      id: raw.id, kind: raw.kind, words, media, voice,
      who: { member, role: roleOf(member) },
      ...(answers ? { answers } : {}),
      ...(isObj(raw.app) ? { app: raw.app } : {}),
      where: isObj(raw.where) ? raw.where : {},
      diagnostics: isObj(raw.diagnostics) ? raw.diagnostics : {},
    }
    const problems = validateReport(report, { ceilings: limits })
    if (problems.length) return json(422, { error: 'the report is not valid', problems })
    const id = report.id as string
    const existing = await store.get(id)
    // The same id again is the same report. Another member's id answers exactly like a repeat and stores nothing.
    if (existing) return json(200, { id, status: existing.who?.member === member ? lastStatus(existing) : 'received' })
    if ((await store.countToday(member)) >= limits.perPersonPerDay) return json(429, { error: 'you have reached today\'s limit of suggestions' })
    const at = iso(now())
    await store.put({ ...(report as { id: string; who: { member: string; role: string } }), receivedAt: at, timeline: [{ status: 'received', by: 'app', at }] })
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
    const voice: { file: string; ms: number }[] = []
    for (const x of Array.isArray(raw.voice) ? raw.voice : []) {
      if (!isObj(x) || typeof x.file !== 'string' || !FILE.test(x.file) || typeof x.ms !== 'number' || x.ms < 0) return bad('a voice note is not valid')
      voice.push({ file: x.file, ms: x.ms })
    }
    const r = await readable(id, member); if (!r) return notFound()
    if ((r.followUps ?? []).some((f) => f.followId === followId)) return json(200, { id, followId }) // a repeat
    const taken = new Set(fileNames(r))
    if (voice.some((v) => taken.has(v.file)) || new Set(voice.map((v) => v.file)).size !== voice.length) return bad('a voice note reuses a file name')
    if (voice.some((v) => v.ms > limits.voiceMs)) return bad('a voice note is too long')
    const had = [...((r.voice as { ms: number }[] | undefined) ?? []), ...(r.followUps ?? []).flatMap((f) => f.voice)].reduce((n, v) => n + v.ms, 0)
    if (had + voice.reduce((n, v) => n + v.ms, 0) > limits.voiceTotalMs) return bad('the voice notes are too long in total')
    if ((r.followUps ?? []).length >= 50) return bad('this report has all the follow-ups it can take')
    await store.put({ ...r, followUps: [...(r.followUps ?? []), { followId, words, at: iso(now()), by: roleOf(member), voice }] })
    await tell({ type: 'followed-up', reportId: id, member })
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
    if (want.kind === 'media' && !sameType(want.type, t) && canonicalType(want.type) !== t) return bad('the type is not the one the report declared')
    if (want.kind === 'voice' && !t.startsWith('audio/')) return bad('a voice note must be audio')
    const n = bytes as number
    const cap = want.kind === 'voice' ? VOICE_FILE_BYTES : t.startsWith('video/') ? limits.videoBytes : limits.imageBytes
    if (n > cap || (want.bytes !== undefined && n > want.bytes)) return json(413, { error: 'that file is larger than this report allows' })
    const state = r.files?.[file]
    if (state?.sha256) return json(200, { done: true }) // already stored and verified: a retry has nothing to do
    const link = await store.uploadUrl({ reportId, file, type: t, bytes: n })
    await store.put({ ...r, files: { ...r.files, [file]: { pending: { type: t, bytes: n } } } })
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
    let real: { type: string | null; bytes: number; sha256: string }
    try { real = await store.finalize({ reportId: id, file }) } catch { return json(409, { error: 'that file has not arrived yet' }) }
    const declared = declaredFile(r, file)
    const refuse = async (error: string) => {
      try { await store.discard?.({ reportId: id, file }) } catch { /* nothing more to do */ }
      return json(422, { error })
    }
    if (!sameType(state.pending.type, real.type) || !sameType(declared?.type ?? state.pending.type, real.type)) return refuse('the file\'s contents are not the type it was declared as')
    if (real.bytes < 1 || real.bytes > state.pending.bytes) return refuse('the file is not the size it was declared as')
    if (declared?.sha256 && declared.sha256 !== real.sha256) return refuse('the file is not the one that was declared')
    const verified: FileState = { type: real.type as string, bytes: real.bytes, sha256: real.sha256, at: iso(now()) }
    await store.put({ ...r, files: { ...r.files, [file]: verified } })
    return json(200, { file, type: verified.type, bytes: verified.bytes, sha256: verified.sha256 })
  }

  const complete = (r: StoredReport) => fileNames(r).every((f) => r.files?.[f]?.sha256)

  async function agentList(req: Request): Promise<Response> {
    const m = wrongMethod(req, 'GET'); if (m) return m
    const by = await maintainerFor(req); if (!by) return signIn()
    const out: StoredReport[] = []
    for (const r of await store.listOpenFor(by)) {
      // A report still waiting for its attachments is held back, so the Mac never copies half of one.
      if (!complete(r) && now() - Date.parse(r.receivedAt) < INCOMPLETE_GRACE_MS) continue
      await store.claim(r.id, by, LEASE_MS)
      out.push(r)
    }
    return json(200, { reports: out })
  }

  async function agentFile(req: Request, id: string, file: string): Promise<Response> {
    const m = wrongMethod(req, 'GET'); if (m) return m
    const by = await maintainerFor(req); if (!by) return signIn()
    const r = isReportId(id) ? await store.get(id) : null
    const v = r?.files?.[file]
    if (!r || !FILE.test(file) || !v?.sha256) return notFound()
    const { url } = await store.readUrl({ reportId: id, file })
    return json(200, { url, type: v.type, bytes: v.bytes, sha256: v.sha256 })
  }

  async function agentSettle(req: Request, id: string): Promise<Response> {
    const m = wrongMethod(req, 'POST'); if (m) return m
    const by = await maintainerFor(req); if (!by) return signIn()
    const got = await readBody(req, BODY_CAP, true); if ('res' in got) return got.res // no body is expected; one past the cap is refused
    const r = isReportId(id) ? await store.get(id) : null
    if (!r) return notFound()
    if (!(await store.settle(id, by))) return json(409, { error: 'this report was not claimed by this Mac' })
    const moves = mayMove(lastStatus(r), 'with-freeda')
    if (moves) await store.setStatus(id, { status: 'with-freeda', by: FLOW['with-freeda'].actor, at: iso(now()) })
    await store.moveCollected(id)
    await tell({ type: 'settled', reportId: id })
    return json(200, { id, status: moves ? 'with-freeda' : lastStatus(r) })
  }

  async function agentClaimApproval(req: Request, id: string): Promise<Response> {
    const m = wrongMethod(req, 'POST'); if (m) return m
    const by = await maintainerFor(req); if (!by) return signIn()
    const body = await readBody(req, BODY_CAP, true); if ('res' in body) return body.res
    if (!isReportId(id) || !(await store.get(id))) return notFound()
    const got = await store.claimApproval(id, by)
    return 'ok' in got ? json(200, { ok: true, claimedBy: by }) : json(409, { claimedBy: got.claimedBy })
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
    await store.setStatus(id, { status, by: FLOW[status as keyof typeof FLOW].actor, at: iso(now()), ...(step ? { step } : {}), ...(note ? { note } : {}) })
    await tell({ type: 'status', reportId: id })
    return json(200, { id, status })
  }

  return { submit, uploadUrl, finalize, mine, one, append, agentList, agentFile, agentSettle, agentClaimApproval, agentStatus }
}
