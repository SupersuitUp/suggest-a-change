// THE FILER'S SIDE OF A SUGGESTION RELAY. `relayFiler` talks to any relay running `createSuggestionRelay`, at whatever
// URL it is mounted on and with whatever header it checks. `canFileDirectly` says whether a filer's own token can see
// the repo (and so open an issue there); `fileSuggestion` uses it to choose between filing directly and the relay.
import { github, GitHubError, type Fetch } from './api.ts'
import { toBase64 } from './hosts.ts'

export interface RelayFile { name: string; type: string; bytes: Uint8Array | ArrayBuffer | string }
export interface RelayFiling {
  repo: string
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
}

const files64 = (files: RelayFile[] = []) => files.map((f) => ({ name: f.name, type: f.type, bytes: typeof f.bytes === 'string' ? f.bytes : toBase64(f.bytes) }))

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
  return {
    async file(input) { return call('file', { ...input, files: files64(input.files) }) },
    async followUp(input) { return call('follow-up', { ...input, files: files64(input.files) }) },
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
