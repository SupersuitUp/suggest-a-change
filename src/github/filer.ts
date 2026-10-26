// THE FILER'S SIDE OF A SUGGESTION RELAY. `relayFiler` talks to any relay running `createSuggestionRelay`, at whatever
// URL it is mounted on and with whatever header it checks. `canFileDirectly` says whether a filer's own token can see
// the repo (and so open an issue there); `fileSuggestion` uses it to choose between filing directly and the relay.
import { github, GitHubError, type Fetch } from './api.ts'
import { toBase64 } from './hosts.ts'

export interface RelayFile { name: string; type: string; bytes: Uint8Array | ArrayBuffer | string }
export interface RelayFiling {
  repo: string
  /** Which of the relay's apps this came from, by its id in the relay's own table (the relay names it and labels it). */
  app?: string
  /** The report, in the contract's shape. The relay never writes the account id into the issue. */
  report: Record<string, unknown>
  /** The name the issue says it was filed by. */
  filerName?: string
  appName?: string
  appVersion?: string
  transcript?: string
  files?: RelayFile[]
  /** True once the filer chose to file without what the privacy catch flagged (they replaced it themselves). */
  redacted?: boolean
}
export interface RelayFiler {
  /** Answers the issue; a repeat of the same report answers the same issue. A held report throws status 409 with `{ held, hits }`. */
  file(input: RelayFiling): Promise<{ number: number; url: string }>
  followUp(input: { repo: string; number: number; reportId: string; words?: string; transcript?: string; files?: RelayFile[]; redacted?: boolean }): Promise<{ id: number; url: string }>
  status(items: { repo: string; number: number }[]): Promise<{ repo: string; number: number; status: string; reason?: string }[]>
  /** What the relay can take (asked once, then kept). */
  capabilities(): Promise<RelayCapabilities>
}

const files64 = (files: RelayFile[] = []) => files.map((f) => ({ name: f.name, type: f.type, bytes: typeof f.bytes === 'string' ? f.bytes : toBase64(f.bytes) }))
/** Files larger than this go to the relay staged (one signed PUT each) rather than inside the request. */
export const STAGE_OVER_BYTES = 2 * 2 ** 20
const sizeOf = (b: RelayFile['bytes']) => (typeof b === 'string' ? Math.floor((b.length * 3) / 4) : b instanceof Uint8Array ? b.length : b.byteLength)
const raw = (b: RelayFile['bytes']): Uint8Array => {
  if (b instanceof Uint8Array) return b
  if (b instanceof ArrayBuffer) return new Uint8Array(b)
  const bin = atob(b); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out
}
export interface RelayCapabilities { actions: string[]; staging: boolean; inlineBytes: number; maxBytes?: Record<string, number> }

/** `url` is where the relay is mounted; each action is posted to `<url>/<action>`. */
export function relayFiler({ url, headers = {}, fetch }: { url: string; headers?: Record<string, string>; fetch?: Fetch }): RelayFiler {
  if (!/^https?:\/\//.test(url)) throw new Error(`${JSON.stringify(url)} is not a relay URL`)
  const base = url.replace(/\/+$/, '')
  const f = fetch ?? globalThis.fetch
  const call = async (action: string, body: unknown) => {
    const res = await f(`${base}/${action}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const text = await res.text()
    let parsed: any = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
    if (!res.ok) throw new GitHubError(`the suggestion relay answered ${res.status} to ${action}`, res.status, parsed)
    return parsed
  }
  let caps: Promise<RelayCapabilities> | null = null
  const capabilities = () => (caps ??= (async () => {
    const res = await f(`${base}/capabilities`, { method: 'GET', headers })
    if (!res.ok) throw new GitHubError(`the suggestion relay answered ${res.status} to capabilities`, res.status, null)
    return (await res.json()) as RelayCapabilities
  })().catch((e) => { caps = null; throw e }))
  /** Each file inline, or, past STAGE_OVER_BYTES, put to a link from upload-url first and named as staged. A file the
   *  relay cannot take at all is refused here, in words, before anything is filed. */
  async function prepare(repo: string, reportId: string, files: RelayFile[] = []) {
    if (!files.some((x) => sizeOf(x.bytes) > STAGE_OVER_BYTES)) return files64(files)
    const c = await capabilities()
    const out: Record<string, unknown>[] = []
    for (const x of files) {
      const size = sizeOf(x.bytes)
      if (size <= Math.min(STAGE_OVER_BYTES, c.inlineBytes)) { out.push(...files64([x])); continue }
      if (!c.staging) throw new Error(`${x.name} is larger than this relay takes in one request (${Math.round(c.inlineBytes / 2 ** 20)} MB), and it has no staging for larger files`)
      const link = (await call('upload-url', { repo, reportId, name: x.name, type: x.type, bytes: size })) as { url: string; headers?: Record<string, string> }
      const put = await f(link.url, { method: 'PUT', headers: link.headers ?? {}, body: raw(x.bytes) as BodyInit })
      if (!put.ok) throw new GitHubError(`the staging upload of ${x.name} answered ${put.status}`, put.status, null)
      out.push({ name: x.name, type: x.type, staged: x.name })
    }
    return out
  }
  return {
    capabilities,
    async file(input) { return call('file', { ...input, files: await prepare(input.repo, String(input.report.id), input.files) }) },
    async followUp(input) { return call('follow-up', { ...input, files: await prepare(input.repo, input.reportId, input.files) }) },
    async status(items) { return (await call('status', { items })).items },
  }
}

/** True when this token can see the repo, so it can open an issue there itself; false on 401, 403 or 404 (or issues off). */
export async function canFileDirectly({ repo, token, fetch, api }: { repo: string; token: string; fetch?: Fetch; api?: string }): Promise<boolean> {
  try {
    const got = await github({ token, fetch, api }, 'GET', `/repos/${repo}`)
    return got.body?.has_issues !== false
  } catch (e) {
    if (e instanceof GitHubError && [401, 403, 404].includes(e.status)) return false
    throw e
  }
}
