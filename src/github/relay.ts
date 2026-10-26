// RUN YOUR OWN SUGGESTION RELAY. One handler on a server the repo's owner runs, holding the private key of a GitHub App
// the owner created (contents: write, issues: write) and installed on the repos suggestions go to. It does four things,
// chosen by the last segment of the path it is mounted on (.../file, .../follow-up, .../status, .../attach):
//
// - file: for someone with NO access to the repo, not even read. The relay runs the privacy catch itself, saves the
//   files to the suggestion-attachments branch, then opens the issue AS THE APP with the filer's name (never their
//   account), and remembers which identity filed which issue.
// - follow-up and status: only for the identity that filed that report.
// - attach: for a filer who opened the issue themselves but cannot push; the relay proves they could file there by
//   reading the issue and requiring it to carry the report.
//
// Web-standard only: Request, Response, fetch, crypto.subtle.
import { CEILINGS, isRepoName, isReportId, validContact, validateReport } from '../contract.mjs'
import { cappedText, json } from '../server/http.ts'
import { ACCEPTED_TYPES, canonicalType, sameType, sniffType } from '../server/sniff.ts'
import { withPlace, type GeoHook } from '../server/geo.ts'
import { addFollowUp, fileIssue, github, GitHubError, issueStates, issueStatus, type Fetch } from './api.ts'
import { BODY_LIMIT, composeIssue, endsWithFiledBy } from './compose.ts'
import { ATTACHMENTS_BRANCH, attachmentUrl, branchHost } from './hosts.ts'
import { privacyCatch, redact, type Person } from './privacy.ts'

/** A voice recording's ceiling; the same number as the server half's VOICE_FILE_BYTES (a test holds them together). */
export const RELAY_VOICE_BYTES = 25 * 2 ** 20
export interface RelayLimits {
  /** Different reports one identity may file or attach to in a day. */
  perPersonPerDay: number
  /** Bytes of files one identity may send in a day, across every action. */
  bytesPerPersonPerDay: number
  images: number
  imageBytes: number
  videos: number
  videoBytes: number
  /** Recordings per report: the report's voice notes and those added to it later. */
  voice: number
  voiceBytes: number
  /** How long after an issue closed a file may still be attached to it. */
  closedGraceMs: number
  /** The largest file taken inside a request body. A larger one is staged (upload-url), or refused without staging.
   *  Serverless hosts cap a request body (Vercel at about 4.5 MB), so the default leaves room for base64 and the rest. */
  inlineBytes: number
}
export const RELAY_LIMITS: RelayLimits = {
  perPersonPerDay: CEILINGS.perPersonPerDay,
  bytesPerPersonPerDay: 300 * 2 ** 20,
  images: CEILINGS.images, imageBytes: CEILINGS.imageBytes,
  videos: CEILINGS.videos, videoBytes: CEILINGS.videoBytes,
  voice: 60, voiceBytes: RELAY_VOICE_BYTES,
  closedGraceMs: 7 * 24 * 3600_000,
  inlineBytes: 3 * 2 ** 20,
}

export interface FiledRecord { account: string; reportId: string; number: number; url: string }
/** A day's allowance held for one request, until it is committed (it happened) or released (it did not). */
export type Reservation = { ok: true; token: string } | { ok: false; over: 'reports' | 'bytes' }
/** What the relay remembers. Every method is ATOMIC in a real store (one transaction or a conditional write): a check
 *  and the change it guards are one step, so two requests at once can never both pass a cap of one. */
export interface RelayUsage {
  /** Holds today's allowance for this request: one more report (unless `reportId` was already counted today for
   *  `account`) and `bytes` more bytes, refusing when either would pass its limit. Nothing is held on a refusal. */
  reserve(account: string, day: string, reportId: string, bytes: number, limits: { reports: number; bytes: number }): Promise<Reservation>
  /** The request that reserved this happened: keep it. */
  commit(token: string): Promise<void>
  /** The request that reserved this did not happen: give it back. */
  release(token: string): Promise<void>
  /** A report belongs to the first identity that files or attaches for it: 'ok' for that identity, 'taken' for anyone else. */
  bind(repo: string, reportId: string, account: string): Promise<'ok' | 'taken'>
  /** Starts filing a report, first caller wins: 'go', or 'busy' while another filing of it runs, or the record of the issue it already became. */
  /** Starts filing a report under a lease of `leaseMs`, first caller wins: 'go', or 'busy' while another filing of it holds a
   *  live lease, or the record of the issue it already became. A lease past its time is taken over (its process died). */
  begin(repo: string, reportId: string, account: string, leaseMs: number): Promise<{ state: 'go' } | { state: 'busy' } | ({ state: 'filed' } & FiledRecord)>
  /** upload-url issued a link for this staging key, for at most `bytes`: a later read is bounded by it. */
  stage(key: string, bytes: number): Promise<void>
  /** The bytes upload-url held for this key, or null when it never issued one. */
  staged(key: string): Promise<number | null>
  /** The staged file was written and discarded: forget its key. */
  unstage(key: string): Promise<void>
  /** The filing that began succeeded: keep the record, by report and by issue number. */
  finish(repo: string, record: FiledRecord): Promise<void>
  /** The filing that began failed: forget it, so a retry can begin again. */
  abandon(repo: string, reportId: string): Promise<void>
  /** Who filed this issue through the relay, or null. */
  filer(repo: string, number: number): Promise<FiledRecord | null>
}
/** In memory, so ONE SERVER INSTANCE ONLY: a platform that runs several instances (most serverless hosts) needs a store
 *  backed by its database, or the caps, the idempotency and who-filed-what are per instance and lost on restart. Each
 *  method below changes what it checks before it yields, which is what makes it atomic in one process. */
export function memoryUsage({ now = () => Date.now() }: { now?: () => number } = {}): RelayUsage {
  const stagedSizes = new Map<string, number>()
  const days = new Map<string, Set<string>>()
  const bytes = new Map<string, number>()
  const held = new Map<string, { k: string; reportId: string; counted: boolean; bytes: number }>()
  const owners = new Map<string, string>()
  const filings = new Map<string, { state: 'busy'; until: number } | ({ state: 'filed' } & FiledRecord)>()
  const issues = new Map<string, FiledRecord>()
  let n = 0
  return {
    async reserve(a, d, r, b, lim) {
      const k = `${a}\u0000${d}`
      const set = days.get(k) ?? new Set<string>()
      const counted = !set.has(r)
      if (counted && set.size >= lim.reports) return { ok: false, over: 'reports' }
      if ((bytes.get(k) ?? 0) + b > lim.bytes) return { ok: false, over: 'bytes' }
      if (counted) { set.add(r); days.set(k, set) }
      bytes.set(k, (bytes.get(k) ?? 0) + b)
      const token = `t${++n}`
      held.set(token, { k, reportId: r, counted, bytes: b })
      return { ok: true, token }
    },
    async commit(t) { held.delete(t) },
    async release(t) {
      const h = held.get(t); if (!h) return
      held.delete(t)
      if (h.counted) days.get(h.k)?.delete(h.reportId)
      bytes.set(h.k, Math.max(0, (bytes.get(h.k) ?? 0) - h.bytes))
    },
    async bind(repo, r, a) { const k = `${repo}#${r}`; const had = owners.get(k); if (had === undefined) { owners.set(k, a); return 'ok' } return had === a ? 'ok' : 'taken' },
    async begin(repo, r, _a, leaseMs) {
      const k = `${repo}#${r}`
      const had = filings.get(k)
      if (had?.state === 'filed') return had
      if (had?.state === 'busy' && had.until > now()) return { state: 'busy' }
      filings.set(k, { state: 'busy', until: now() + leaseMs })
      return { state: 'go' }
    },
    async stage(k, b) { stagedSizes.set(k, b) },
    async staged(k) { return stagedSizes.get(k) ?? null },
    async unstage(k) { stagedSizes.delete(k) },
    async finish(repo, rec) { filings.set(`${repo}#${rec.reportId}`, { state: 'filed', ...rec }); issues.set(`${repo}#${rec.number}`, rec) },
    async abandon(repo, r) { const k = `${repo}#${r}`; if (filings.get(k)?.state === 'busy') filings.delete(k) },
    async filer(repo, num) { return issues.get(`${repo}#${num}`) ?? null },
  }
}

/** Who is calling, as the host knows them. The issue's name, role, app and contact come from here and never from the
 *  request: a request can say whether to share the contact (it sends `report.who.contact`), never what it is. */
export interface RelayIdentity {
  account: string
  /** The name the issue says it was filed by; "Someone" without one. */
  name?: string
  role?: 'operator' | 'member' | 'maintainer'
  /** The GitHub login this person files under, when the host knows it: `attach` to an issue the relay did not file
   *  is accepted only when that issue was opened by this login. */
  githubLogin?: string
  /** How to reach them, shared only when the request asks (the person left it ticked). */
  contact?: { email?: string; phone?: string; handle?: string }
}

export interface SuggestionRelayOptions {
  /** The GitHub App the relay acts as: its numeric id and its private key (PEM, PKCS#1 as GitHub issues it, or PKCS#8). */
  app: { id: number | string; privateKey: string }
  /** Who is calling, from the request (a session, an API key, whatever the server already uses), or null. */
  identity(req: Request): Promise<RelayIdentity | null>
  /** The repos this identity may file on; null (or no function) means any repo the App is installed on. */
  repos?(account: string): string[] | null | Promise<string[] | null>
  /** What the privacy catch looks for besides credentials, emails and phones: third parties, and secrets the host knows. */
  privacy?: { people?: Person[]; secrets?: string[] }
  /** Roughly where the filer was, from the request (see the server half's geo hooks); added to the issue's context. */
  geo?: GeoHook
  /** The apps this relay files for, by the id a request names (`app`): the issue's app name and its `app:<label>`
   *  come from here. A request naming an app not in the table is refused; without a table no request names one. */
  apps?: Record<string, { name: string; label: string }>
  /** Where files too large for one request body wait: the filer PUTs each to a one-time signed link (`upload-url`),
   *  and `file` or `attach` names it as `staged`. Without it, only files up to `inlineBytes` can be sent. */
  staging?: StagingAdapter
  /** May lower any limit, never raise one. */
  limits?: Partial<RelayLimits>
  usage?: RelayUsage
  fetch?: Fetch
  now?: () => number
  /** Default https://api.github.com */
  api?: string
}
/** The 0.2.0 name, for a relay that only attaches. */
export type AttachRelayOptions = SuggestionRelayOptions

/** A bucket the relay controls, for files past a request body limit. `uploadUrl` answers a one-time signed PUT that
 *  can only create `key` once, with this type and at most these bytes: on Google Cloud Storage a V4 signed URL for PUT
 *  with `x-goog-if-generation-match: 0` and `x-goog-content-length-range: 0,<bytes>` as signed headers; on S3 a
 *  presigned PUT with `If-None-Match: *` and the content type and length signed. `read` answers what arrived (or null),
 *  `discard` deletes it once the relay has written it to GitHub. */
export interface StagingAdapter {
  uploadUrl(key: string, o: { type: string; bytes: number }): Promise<{ url: string; headers?: Record<string, string> }>
  read(key: string): Promise<ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer | null>
  discard(key: string): Promise<void>
}

/** How long a filing holds its report before another try may take it over (its process is presumed dead). */
export const FILING_LEASE_MS = 5 * 60_000
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const B64 = /^[A-Za-z0-9+/]+={0,2}$/
const ACTIONS = ['file', 'follow-up', 'status', 'attach', 'upload-url'] as const
type Action = (typeof ACTIONS)[number]

const enc = new TextEncoder()
const b64url = (bytes: Uint8Array) => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromBase64(s: string): Uint8Array | null {
  if (!s || s.length % 4 !== 0 || !B64.test(s)) return null
  try { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out } catch { return null }
}

/** DER length bytes. */
const derLen = (n: number) => (n < 0x80 ? [n] : (() => { const b: number[] = []; while (n > 0) { b.unshift(n & 0xff); n >>= 8 } return [0x80 | b.length, ...b] })())
/** Wraps a PKCS#1 RSA key (what GitHub hands out) in the PKCS#8 envelope crypto.subtle imports. */
function pkcs1To8(pkcs1: Uint8Array): Uint8Array {
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]
  const octet = [0x04, ...derLen(pkcs1.length)]
  const inner = [0x02, 0x01, 0x00, ...algo, ...octet]
  const total = inner.length + pkcs1.length
  const out = new Uint8Array(1 + derLen(total).length + total)
  out.set([0x30, ...derLen(total), ...inner]); out.set(pkcs1, out.length - pkcs1.length)
  return out
}
async function importKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '')
  const der = fromBase64(body)
  if (!der) throw new Error('the App private key is not a PEM key')
  const pkcs8 = /BEGIN RSA PRIVATE KEY/.test(pem) ? pkcs1To8(der) : der
  return crypto.subtle.importKey('pkcs8', pkcs8 as BufferSource, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
}
/** The App's own JWT (RS256), good for nine minutes, issued a minute early for clock drift, as GitHub asks. */
async function appJwt(key: CryptoKey, id: string, nowMs: number): Promise<string> {
  const t = Math.floor(nowMs / 1000)
  const head = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const body = b64url(enc.encode(JSON.stringify({ iat: t - 60, exp: t + 540, iss: id })))
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${head}.${body}`)))
  return `${head}.${body}.${b64url(sig)}`
}

/** What kind of attachment a name in the folder is, by its extension (the names the module's sheet writes). */
const kindByName = (name: string): 'image' | 'video' | 'voice' | null => {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'webp', 'heic', 'heif', 'gif'].includes(ext)) return 'image'
  if (['mp4', 'm4v', 'mov', 'webm'].includes(ext) && !name.startsWith('voice-') && !name.startsWith('added-')) return 'video'
  if (['m4a', 'aac', 'mp3', 'wav', 'ogg', 'opus', 'webm', 'mp4', 'bin'].includes(ext)) return 'voice'
  return null
}
const kindOf = (type: string): 'image' | 'video' | 'voice' => (type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : 'voice')

/** A file ready to write: its real type and bytes, and (when it was staged) the key to discard once it is written. */
type Checked = { name: string; type: string; kind: 'image' | 'video' | 'voice'; bytes: Uint8Array; stagedKey?: string }
const stageKey = (account: string, reportId: string, name: string) => `staging/${encodeURIComponent(account)}/${reportId}/${name}`
/** Everything a staged object holds, refusing past `max` as it is read. */
async function bytesOf(got: ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer, max: number): Promise<Uint8Array | null> {
  if (got instanceof Uint8Array) return got.length > max ? null : got
  if (got instanceof ArrayBuffer) return got.byteLength > max ? null : new Uint8Array(got)
  const parts: Uint8Array[] = []
  let n = 0
  const reader = got.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.length
    if (n > max) { await reader.cancel(); return null }
    parts.push(value)
  }
  const out = new Uint8Array(n); let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

export function createSuggestionRelay(opts: SuggestionRelayOptions, only?: Action): (req: Request) => Promise<Response> {
  const limits: RelayLimits = { ...RELAY_LIMITS }
  for (const [k, v] of Object.entries(opts.limits ?? {}) as [keyof RelayLimits, number][]) {
    if (typeof v !== 'number' || !(k in RELAY_LIMITS)) continue
    if (v > RELAY_LIMITS[k]) throw new Error(`limits.${k} may lower the relay's ${RELAY_LIMITS[k]}, never raise it`)
    limits[k] = v
  }
  const id = String(opts.app.id)
  const cfgBase = { fetch: opts.fetch, api: opts.api }
  const usage = opts.usage ?? memoryUsage()
  const now = opts.now ?? (() => Date.now())
  const day = () => new Date(now()).toISOString().slice(0, 10)
  let key: Promise<CryptoKey> | null = null
  // The largest body each action can need, base64 and the rest of the JSON included, and never more than one day's
  // byte budget allows: a body past it is refused by its declared length, or as soon as the count passes it.
  const b64 = (n: number) => Math.ceil(n / 3) * 4
  const room = 64 * 1024
  const budget = b64(limits.bytesPerPersonPerDay) + room
  const oneCap = Math.min(b64(Math.min(limits.inlineBytes, Math.max(limits.imageBytes, limits.videoBytes, limits.voiceBytes))) + room, budget)
  const reportCap = Math.min(b64(Math.min(limits.inlineBytes, limits.imageBytes) * limits.images + Math.min(limits.inlineBytes, limits.videoBytes) * limits.videos + Math.min(limits.inlineBytes, limits.voiceBytes) * 10) + 4 * room, budget)
  const caps: Record<Action, number> = { file: reportCap, 'follow-up': oneCap, status: room, attach: oneCap, 'upload-url': room }
  const bad = (error: string) => json(400, { error })
  const gone = (e: unknown) => json(502, { error: 'GitHub could not be reached or refused the relay; try again', ...(e instanceof GitHubError ? { status: e.status } : {}) })

  /** A token for one repo, as the App's installation on it; a Response when the App is not installed there. */
  async function repoToken(repo: string): Promise<string | Response> {
    key ??= importKey(opts.app.privateKey)
    const jwt = await appJwt(await key, id, now())
    let installation: number
    try { installation = (await github({ ...cfgBase, token: jwt }, 'GET', `/repos/${repo}/installation`)).body.id }
    catch (e) { if (e instanceof GitHubError && e.status === 404) return json(403, { error: `the app is not installed on ${repo}` }); throw e }
    return (await github({ ...cfgBase, token: jwt }, 'POST', `/app/installations/${installation}/access_tokens`, { repositories: [repo.split('/')[1]] })).body.token as string
  }

  const kindCap = (kind: 'image' | 'video' | 'voice') => (kind === 'image' ? limits.imageBytes : kind === 'video' ? limits.videoBytes : limits.voiceBytes)
  const kindOfType = (t: string): 'image' | 'video' | 'voice' => (t.startsWith('audio/') ? 'voice' : kindOf(t))

  /** One file, inline (base64 `bytes`, up to `inlineBytes`) or `staged` (put to an upload-url link first): a plain name,
   *  an accepted type by its bytes that agrees with what was declared, within its kind's cap. */
  async function checkFile(f: unknown, declared: string | undefined, account: string, reportId: string): Promise<Checked | Response> {
    const x = f as Record<string, unknown> | null
    if (!x || typeof x !== 'object' || typeof x.name !== 'string' || !FILE.test(x.name)) return bad('a file name is not a plain file name')
    if (typeof x.type !== 'string') return bad(`${x.name} has no type`)
    const kind = kindOfType(x.type)
    let bytes: Uint8Array | null
    let stagedKey: string | undefined
    if (x.staged !== undefined) {
      if (!opts.staging) return bad(`${x.name} is staged, and this relay has no staging`)
      if (x.staged !== true && x.staged !== x.name) return bad(`${x.name} is staged under another name`)
      stagedKey = stageKey(account, reportId, x.name)
      const heldFor = await usage.staged(stagedKey)
      if (heldFor === null) return bad(`${x.name} was never uploaded; ask upload-url for a link and put it there first`)
      const got = await opts.staging.read(stagedKey)
      if (!got) return bad(`${x.name} was never uploaded; ask upload-url for a link and put it there first`)
      // Read with a counter, stopping past what upload-url held for it (and the kind's own cap).
      const limit = Math.min(heldFor, kindCap(kind))
      bytes = await bytesOf(got, limit)
      if (!bytes) return json(413, { error: `${x.name} is larger than the ${limit} bytes it was given a link for` })
    } else {
      bytes = typeof x.bytes === 'string' ? fromBase64(x.bytes) : null
      if (!bytes || !bytes.length) return bad(`${x.name} is not base64`)
      if (bytes.length > limits.inlineBytes && bytes.length <= kindCap(kind)) {
        return json(413, { error: opts.staging ? `${x.name} is larger than this relay takes in one request; send it staged (upload-url)` : `${x.name} is larger than this relay takes in one request, and it has no staging for larger files` })
      }
    }
    if (!bytes.length) return bad(`${x.name} is empty`)
    const real = sniffType(bytes.subarray(0, 64))
    if (!real || !(ACCEPTED_TYPES as readonly string[]).includes(real)) return json(422, { error: 'the file is not a picture, video or recording this module accepts' })
    if (!sameType(x.type, real) || (declared && !sameType(declared, real))) return json(422, { error: 'the file is not the type it was declared as' })
    const max = kindCap(kind)
    if (bytes.length > max) return json(413, { error: `that file is larger than the ${max} bytes allowed` })
    return { name: x.name, type: real, kind, bytes, ...(stagedKey ? { stagedKey } : {}) }
  }
  /** The bytes a request still has to hold today: inline files only, since upload-url held a staged file's up front. */
  const inlineBytesOf = (files: Checked[]) => files.reduce((n, f) => n + (f.stagedKey ? 0 : f.bytes.length), 0)
  const discardStaged = async (files: Checked[]) => {
    for (const f of files) if (f.stagedKey) { try { await opts.staging?.discard(f.stagedKey); await usage.unstage(f.stagedKey) } catch { /* the bucket's own expiry catches it */ } }
  }
  /** One request's files: each name once, and no more of each kind than a report may carry. */
  const checkMany = async (list: unknown[], declared: (name: unknown) => string | undefined | false, account: string, reportId: string): Promise<Checked[] | Response> => {
    const seen = new Set<string>()
    const out: Checked[] = []
    for (const f of list) {
      const name = (f as { name?: unknown })?.name
      if (typeof name === 'string' && seen.has(name)) return bad(`${name} is listed twice`)
      if (typeof name === 'string') seen.add(name)
      const want = declared(name)
      if (want === false) return bad(`${String(name)} is not a file the report declares`)
      const c = await checkFile(f, want === 'audio/*' ? undefined : want, account, reportId); if (c instanceof Response) return c
      if (want === 'audio/*' && c.kind !== 'voice') return json(422, { error: `${c.name} is a voice note and is not audio` })
      out.push(c)
    }
    const count = (k: Checked['kind']) => out.filter((c) => c.kind === k).length
    if (count('image') > limits.images || count('video') > limits.videos || count('voice') > limits.voice) return bad(`a request carries at most ${limits.images} pictures, ${limits.videos} video and ${limits.voice} recordings`)
    return out
  }

  /** The catch, on the relay, over every string that would reach the issue. A credential refuses by its kind (never its
   *  text). Anything else holds, unless the filer says they redacted: then the relay redacts what it found itself and
   *  answers the clean copy, so raw text is never filed on the filer's word. */
  function catchIt<T extends Record<string, unknown>>(readable: T, account: string, redacted: boolean): { res: Response } | { clean: T } {
    const { hits } = privacyCatch(readable, { people: opts.privacy?.people ?? [], secrets: [...(opts.privacy?.secrets ?? []), account] })
    const creds = hits.filter((h) => h.kind === 'credential')
    if (creds.length) return { res: json(422, { error: `a credential was found in ${[...new Set(creds.map((h) => h.field))].join(', ')}; it is never filed`, kinds: ['credential'] }) }
    if (hits.length && !redacted) return { res: json(409, { held: true, hits: hits.map((h) => ({ kind: h.kind, field: h.field })) }) }
    return { clean: hits.length ? redact(readable, hits) : readable }
  }

  async function readJson(req: Request, cap: number): Promise<Record<string, unknown> | Response> {
    const text = await cappedText(req, cap)
    if (typeof text !== 'string') return text
    try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : bad('the body is not a JSON object') } catch { return bad('the body is not JSON') }
  }

  async function allowed(account: string, repo: string): Promise<Response | null> {
    const list = opts.repos ? await opts.repos(account) : null
    return list && !list.includes(repo) ? json(403, { error: `this account may not file on ${repo}` }) : null
  }

  /** Today's allowance, held atomically for this request: the token to commit or release, or the refusal. */
  async function reserve(account: string, reportId: string, bytes: number): Promise<{ token: string } | Response> {
    const r = await usage.reserve(account, day(), reportId, bytes, { reports: limits.perPersonPerDay, bytes: limits.bytesPerPersonPerDay })
    if (r.ok) return { token: r.token }
    return json(429, { error: r.over === 'reports' ? 'you have reached today\'s limit of suggestions' : 'you have reached today\'s limit of attachments' })
  }

  /** The contact to share: the host's, and only when the request asked (the person left it ticked). */
  const contactFor = (me: RelayIdentity, asked: unknown) => (asked !== undefined && me.contact && !validContact(me.contact).length ? me.contact : undefined)

  async function file(me: RelayIdentity, body: Record<string, unknown>, req: Request): Promise<Response> {
    const account = me.account
    const repo = body.repo
    if (!isRepoName(repo)) return bad('repo is not owner/name')
    const refused = await allowed(account, repo); if (refused) return refused
    const report = body.report as Record<string, unknown> | undefined
    if (!report || typeof report !== 'object') return bad('report is needed')
    const problems = validateReport(report)
    if (problems.length) return json(400, { error: 'the report is not valid', problems })
    const reportId = String(report.id)
    const declared = [...((report.media as { file: string; type: string }[]) ?? []).map((m) => [m.file, m.type] as const), ...((report.voice as { file: string }[]) ?? []).map((v) => [v.file, 'audio/*'] as const)]
    const checked = await checkMany(Array.isArray(body.files) ? body.files : [], (n) => declared.find(([d]) => d === n)?.[1] ?? false, account, reportId)
    if (checked instanceof Response) return checked
    const files = checked
    // The app is the host's: a request names one by its id in the host's table, or none.
    const appId = body.app
    if (appId !== undefined && opts.apps && (typeof appId !== 'string' || !Object.prototype.hasOwnProperty.call(opts.apps, appId))) return bad('unknown app')
    const app = opts.apps && typeof appId === 'string' ? opts.apps[appId] : undefined
    // Who it is from comes from the host, never the request: the name, the role and the contact.
    const contact = contactFor(me, (report.who as { contact?: unknown } | undefined)?.contact)
    const appVersion = typeof (report.diagnostics as { appVersion?: unknown } | undefined)?.appVersion === 'string' ? (report.diagnostics as { appVersion: string }).appVersion : undefined
    const readable = {
      words: report.words, followUps: report.followUps, where: report.where, diagnostics: report.diagnostics,
      context: report.context, transcript: typeof body.transcript === 'string' ? body.transcript : undefined,
      filerName: me.name, appName: app?.name, who: { contact },
      files: files.map((f) => ({ name: f.name })),
    }
    // A hit in a file name cannot be redacted (the file is named by it): it holds the report whatever the filer said.
    const nameHits = privacyCatch({ files: readable.files }, { people: opts.privacy?.people ?? [], secrets: [...(opts.privacy?.secrets ?? []), account] }).hits
    if (nameHits.some((h) => h.kind === 'credential')) return json(422, { error: 'a credential was found in a file name; it is never filed', kinds: ['credential'] })
    if (nameHits.length) return json(409, { held: true, hits: nameHits.map((h) => ({ kind: h.kind, field: h.field })) })
    const caught = catchIt(readable, account, body.redacted === true); if ('res' in caught) return caught.res
    const clean = caught.clean as typeof readable
    const context = clean.context !== undefined || opts.geo ? await withPlace(clean.context, req, opts.geo) : undefined

    if ((await usage.bind(repo, reportId, account)) === 'taken') return json(409, { error: 'that report id is taken; start the suggestion again' })
    // Once per report: a repeat answers the issue it already became.
    const began = await usage.begin(repo, reportId, account, FILING_LEASE_MS)
    if (began.state === 'filed') return began.account === account ? json(200, { number: began.number, url: began.url }) : json(409, { error: 'that report id is taken; start the suggestion again' })
    if (began.state === 'busy') return json(409, { error: 'that report is being filed right now; try again in a moment' })
    const held = await reserve(account, reportId, inlineBytesOf(files))
    if (held instanceof Response) { await usage.abandon(repo, reportId); return held }
    try {
      const token = await repoToken(repo); if (token instanceof Response) { await usage.abandon(repo, reportId); await usage.release(held.token); return token }
      // The files first, so the issue opens complete; a file already there from an interrupted try is its link.
      const host = branchHost({ repo, token, fetch: opts.fetch })
      const attachmentUrls: Record<string, string> = {}
      for (const f of files) attachmentUrls[f.name] = (await host.put({ repo, issue: 0, reportId }, { name: f.name, type: f.type, bytes: f.bytes })).url
      const role = me.role ?? 'member'
      // The report's own app and filer names, if a request put any there, never reach the issue: only the host's do.
      const { appName: _a, filerName: _f, ...plain } = report
      void _a; void _f
      const issue = composeIssue({ ...plain, words: clean.words, where: clean.where, diagnostics: clean.diagnostics, ...(context !== undefined ? { context } : {}), who: { role, ...(clean.who.contact ? { contact: clean.who.contact } : {}) } } as never, {
        appName: typeof clean.appName === 'string' ? clean.appName.slice(0, 100) : undefined,
        appLabel: app ? app.label : null,
        appVersion: appVersion?.slice(0, 50),
        filerName: typeof clean.filerName === 'string' && clean.filerName.trim() ? clean.filerName.trim().slice(0, 100) : 'Someone',
        filerRole: role,
        transcript: clean.transcript,
        attachmentUrls,
      })
      const made = await fileIssue({ repo, token, fetch: opts.fetch, api: opts.api }, issue)
      // The issue exists now. Record it (the store is asked again if it blinks); a filing that made an issue is never
      // abandoned, so a retry answers this issue, or waits out the lease, and never opens a second one.
      const record = { account, reportId, number: made.number, url: made.url }
      for (let attempt = 0; ; attempt++) {
        try { await usage.finish(repo, record); break } catch (e) { if (attempt >= 2) { void e; break } }
      }
      try { await usage.commit(held.token) } catch { /* the day's count is best effort once the issue exists */ }
      await discardStaged(files)
      return json(200, { number: made.number, url: made.url })
    } catch (e) { await usage.abandon(repo, reportId); await usage.release(held.token); return gone(e) }
  }

  async function followUp(me: RelayIdentity, body: Record<string, unknown>): Promise<Response> {
    const account = me.account
    const { repo, number, reportId } = body
    if (!isRepoName(repo)) return bad('repo is not owner/name')
    if (!Number.isInteger(number) || (number as number) < 1) return bad('number is not an issue number')
    if (typeof reportId !== 'string' || !isReportId(reportId)) return bad('reportId is not a report id')
    const refused = await allowed(account, repo); if (refused) return refused
    const rec = await usage.filer(repo, number as number)
    if (!rec || rec.account !== account || rec.reportId !== reportId) return json(403, { error: 'only the person who filed it may add to it' })
    const checked = await checkMany(Array.isArray(body.files) ? body.files : [], () => undefined, account, reportId)
    if (checked instanceof Response) return checked
    const files = checked
    const readable = { words: typeof body.words === 'string' ? body.words.slice(0, 20_000) : '', transcript: typeof body.transcript === 'string' ? body.transcript : undefined, files: files.map((f) => ({ name: f.name })) }
    const caught = catchIt(readable, account, body.redacted === true); if ('res' in caught) return caught.res
    const { words, transcript } = caught.clean
    if (!words.trim() && !transcript && !files.length) return bad('a follow-up needs words or a file')
    // The comment is composed, and measured, BEFORE anything is written: a file's link is known from its path.
    const folder = `attachments/${reportId}`
    const links = files.map((f) => { const url = attachmentUrl(repo, ATTACHMENTS_BRANCH, `${folder}/${f.name}`); return f.kind === 'image' ? `![${f.name}](${url})` : `[${f.name}](${url})` })
    // A follow-up is the person's own words, so it sits in a fence like the words of the report.
    const fenced = (s: string) => { const run = Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length)); const f = '`'.repeat(Math.max(3, run + 1)); return `${f}\n${s}\n${f}` }
    const text = ['## Added later', words.trim() ? fenced(words.trim()) : '', transcript ? `\n### Voice note\n${fenced(transcript.trim())}` : '', links.length ? `\n${links.join('\n')}` : ''].filter(Boolean).join('\n')
    if (text.length > BODY_LIMIT) return json(413, { error: `that follow-up is longer than GitHub takes in a comment (${BODY_LIMIT} characters)` })
    const held = await reserve(account, reportId, inlineBytesOf(files))
    if (held instanceof Response) return held
    try {
      const token = await repoToken(repo); if (token instanceof Response) { await usage.release(held.token); return token }
      // The report's own caps hold across follow-ups, as they do for attach.
      if (files.length) {
        let names: string[] = []
        try { names = ((await github({ ...cfgBase, token }, 'GET', `/repos/${repo}/contents/${folder}?ref=${ATTACHMENTS_BRANCH}`)).body as { name: string }[]).map((x) => x.name) }
        catch (e) { if (!(e instanceof GitHubError) || e.status !== 404) throw e }
        for (const f of files) if (names.includes(f.name)) { await usage.release(held.token); return json(409, { error: `${folder}/${f.name} is already written` }) }
        for (const k of ['image', 'video', 'voice'] as const) {
          const room = k === 'image' ? limits.images : k === 'video' ? limits.videos : limits.voice
          if (names.filter((n) => kindByName(n) === k).length + files.filter((f) => f.kind === k).length > room) { await usage.release(held.token); return json(422, { error: `this report has all the ${k === 'voice' ? 'recordings' : `${k}s`} it can carry` }) }
        }
      }
      const host = branchHost({ repo, token, fetch: opts.fetch })
      for (const f of files) await host.put({ repo, issue: number as number, reportId }, { name: f.name, type: f.type, bytes: f.bytes })
      const got = await addFollowUp({ repo, token, fetch: opts.fetch, api: opts.api }, number as number, text)
      await usage.commit(held.token)
      await discardStaged(files)
      return json(200, got)
    } catch (e) { await usage.release(held.token); return gone(e) }
  }

  async function status(me: RelayIdentity, body: Record<string, unknown>): Promise<Response> {
    const items = Array.isArray(body.items) ? body.items : null
    if (!items || !items.length || items.length > 100) return bad('items is a list of 1 to 100 { repo, number }')
    const list: { repo: string; number: number }[] = []
    for (const it of items) {
      const x = it as { repo?: unknown; number?: unknown }
      if (!isRepoName(x?.repo) || !Number.isInteger(x.number) || (x.number as number) < 1) return bad('an item is not { repo, number }')
      const rec = await usage.filer(x.repo as string, x.number as number)
      if (!rec || rec.account !== me.account) return json(403, { error: 'only the person who filed an issue may ask its state' })
      list.push({ repo: x.repo as string, number: x.number as number })
    }
    try {
      const out: Record<string, unknown>[] = []
      for (const repo of [...new Set(list.map((i) => i.repo))]) {
        const token = await repoToken(repo); if (token instanceof Response) return token
        for (const s of await issueStates({ token, fetch: opts.fetch, api: opts.api }, list.filter((i) => i.repo === repo))) {
          out.push({ repo: s.repo, number: s.number, status: s.missing ? 'missing' : issueStatus(s), ...(s.reason ? { reason: s.reason } : {}) })
        }
      }
      return json(200, { items: out })
    } catch (e) { return gone(e) }
  }


  async function attach(me: RelayIdentity, body: Record<string, unknown>): Promise<Response> {
    const account = me.account
    const { repo, issue, reportId } = body
    if (!isRepoName(repo)) return bad('repo is not owner/name')
    if (!Number.isInteger(issue) || (issue as number) < 1) return bad('issue is not an issue number')
    if (typeof reportId !== 'string' || !isReportId(reportId)) return bad('reportId is not a report id')
    const refused = await allowed(account, repo); if (refused) return refused
    const c = await checkFile(body, undefined, account, reportId); if (c instanceof Response) return c
    // An issue the relay filed belongs to whoever filed it through the relay.
    const mine = await usage.filer(repo, issue as number)
    if (mine && (mine.account !== account || mine.reportId !== reportId)) return json(403, { error: 'this report belongs to someone else' })
    const held = await reserve(account, reportId, inlineBytesOf([c])); if (held instanceof Response) return held
    const fail = async (res: Response) => { await usage.release(held.token); return res }
    try {
      const token = await repoToken(repo); if (token instanceof Response) return fail(token)
      const cfg = { ...cfgBase, token }
      // Proof the caller could file here: the issue exists, is an issue, is open or recently closed, and ends with this report's line.
      let found: { body?: string; pull_request?: unknown; state?: string; closed_at?: string | null; user?: { login?: string } }
      try { found = (await github(cfg, 'GET', `/repos/${repo}/issues/${issue}`)).body }
      catch (e) { if (e instanceof GitHubError && e.status === 404) return fail(json(404, { error: `there is no issue #${issue} on ${repo}` })); throw e }
      if (found.pull_request) return fail(json(403, { error: `#${issue} is a pull request, not an issue` }))
      if (!endsWithFiledBy(String(found.body ?? ''), reportId)) return fail(json(403, { error: `issue #${issue} does not carry Report ${reportId}` }))
      if (found.state === 'closed' && found.closed_at && now() - Date.parse(found.closed_at) > limits.closedGraceMs) return fail(json(403, { error: `issue #${issue} closed too long ago to add to` }))
      // An issue someone opened themselves takes files only from them: the login that opened it must be one this
      // identity vouches for. Nothing is claimed until that proof holds, so a stranger's failed try blocks nobody.
      if (!mine) {
        const opener = String(found.user?.login ?? '').toLowerCase()
        if (!opener || !me.githubLogin || me.githubLogin.toLowerCase() !== opener) return fail(json(403, { error: `only the person who opened issue #${issue} may attach to it` }))
      }
      if ((await usage.bind(repo, reportId, account)) === 'taken') return fail(json(403, { error: 'this report belongs to someone else' }))
      // What the report already holds: never the same path twice, never past its caps.
      const folder = `attachments/${reportId}`
      let names: string[] = []
      try { names = ((await github(cfg, 'GET', `/repos/${repo}/contents/${folder}?ref=${ATTACHMENTS_BRANCH}`)).body as { name: string }[]).map((x) => x.name) }
      catch (e) { if (!(e instanceof GitHubError) || e.status !== 404) throw e }
      if (names.includes(c.name)) return fail(json(409, { error: `${folder}/${c.name} is already written` }))
      const have = names.filter((n) => kindByName(n) === c.kind).length
      const room = c.kind === 'image' ? limits.images : c.kind === 'video' ? limits.videos : limits.voice
      if (have >= room) return fail(json(422, { error: `this report has all the ${c.kind === 'voice' ? 'recordings' : `${c.kind}s`} it can carry` }))
      try {
        await branchHost({ repo, token, fetch: opts.fetch, refuseExisting: true }).put({ repo, issue: issue as number, reportId }, { name: c.name, type: c.type, bytes: c.bytes })
      } catch (e) { if (e instanceof GitHubError && e.status === 409) return fail(json(409, { error: `${folder}/${c.name} is already written` })); throw e }
      await usage.commit(held.token)
      await discardStaged([c])
      return json(200, { url: attachmentUrl(repo, ATTACHMENTS_BRANCH, `${folder}/${c.name}`) })
    } catch (e) { await usage.release(held.token); return gone(e) }
  }

  /** A one-time signed PUT for one file of a report, for a file too large to send inside a request. Bound to this
   *  identity and report like a filing, with the day's bytes held now (the later file or attach does not hold them again). */
  async function uploadUrl(me: RelayIdentity, body: Record<string, unknown>): Promise<Response> {
    const account = me.account
    const { repo, reportId, name, type, bytes } = body
    if (!isRepoName(repo)) return bad('repo is not owner/name')
    if (typeof reportId !== 'string' || !isReportId(reportId)) return bad('reportId is not a report id')
    if (typeof name !== 'string' || !FILE.test(name)) return bad('name is not a plain file name')
    if (typeof type !== 'string' || !(ACCEPTED_TYPES as readonly string[]).includes(canonicalType(type))) return json(422, { error: 'that is not a picture, video or recording this module accepts' })
    if (!Number.isInteger(bytes) || (bytes as number) < 1) return bad("bytes is the file's size")
    const kind = kindOfType(canonicalType(type))
    if ((bytes as number) > kindCap(kind)) return json(413, { error: `${name} is larger than the ${kindCap(kind)} bytes allowed` })
    const refused = await allowed(account, repo); if (refused) return refused
    if ((await usage.bind(repo, reportId, account)) === 'taken') return json(403, { error: 'this report belongs to someone else' })
    const held = await reserve(account, reportId, bytes as number); if (held instanceof Response) return held
    try {
      const key = stageKey(account, reportId, name)
      const link = await opts.staging!.uploadUrl(key, { type: canonicalType(type), bytes: bytes as number })
      await usage.stage(key, bytes as number)
      await usage.commit(held.token)
      return json(200, { url: link.url, headers: link.headers ?? {}, staged: name })
    } catch (e) { await usage.release(held.token); return gone(e) }
  }

  const run: Record<Action, (me: RelayIdentity, body: Record<string, unknown>, req: Request) => Promise<Response>> = { file, 'follow-up': followUp, status, attach, 'upload-url': uploadUrl }
  /** What this relay can take, so a filer knows before it sends (no sign-in needed: it says nothing about anyone). */
  const capabilities = () => json(200, {
    actions: ACTIONS.filter((a) => (only ? a === only : a !== 'upload-url' || Boolean(opts.staging))),
    staging: Boolean(opts.staging),
    inlineBytes: limits.inlineBytes,
    maxBytes: { image: limits.imageBytes, video: limits.videoBytes, voice: limits.voiceBytes },
  })

  return async function relay(req: Request): Promise<Response> {
    // The action is the last segment of the path the handler is mounted on: .../file, .../follow-up, .../status, .../attach.
    const last = new URL(req.url).pathname.replace(/\/+$/, '').split('/').pop() ?? ''
    if (req.method === 'GET' && last === 'capabilities') return capabilities()
    const found = (ACTIONS as readonly string[]).find((a) => a === last && (a !== 'upload-url' || opts.staging)) as Action | undefined
    const action = only ?? found
    if (!action) return json(404, { error: `no such action; use one of ${ACTIONS.join(', ')}` })
    if (req.method !== 'POST') return json(405, { error: 'method not allowed' })
    const me = await opts.identity(req)
    if (!me || typeof me.account !== 'string' || !me.account) return json(401, { error: 'sign in first' })
    const body = await readJson(req, caps[action])
    if (body instanceof Response) return body
    return run[action](me, body, req)
  }
}

/** A relay that only attaches (the 0.2.0 shape): every request is `attach`, whatever its path. */
export const createAttachRelay = (opts: AttachRelayOptions) => createSuggestionRelay(opts, 'attach')
