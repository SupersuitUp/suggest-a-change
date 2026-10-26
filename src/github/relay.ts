// RUN YOUR OWN ATTACHMENT RELAY. Most people who can file an issue on a repo cannot push to it, so their screenshots
// could never reach their issues. A relay is one route on a server the repo's owner runs, holding the private key of a
// GitHub App the owner created (contents: write, issues: read) and installed on that repo. The filer's machine opens
// the issue itself, then sends each file here with the issue number; the relay proves the caller could file there by
// reading that issue, and writes the file to one place only: attachments/<report id>/<file> on the
// suggestion-attachments branch. Web-standard only: Request, Response, fetch, crypto.subtle.
import { CEILINGS, isReportId } from '../contract.mjs'
import { cappedText, json } from '../server/http.ts'
import { ACCEPTED_TYPES, sameType, sniffType } from '../server/sniff.ts'
import { github, GitHubError, type Fetch } from './api.ts'
import { ATTACHMENTS_BRANCH, attachmentUrl, branchHost } from './hosts.ts'

/** A voice recording's ceiling; the same number as the server half's VOICE_FILE_BYTES (a test holds them together). */
export const RELAY_VOICE_BYTES = 25 * 2 ** 20
export interface RelayLimits {
  /** Different reports one account may attach to in a day. */
  perPersonPerDay: number
  images: number
  imageBytes: number
  videos: number
  videoBytes: number
  /** Recordings per report: the report's voice notes and those added to it later. */
  voice: number
  voiceBytes: number
  /** How long after an issue closed a file may still be added to it. */
  closedGraceMs: number
}
export const RELAY_LIMITS: RelayLimits = {
  perPersonPerDay: CEILINGS.perPersonPerDay,
  images: CEILINGS.images, imageBytes: CEILINGS.imageBytes,
  videos: CEILINGS.videos, videoBytes: CEILINGS.videoBytes,
  voice: 60, voiceBytes: RELAY_VOICE_BYTES,
  closedGraceMs: 7 * 24 * 3600_000,
}

/** Which reports each account attached to today. The default lives in memory, which is per server instance: on a
 *  platform that runs many instances, pass one backed by your database. */
export interface RelayUsage {
  /** Records that `account` attached to `reportId` on `day` (YYYY-MM-DD) and answers how many different reports it now has that day. */
  touch(account: string, day: string, reportId: string): Promise<number>
  /** Answers whether `account` already attached to `reportId` on `day`, and how many different reports it has that day. */
  peek(account: string, day: string, reportId: string): Promise<{ known: boolean; count: number }>
}
export function memoryUsage(): RelayUsage {
  const days = new Map<string, Set<string>>()
  const set = (a: string, d: string) => { const k = `${a}\u0000${d}`; let s = days.get(k); if (!s) days.set(k, (s = new Set())); return s }
  return {
    async touch(a, d, r) { const s = set(a, d); s.add(r); return s.size },
    async peek(a, d, r) { const s = set(a, d); return { known: s.has(r), count: s.size } },
  }
}

export interface AttachRelayOptions {
  /** The GitHub App the relay acts as: its numeric id and its private key (PEM, PKCS#1 as GitHub issues it, or PKCS#8). */
  app: { id: number | string; privateKey: string }
  /** Who is calling, from the request (a session, an API key, whatever the server already uses), or null. */
  identity(req: Request): Promise<{ account: string } | null>
  /** May lower any limit, never raise one. */
  limits?: Partial<RelayLimits>
  usage?: RelayUsage
  fetch?: Fetch
  now?: () => number
  /** Default https://api.github.com */
  api?: string
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const B64 = /^[A-Za-z0-9+/]+={0,2}$/

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

export function createAttachRelay(opts: AttachRelayOptions): (req: Request) => Promise<Response> {
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
  let key: Promise<CryptoKey> | null = null
  // A base64 body for the largest file the limits allow, plus room for the other fields.
  const cap = Math.ceil(Math.max(limits.imageBytes, limits.videoBytes, limits.voiceBytes) / 3) * 4 + 64 * 1024
  const bad = (error: string) => json(400, { error })

  return async function attach(req: Request): Promise<Response> {
    if (req.method !== 'POST') return json(405, { error: 'method not allowed' })
    const me = await opts.identity(req)
    if (!me || typeof me.account !== 'string' || !me.account) return json(401, { error: 'sign in first' })
    const text = await cappedText(req, cap)
    if (typeof text !== 'string') return text
    let body: Record<string, unknown>
    try { body = JSON.parse(text) } catch { return bad('the body is not JSON') }
    if (!body || typeof body !== 'object') return bad('the body is not a JSON object')
    const { repo, issue, reportId, name, type } = body as Record<string, unknown>
    if (typeof repo !== 'string' || !REPO.test(repo)) return bad('repo is not owner/name')
    if (!Number.isInteger(issue) || (issue as number) < 1) return bad('issue is not an issue number')
    if (typeof reportId !== 'string' || !isReportId(reportId)) return bad('reportId is not a report id')
    if (typeof name !== 'string' || !FILE.test(name)) return bad('name is not a plain file name')
    if (typeof type !== 'string') return bad('type is needed')
    const bytes = typeof body.bytes === 'string' ? fromBase64(body.bytes) : null
    if (!bytes || !bytes.length) return bad('bytes is not base64')

    // What it really is, by its bytes; what it says it is must agree.
    const real = sniffType(bytes.subarray(0, 64))
    if (!real || !(ACCEPTED_TYPES as readonly string[]).includes(real)) return json(422, { error: 'the file is not a picture, video or recording this module accepts' })
    if (!sameType(type, real)) return json(422, { error: 'the file is not the type it was declared as' })
    const kind = type.startsWith('audio/') ? 'voice' : kindOf(real)
    const max = kind === 'image' ? limits.imageBytes : kind === 'video' ? limits.videoBytes : limits.voiceBytes
    if (bytes.length > max) return json(413, { error: `that file is larger than the ${max} bytes allowed` })

    const day = new Date(now()).toISOString().slice(0, 10)
    const seen = await usage.peek(me.account, day, reportId)
    if (!seen.known && seen.count >= limits.perPersonPerDay) return json(429, { error: 'you have reached today\'s limit of suggestions' })

    try {
      // The App's installation on this repo, and a token for this one repo only.
      key ??= importKey(opts.app.privateKey)
      const jwt = await appJwt(await key, id, now())
      let installation: number
      try { installation = (await github({ ...cfgBase, token: jwt }, 'GET', `/repos/${repo}/installation`)).body.id }
      catch (e) { if (e instanceof GitHubError && e.status === 404) return json(403, { error: `the app is not installed on ${repo}` }); throw e }
      const token = (await github({ ...cfgBase, token: jwt }, 'POST', `/app/installations/${installation}/access_tokens`, { repositories: [repo.split('/')[1]] })).body.token as string
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
      if (names.includes(name)) return json(409, { error: `${folder}/${name} is already written` })
      const have = names.filter((n) => kindByName(n) === kind).length
      const room = kind === 'image' ? limits.images : kind === 'video' ? limits.videos : limits.voice
      if (have >= room) return json(422, { error: `this report has all the ${kind === 'voice' ? 'recordings' : `${kind}s`} it can carry` })

      try {
        await branchHost({ repo, token, fetch: opts.fetch, refuseExisting: true }).put({ repo, issue: issue as number, reportId }, { name, type: real, bytes })
      } catch (e) { if (e instanceof GitHubError && e.status === 409) return json(409, { error: `${folder}/${name} is already written` }); throw e }
      await usage.touch(me.account, day, reportId)
      return json(200, { url: attachmentUrl(repo, ATTACHMENTS_BRANCH, `${folder}/${name}`) })
    } catch (e) {
      return json(502, { error: 'GitHub could not be reached or refused the relay; try again', ...(e instanceof GitHubError ? { status: e.status } : {}) })
    }
  }
}
