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
import { CEILINGS, isReportId, validateReport } from '../contract.mjs'
import { cappedText, json } from '../server/http.ts'
import { ACCEPTED_TYPES, sameType, sniffType } from '../server/sniff.ts'
import { withPlace, type GeoHook } from '../server/geo.ts'
import { addFollowUp, fileIssue, github, GitHubError, issueStates, issueStatus, type Fetch } from './api.ts'
import { composeIssue } from './compose.ts'
import { ATTACHMENTS_BRANCH, attachmentUrl, branchHost } from './hosts.ts'
import { privacyCatch, type Person } from './privacy.ts'

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
}
export const RELAY_LIMITS: RelayLimits = {
  perPersonPerDay: CEILINGS.perPersonPerDay,
  bytesPerPersonPerDay: 300 * 2 ** 20,
  images: CEILINGS.images, imageBytes: CEILINGS.imageBytes,
  videos: CEILINGS.videos, videoBytes: CEILINGS.videoBytes,
  voice: 60, voiceBytes: RELAY_VOICE_BYTES,
  closedGraceMs: 7 * 24 * 3600_000,
}

export interface FiledRecord { account: string; reportId: string; number: number; url: string }
/** What the relay remembers. Every method is atomic in a real store (one transaction or a conditional write). */
export interface RelayUsage {
  /** Records that `account` used `reportId` on `day` (YYYY-MM-DD); answers how many different reports it has that day. */
  touch(account: string, day: string, reportId: string): Promise<number>
  /** Whether `account` already used `reportId` on `day`, and how many different reports it has that day. */
  peek(account: string, day: string, reportId: string): Promise<{ known: boolean; count: number }>
  /** Adds bytes sent by `account` on `day`; answers the day's total. */
  addBytes(account: string, day: string, n: number): Promise<number>
  bytes(account: string, day: string): Promise<number>
  /** Starts filing a report, first caller wins: 'go', or 'busy' while another filing of it runs, or the record of the issue it already became. */
  begin(repo: string, reportId: string, account: string): Promise<{ state: 'go' } | { state: 'busy' } | ({ state: 'filed' } & FiledRecord)>
  /** The filing that began succeeded: keep the record, by report and by issue number. */
  finish(repo: string, record: FiledRecord): Promise<void>
  /** The filing that began failed: forget it, so a retry can begin again. */
  abandon(repo: string, reportId: string): Promise<void>
  /** Who filed this issue through the relay, or null. */
  filer(repo: string, number: number): Promise<FiledRecord | null>
}
/** In memory, so ONE SERVER INSTANCE ONLY: a platform that runs several instances (most serverless hosts) needs a store
 *  backed by its database, or the caps, the idempotency and who-filed-what are per instance and lost on restart. */
export function memoryUsage(): RelayUsage {
  const days = new Map<string, Set<string>>()
  const bytes = new Map<string, number>()
  const filings = new Map<string, { state: 'busy' } | ({ state: 'filed' } & FiledRecord)>()
  const issues = new Map<string, FiledRecord>()
  const set = (a: string, d: string) => { const k = `${a}\u0000${d}`; let s = days.get(k); if (!s) days.set(k, (s = new Set())); return s }
  return {
    async touch(a, d, r) { const s = set(a, d); s.add(r); return s.size },
    async peek(a, d, r) { const s = set(a, d); return { known: s.has(r), count: s.size } },
    async addBytes(a, d, n) { const k = `${a}\u0000${d}`; const t = (bytes.get(k) ?? 0) + n; bytes.set(k, t); return t },
    async bytes(a, d) { return bytes.get(`${a}\u0000${d}`) ?? 0 },
    async begin(repo, r) { const k = `${repo}#${r}`; const had = filings.get(k); if (had) return had; filings.set(k, { state: 'busy' }); return { state: 'go' } },
    async finish(repo, rec) { filings.set(`${repo}#${rec.reportId}`, { state: 'filed', ...rec }); issues.set(`${repo}#${rec.number}`, rec) },
    async abandon(repo, r) { const k = `${repo}#${r}`; if (filings.get(k)?.state === 'busy') filings.delete(k) },
    async filer(repo, n) { return issues.get(`${repo}#${n}`) ?? null },
  }
}

export interface SuggestionRelayOptions {
  /** The GitHub App the relay acts as: its numeric id and its private key (PEM, PKCS#1 as GitHub issues it, or PKCS#8). */
  app: { id: number | string; privateKey: string }
  /** Who is calling, from the request (a session, an API key, whatever the server already uses), or null. */
  identity(req: Request): Promise<{ account: string } | null>
  /** The repos this identity may file on; null (or no function) means any repo the App is installed on. */
  repos?(account: string): string[] | null | Promise<string[] | null>
  /** What the privacy catch looks for besides credentials, emails and phones: third parties, and secrets the host knows. */
  privacy?: { people?: Person[]; secrets?: string[] }
  /** Roughly where the filer was, from the request (see the server half's geo hooks); added to the issue's context. */
  geo?: GeoHook
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

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const B64 = /^[A-Za-z0-9+/]+={0,2}$/
const ACTIONS = ['file', 'follow-up', 'status', 'attach'] as const
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

type Checked = { name: string; type: string; kind: 'image' | 'video' | 'voice'; bytes: Uint8Array }

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
  // One file at the largest size the limits allow, base64, plus room for the rest; `file` may carry a report's worth.
  const oneCap = Math.ceil(Math.max(limits.imageBytes, limits.videoBytes, limits.voiceBytes) / 3) * 4 + 64 * 1024
  const reportCap = Math.ceil((limits.images * limits.imageBytes + limits.videos * limits.videoBytes + 10 * limits.voiceBytes) / 3) * 4 + 512 * 1024
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

  /** One file: a plain name, real base64, an accepted type by its bytes that agrees with what was declared, within its cap. */
  function checkFile(f: unknown, declared?: string): Checked | Response {
    const x = f as Record<string, unknown> | null
    if (!x || typeof x !== 'object' || typeof x.name !== 'string' || !FILE.test(x.name)) return bad('a file name is not a plain file name')
    if (typeof x.type !== 'string') return bad(`${x.name} has no type`)
    const bytes = typeof x.bytes === 'string' ? fromBase64(x.bytes) : null
    if (!bytes || !bytes.length) return bad(`${x.name} is not base64`)
    const real = sniffType(bytes.subarray(0, 64))
    if (!real || !(ACCEPTED_TYPES as readonly string[]).includes(real)) return json(422, { error: 'the file is not a picture, video or recording this module accepts' })
    if (!sameType(x.type, real) || (declared && !sameType(declared, real))) return json(422, { error: 'the file is not the type it was declared as' })
    const kind = x.type.startsWith('audio/') ? 'voice' : kindOf(real)
    const max = kind === 'image' ? limits.imageBytes : kind === 'video' ? limits.videoBytes : limits.voiceBytes
    if (bytes.length > max) return json(413, { error: `that file is larger than the ${max} bytes allowed` })
    return { name: x.name, type: real, kind, bytes }
  }

  /** The catch, on the relay: a credential refuses by its kind (never its text); anything else holds unless redacted. */
  function catchIt(readable: Record<string, unknown>, account: string, redacted: boolean): Response | null {
    const { hits } = privacyCatch(readable, { people: opts.privacy?.people ?? [], secrets: [...(opts.privacy?.secrets ?? []), account] })
    const creds = hits.filter((h) => h.kind === 'credential')
    if (creds.length) return json(422, { error: `a credential was found in ${[...new Set(creds.map((h) => h.field))].join(', ')}; it is never filed`, kinds: ['credential'] })
    if (hits.length && !redacted) return json(409, { held: true, hits: hits.map((h) => ({ kind: h.kind, field: h.field })) })
    return null
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

  async function overDay(account: string, reportId: string, bytes: number): Promise<Response | null> {
    const seen = await usage.peek(account, day(), reportId)
    if (!seen.known && seen.count >= limits.perPersonPerDay) return json(429, { error: 'you have reached today\'s limit of suggestions' })
    if ((await usage.bytes(account, day())) + bytes > limits.bytesPerPersonPerDay) return json(429, { error: 'you have reached today\'s limit of attachments' })
    return null
  }

  async function file(account: string, body: Record<string, unknown>, req: Request): Promise<Response> {
    const repo = body.repo
    if (typeof repo !== 'string' || !REPO.test(repo)) return bad('repo is not owner/name')
    const refused = await allowed(account, repo); if (refused) return refused
    const report = body.report as Record<string, unknown> | undefined
    if (!report || typeof report !== 'object') return bad('report is needed')
    const problems = validateReport(report)
    if (problems.length) return json(400, { error: 'the report is not valid', problems })
    const reportId = String(report.id)
    const declared = [...((report.media as { file: string; type: string }[]) ?? []).map((m) => [m.file, m.type] as const), ...((report.voice as { file: string }[]) ?? []).map((v) => [v.file, 'audio/*'] as const)]
    const files: Checked[] = []
    for (const f of Array.isArray(body.files) ? body.files : []) {
      const want = declared.find(([n]) => n === (f as { name?: unknown })?.name)
      if (!want) return bad(`${String((f as { name?: unknown })?.name)} is not a file the report declares`)
      const c = checkFile(f, want[1] === 'audio/*' ? undefined : want[1]); if (c instanceof Response) return c
      if (want[1] === 'audio/*' && c.kind !== 'voice') return json(422, { error: `${c.name} is a voice note and is not audio` })
      files.push(c)
    }
    const transcript = typeof body.transcript === 'string' ? body.transcript : undefined
    // The catch reads the context too, and knows the sender's own contact is theirs to share.
    const held = catchIt({ words: report.words, transcript, followUps: report.followUps, context: report.context, who: { contact: (report.who as { contact?: unknown } | undefined)?.contact } }, account, body.redacted === true); if (held) return held
    if (report.context !== undefined || opts.geo) report.context = await withPlace(report.context, req, opts.geo)

    // Once per report: a repeat answers the issue it already became; nobody else may use the id.
    const began = await usage.begin(repo, reportId, account)
    if (began.state === 'filed') return began.account === account ? json(200, { number: began.number, url: began.url }) : json(409, { error: 'that report id is taken; start the suggestion again' })
    if (began.state === 'busy') return json(409, { error: 'that report is being filed right now; try again in a moment' })
    try {
      const total = files.reduce((n, f) => n + f.bytes.length, 0)
      const over = await overDay(account, reportId, total); if (over) { await usage.abandon(repo, reportId); return over }
      const token = await repoToken(repo); if (token instanceof Response) { await usage.abandon(repo, reportId); return token }
      // The files first, so the issue opens complete; a file already there from an interrupted try is its link.
      const host = branchHost({ repo, token, fetch: opts.fetch })
      const attachmentUrls: Record<string, string> = {}
      for (const f of files) attachmentUrls[f.name] = (await host.put({ repo, issue: 0, reportId }, { name: f.name, type: f.type, bytes: f.bytes })).url
      // The account id never reaches the issue; the sender's own contact does, because they chose to share it.
      const who = (report.who ?? {}) as { role?: string; contact?: unknown }
      const issue = composeIssue({ ...report, who: { role: who.role, ...(who.contact ? { contact: who.contact } : {}) } } as never, {
        appName: typeof body.appName === 'string' ? body.appName.slice(0, 100) : undefined,
        appVersion: typeof body.appVersion === 'string' ? body.appVersion.slice(0, 50) : undefined,
        filerName: typeof body.filerName === 'string' && body.filerName.trim() ? body.filerName.trim().slice(0, 100) : 'Someone',
        filerRole: who.role,
        transcript,
        attachmentUrls,
      })
      const made = await fileIssue({ repo, token, fetch: opts.fetch, api: opts.api }, issue)
      await usage.finish(repo, { account, reportId, number: made.number, url: made.url })
      await usage.touch(account, day(), reportId)
      await usage.addBytes(account, day(), total)
      return json(200, { number: made.number, url: made.url })
    } catch (e) { await usage.abandon(repo, reportId); return gone(e) }
  }

  async function followUp(account: string, body: Record<string, unknown>): Promise<Response> {
    const { repo, number, reportId } = body
    if (typeof repo !== 'string' || !REPO.test(repo)) return bad('repo is not owner/name')
    if (!Number.isInteger(number) || (number as number) < 1) return bad('number is not an issue number')
    if (typeof reportId !== 'string' || !isReportId(reportId)) return bad('reportId is not a report id')
    const words = typeof body.words === 'string' ? body.words.slice(0, 20_000) : ''
    const rec = await usage.filer(repo, number as number)
    if (!rec || rec.account !== account || rec.reportId !== reportId) return json(403, { error: 'only the person who filed it may add to it' })
    const files: Checked[] = []
    for (const f of Array.isArray(body.files) ? body.files : []) { const c = checkFile(f); if (c instanceof Response) return c; files.push(c) }
    const transcript = typeof body.transcript === 'string' ? body.transcript : undefined
    const held = catchIt({ words, transcript }, account, body.redacted === true); if (held) return held
    if (!words.trim() && !transcript && !files.length) return bad('a follow-up needs words or a file')
    const total = files.reduce((n, f) => n + f.bytes.length, 0)
    const over = await overDay(account, reportId, total); if (over) return over
    try {
      const token = await repoToken(repo); if (token instanceof Response) return token
      const host = branchHost({ repo, token, fetch: opts.fetch })
      const links: string[] = []
      for (const f of files) {
        const { url } = await host.put({ repo, issue: number as number, reportId }, { name: f.name, type: f.type, bytes: f.bytes })
        links.push(f.kind === 'image' ? `![${f.name}](${url})` : `[${f.name}](${url})`)
      }
      const text = ['## Added later', words.trim(), transcript ? `\n### Voice note\n${transcript.trim()}` : '', links.length ? `\n${links.join('\n')}` : ''].filter(Boolean).join('\n')
      const got = await addFollowUp({ repo, token, fetch: opts.fetch, api: opts.api }, number as number, text)
      await usage.addBytes(account, day(), total)
      return json(200, got)
    } catch (e) { return gone(e) }
  }

  async function status(account: string, body: Record<string, unknown>): Promise<Response> {
    const items = Array.isArray(body.items) ? body.items : null
    if (!items || !items.length || items.length > 100) return bad('items is a list of 1 to 100 { repo, number }')
    const list: { repo: string; number: number }[] = []
    for (const it of items) {
      const x = it as { repo?: unknown; number?: unknown }
      if (typeof x?.repo !== 'string' || !REPO.test(x.repo) || !Number.isInteger(x.number) || (x.number as number) < 1) return bad('an item is not { repo, number }')
      const rec = await usage.filer(x.repo, x.number as number)
      if (!rec || rec.account !== account) return json(403, { error: 'only the person who filed an issue may ask its state' })
      list.push({ repo: x.repo, number: x.number as number })
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

  async function attach(account: string, body: Record<string, unknown>): Promise<Response> {
    const { repo, issue, reportId } = body
    if (typeof repo !== 'string' || !REPO.test(repo)) return bad('repo is not owner/name')
    if (!Number.isInteger(issue) || (issue as number) < 1) return bad('issue is not an issue number')
    if (typeof reportId !== 'string' || !isReportId(reportId)) return bad('reportId is not a report id')
    const c = checkFile(body); if (c instanceof Response) return c
    const refused = await allowed(account, repo); if (refused) return refused
    const over = await overDay(account, reportId, c.bytes.length); if (over) return over
    try {
      const token = await repoToken(repo); if (token instanceof Response) return token
      const cfg = { ...cfgBase, token }
      // Proof the caller could file here: the issue exists, is an issue, is open or recently closed, and carries this report.
      let found: { body?: string; pull_request?: unknown; state?: string; closed_at?: string | null }
      try { found = (await github(cfg, 'GET', `/repos/${repo}/issues/${issue}`)).body }
      catch (e) { if (e instanceof GitHubError && e.status === 404) return json(404, { error: `there is no issue #${issue} on ${repo}` }); throw e }
      if (found.pull_request) return json(403, { error: `#${issue} is a pull request, not an issue` })
      if (!new RegExp(`(^|[^A-Za-z0-9-])Report ${reportId}(?![A-Za-z0-9-])`).test(String(found.body ?? ''))) return json(403, { error: `issue #${issue} does not carry Report ${reportId}` })
      if (found.state === 'closed' && found.closed_at && now() - Date.parse(found.closed_at) > limits.closedGraceMs) return json(403, { error: `issue #${issue} closed too long ago to add to` })
      // What the report already holds: never the same path twice, never past its caps.
      const folder = `attachments/${reportId}`
      let names: string[] = []
      try { names = ((await github(cfg, 'GET', `/repos/${repo}/contents/${folder}?ref=${ATTACHMENTS_BRANCH}`)).body as { name: string }[]).map((x) => x.name) }
      catch (e) { if (!(e instanceof GitHubError) || e.status !== 404) throw e }
      if (names.includes(c.name)) return json(409, { error: `${folder}/${c.name} is already written` })
      const have = names.filter((n) => kindByName(n) === c.kind).length
      const room = c.kind === 'image' ? limits.images : c.kind === 'video' ? limits.videos : limits.voice
      if (have >= room) return json(422, { error: `this report has all the ${c.kind === 'voice' ? 'recordings' : `${c.kind}s`} it can carry` })
      try {
        await branchHost({ repo, token, fetch: opts.fetch, refuseExisting: true }).put({ repo, issue: issue as number, reportId }, { name: c.name, type: c.type, bytes: c.bytes })
      } catch (e) { if (e instanceof GitHubError && e.status === 409) return json(409, { error: `${folder}/${c.name} is already written` }); throw e }
      await usage.touch(account, day(), reportId)
      await usage.addBytes(account, day(), c.bytes.length)
      return json(200, { url: attachmentUrl(repo, ATTACHMENTS_BRANCH, `${folder}/${c.name}`) })
    } catch (e) { return gone(e) }
  }

  const run: Record<Action, (account: string, body: Record<string, unknown>, req: Request) => Promise<Response>> = { file, 'follow-up': followUp, status, attach }

  return async function relay(req: Request): Promise<Response> {
    // The action is the last segment of the path the handler is mounted on: .../file, .../follow-up, .../status, .../attach.
    const last = new URL(req.url).pathname.replace(/\/+$/, '').split('/').pop() ?? ''
    const action = only ?? (ACTIONS as readonly string[]).find((a) => a === last) as Action | undefined
    if (!action) return json(404, { error: `no such action; use one of ${ACTIONS.join(', ')}` })
    if (req.method !== 'POST') return json(405, { error: 'method not allowed' })
    const me = await opts.identity(req)
    if (!me || typeof me.account !== 'string' || !me.account) return json(401, { error: 'sign in first' })
    const body = await readJson(req, action === 'file' ? reportCap : oneCap)
    if (body instanceof Response) return body
    return run[action](me.account, body, req)
  }
}

/** A relay that only attaches (the 0.2.0 shape): every request is `attach`, whatever its path. */
export const createAttachRelay = (opts: AttachRelayOptions) => createSuggestionRelay(opts, 'attach')
