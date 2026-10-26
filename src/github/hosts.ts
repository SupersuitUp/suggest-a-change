// WHERE A SCREENSHOT OR RECORDING GOES (design: "Attachment parity for every filer"). GitHub has no API for attaching a
// file to an issue, so each file is committed to the repo's own `suggestion-attachments` branch and linked: it shows to
// exactly the people who can read the repo, and to nobody else. Two hosts ship: one for a filer that can push, one
// through the repo owner's own GitHub App, by way of a suggestion relay, for everyone who cannot.
import { isRepoName } from '../contract.mjs'
import { github, GitHubError, type Fetch } from './api.ts'

/** Which issue a file belongs to. The relay reads that issue and requires it to carry `Report <reportId>`. */
export interface AttachmentTarget { repo: string; issue: number; reportId: string }
export interface AttachmentFile { name: string; type: string; bytes: Uint8Array | ArrayBuffer }
export interface AttachmentHost { put(target: AttachmentTarget, file: AttachmentFile): Promise<{ url: string }> }

export const ATTACHMENTS_BRANCH = 'suggestion-attachments'
/** Up to this size a file goes through the contents API; past it, through the git data API (blob, tree, commit). */
export const CONTENTS_API_BYTES = 1_000_000
const REPORT_ID = /^r-\d{14}-[a-z0-9]{6}$/
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
/** Base64 with no dependency and no reliance on btoa's string rules. */
export function toBase64(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let out = ''
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=')
  }
  return out
}

/** Refuses anything that would write outside attachments/<report id>/<file>. */
function pathFor(t: AttachmentTarget, name: string): string {
  if (!isRepoName(t.repo)) throw new Error(`${JSON.stringify(t.repo)} is not owner/name`)
  if (!REPORT_ID.test(String(t.reportId))) throw new Error(`${JSON.stringify(t.reportId)} is not a report id`)
  if (!FILE.test(name)) throw new Error(`${JSON.stringify(name)} is not a plain file name`)
  return `attachments/${t.reportId}/${name}`
}
/** The link form that renders inline in a private issue, for the people who can read the repo. */
export const attachmentUrl = (repo: string, branch: string, path: string) => `https://github.com/${repo}/blob/${branch}/${path}?raw=true`

/** Commits each file through the contents API with a token that can push (a maintainer's Mac, an app server's own key).
 *  The branch is made the first time, as an orphan that shares no history with the code. A path already written is its link. */
export function branchHost({ repo, token, branch = ATTACHMENTS_BRANCH, fetch, refuseExisting = false }: { repo: string; token: string; branch?: string; fetch?: Fetch; /** Throw (409) instead of answering the link when the path is already written. */ refuseExisting?: boolean }): AttachmentHost {
  const cfg = { token, fetch }
  let ready: Promise<void> | null = null
  const ensure = () => (ready ??= (async () => {
    try { await github(cfg, 'GET', `/repos/${repo}/git/ref/heads/${branch}`); return } catch (e) { if (!(e instanceof GitHubError) || e.status !== 404) throw e }
    const tree = await github(cfg, 'POST', `/repos/${repo}/git/trees`, { tree: [{ path: 'README.md', mode: '100644', type: 'blob', content: 'Screenshots and recordings attached to suggestions filed as issues on this repo, one folder per report. Nothing here is code.\n' }] })
    const commit = await github(cfg, 'POST', `/repos/${repo}/git/commits`, { message: 'Start the suggestion attachments branch', tree: tree.body.sha, parents: [] })
    try { await github(cfg, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.body.sha }) } catch (e) { if (!(e instanceof GitHubError) || e.status !== 422) throw e }
  })().catch((e) => { ready = null; throw e }))
  /** A file past the contents API's comfortable size, through the git data API: a blob, a tree on top of the branch's
   *  own, a commit, and the branch moved to it (once more if another write moved it first). Up to GitHub's 100 MB. */
  async function putLarge(path: string, file: AttachmentFile, reportId: string) {
    try {
      await github(cfg, 'GET', `/repos/${repo}/contents/${path}?ref=${branch}`)
      if (refuseExisting) throw new GitHubError(`${path} is already written`, 409, null)
      return // written once: its link stands
    } catch (e) { if (!(e instanceof GitHubError) || e.status !== 404) throw e }
    const blob = (await github(cfg, 'POST', `/repos/${repo}/git/blobs`, { content: toBase64(file.bytes), encoding: 'base64' })).body.sha as string
    for (let attempt = 0; ; attempt++) {
      const head = (await github(cfg, 'GET', `/repos/${repo}/git/ref/heads/${branch}`)).body.object.sha as string
      const base = (await github(cfg, 'GET', `/repos/${repo}/git/commits/${head}`)).body.tree.sha as string
      const tree = (await github(cfg, 'POST', `/repos/${repo}/git/trees`, { base_tree: base, tree: [{ path, mode: '100644', type: 'blob', sha: blob }] })).body.sha as string
      const commit = (await github(cfg, 'POST', `/repos/${repo}/git/commits`, { message: `Attach ${file.name} to ${reportId}`, tree, parents: [head] })).body.sha as string
      try { await github(cfg, 'PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit }); return }
      catch (e) { if (!(e instanceof GitHubError) || e.status !== 422 || attempt >= 2) throw e } // someone else moved the branch: build on theirs
    }
  }
  return {
    async put(target, file) {
      if (target.repo !== repo) throw new Error(`this host writes to ${repo}, not ${target.repo}`)
      const path = pathFor(target, file.name)
      await ensure()
      const size = file.bytes instanceof Uint8Array ? file.bytes.length : file.bytes.byteLength
      if (size > CONTENTS_API_BYTES) {
        await putLarge(path, file, target.reportId)
        return { url: attachmentUrl(repo, branch, path) }
      }
      try {
        await github(cfg, 'PUT', `/repos/${repo}/contents/${path}`, { message: `Attach ${file.name} to ${target.reportId}`, content: toBase64(file.bytes), branch })
      } catch (e) {
        if (!(e instanceof GitHubError) || e.status !== 422) throw e // 422: already there, written once
        if (refuseExisting) throw new GitHubError(`${path} is already written`, 409, e.body)
      }
      return { url: attachmentUrl(repo, branch, path) }
    },
  }
}

/** For a filer who cannot push: the file goes to an attachment relay (any URL running `createAttachRelay`, with whatever
 *  header proves who is asking), which checks the named issue carries this report, saves the file through its own
 *  GitHub App, and answers the link. */
export function relayHost({ url, headers = {}, fetch }: { url: string; headers?: Record<string, string>; fetch?: Fetch }): AttachmentHost {
  const f = fetch ?? globalThis.fetch
  if (!/^https?:\/\//.test(url)) throw new Error(`${JSON.stringify(url)} is not a relay URL`)
  return {
    async put(target, file) {
      pathFor(target, file.name)
      const res = await f(url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ repo: target.repo, issue: target.issue, reportId: target.reportId, name: file.name, type: file.type, bytes: toBase64(file.bytes) }),
      })
      const text = await res.text()
      let body: any = null
      try { body = text ? JSON.parse(text) : null } catch { body = text }
      if (!res.ok) throw new GitHubError(`the attachment relay answered ${res.status}`, res.status, body)
      if (typeof body?.url !== 'string' || !body.url.startsWith(`https://github.com/${target.repo}/`)) throw new Error('the attachment relay did not answer a github.com link in this repo')
      return { url: body.url }
    },
  }
}
