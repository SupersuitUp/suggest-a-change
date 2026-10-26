// THE GITHUB CALLS. Web-standard fetch only, injectable so tests and any runtime can pass their own. The token is the
// filer's (`gh auth token` on a Mac) or an app server's own; it is sent to api.github.com and nowhere else.
import { composeIssue, type ComposeOptions, type Draft } from './compose.ts'
import type { AttachmentHost, AttachmentFile } from './hosts.ts'

export type Fetch = typeof globalThis.fetch
export interface GitHubConfig { repo: string; token: string; fetch?: Fetch; /** Default https://api.github.com */ api?: string }

export class GitHubError extends Error {
  status: number
  body: unknown
  constructor(message: string, status: number, body: unknown) { super(message); this.name = 'GitHubError'; this.status = status; this.body = body }
}

const API = 'https://api.github.com'
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
function repoOf(repo: string): string {
  if (!REPO.test(repo)) throw new Error(`${JSON.stringify(repo)} is not owner/name`)
  return repo
}

/** One REST call. Answers the parsed body, or throws a GitHubError carrying GitHub's status. */
export async function github(cfg: { token: string; fetch?: Fetch; api?: string }, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const f = cfg.fetch ?? globalThis.fetch
  const res = await f(`${cfg.api ?? API}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${cfg.token}`,
      'x-github-api-version': '2022-11-28',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const textBody = await res.text()
  let parsed: unknown = null
  try { parsed = textBody ? JSON.parse(textBody) : null } catch { parsed = textBody }
  if (!res.ok) throw new GitHubError(`GitHub answered ${res.status} to ${method} ${path}`, res.status, parsed)
  return { status: res.status, body: parsed }
}

const COLORS: Record<string, string> = { bug: 'd73a4a', enhancement: 'a2eeef', feedback: 'c5def5' }

/** Opens one issue. Missing labels are created first; one that exists (422) or that this account may not create
 *  (403/404: a read-only filer) is skipped, and GitHub then keeps only the labels the filer may set. */
export async function fileIssue(cfg: GitHubConfig, issue: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }> {
  const repo = repoOf(cfg.repo)
  for (const name of issue.labels) {
    try { await github(cfg, 'POST', `/repos/${repo}/labels`, { name, color: COLORS[name] ?? 'ededed' }) } catch (e) {
      if (!(e instanceof GitHubError) || ![403, 404, 422].includes(e.status)) throw e
    }
  }
  const got = await github(cfg, 'POST', `/repos/${repo}/issues`, { title: issue.title, body: issue.body, labels: issue.labels })
  return { number: got.body.number, url: got.body.html_url }
}

/** Replaces an issue's body (the filer's own issue: read access is enough to edit what you opened). */
export async function updateIssue(cfg: GitHubConfig, number: number, change: { body: string }): Promise<void> {
  await github(cfg, 'PATCH', `/repos/${repoOf(cfg.repo)}/issues/${number}`, { body: change.body })
}

/** A follow-up the person added later, as a comment on the same issue. */
export async function addFollowUp(cfg: GitHubConfig, number: number, body: string): Promise<{ id: number; url: string }> {
  const got = await github(cfg, 'POST', `/repos/${repoOf(cfg.repo)}/issues/${number}/comments`, { body })
  return { id: got.body.id, url: got.body.html_url }
}

export interface IssueState { repo: string; number: number; state: string | null; stateReason: string | null; /** First line of the last comment, on a closed issue: the reason. */ reason?: string; missing?: true }

/** The state of many issues in one GraphQL call (in chunks of 50). Repo names travel as variables, never in the query. */
export async function issueStates(cfg: { token: string; fetch?: Fetch; api?: string }, issues: { repo: string; number: number }[]): Promise<IssueState[]> {
  const out: IssueState[] = []
  for (let start = 0; start < issues.length; start += 50) {
    const chunk = issues.slice(start, start + 50)
    const vars: Record<string, string | number> = {}
    const decl: string[] = []
    const parts: string[] = []
    chunk.forEach((it, i) => {
      const [owner, name] = repoOf(it.repo).split('/')
      if (!Number.isInteger(it.number) || it.number < 1) throw new Error(`${it.number} is not an issue number`)
      vars[`o${i}`] = owner; vars[`n${i}`] = name; vars[`k${i}`] = it.number
      decl.push(`$o${i}: String!, $n${i}: String!, $k${i}: Int!`)
      parts.push(`i${i}: repository(owner: $o${i}, name: $n${i}) { issue(number: $k${i}) { state stateReason comments(last: 1) { nodes { body } } } }`)
    })
    const query = `query(${decl.join(', ')}) { ${parts.join(' ')} }`
    const got = await github(cfg, 'POST', '/graphql', { query, variables: vars })
    const data = got.body?.data
    if (!data) throw new GitHubError('GitHub answered no data to the issue state query', got.status, got.body)
    chunk.forEach((it, i) => {
      const issue = data[`i${i}`]?.issue
      if (!issue) { out.push({ repo: it.repo, number: it.number, state: null, stateReason: null, missing: true }); return }
      const row: IssueState = { repo: it.repo, number: it.number, state: issue.state, stateReason: issue.stateReason ?? null }
      const last = issue.comments?.nodes?.at(-1)?.body
      const line = typeof last === 'string' ? last.trim().split('\n')[0].trim() : ''
      if (String(issue.state).toUpperCase() === 'CLOSED' && line) row.reason = line
      out.push(row)
    })
  }
  return out
}

/** GitHub's state onto the person's three: open, done (closed as completed), not planned (as not planned, or a duplicate). */
export function issueStatus({ state, stateReason }: { state: string | null; stateReason?: string | null }): 'open' | 'done' | 'not-planned' {
  if (String(state).toUpperCase() !== 'CLOSED') return 'open'
  return ['NOT_PLANNED', 'DUPLICATE'].includes(String(stateReason).toUpperCase()) ? 'not-planned' : 'done'
}

export interface FileSuggestionInput {
  /** The report (redacted already, when the privacy catch asked for it). */
  report: Draft
  compose?: Omit<ComposeOptions, 'attachmentUrls' | 'pending'>
  /** The bytes of the report's media and voice files, by the names the report gives them. */
  files: AttachmentFile[]
  attachments?: AttachmentHost
}
export interface FiledSuggestion { number: number; url: string; attached: Record<string, string>; pending: string[] }

const reportFiles = (r: Draft) => [...(r.media ?? []), ...(r.voice ?? [])].map((f) => f.file)

/** Saves the files the issue is still waiting for, then edits their links into the body. Call again later with the
 *  same `attached` to finish what failed: the issue keeps saying a file is coming until it is there. */
export async function attachPending(cfg: GitHubConfig, input: FileSuggestionInput & { number: number; attached?: Record<string, string> }): Promise<{ attached: Record<string, string>; pending: string[] }> {
  const attached = { ...(input.attached ?? {}) }
  const wanted = new Set(reportFiles(input.report))
  let added = 0
  if (input.attachments) {
    for (const f of input.files) {
      if (!wanted.has(f.name) || attached[f.name]) continue
      try {
        attached[f.name] = (await input.attachments.put({ repo: cfg.repo, issue: input.number, reportId: String(input.report.id), }, f)).url
        added++
      } catch { /* left pending: the issue still says it is coming, and a later call retries it */ }
    }
  }
  if (added) await updateIssue(cfg, input.number, { body: composeIssue(input.report, { ...input.compose, attachmentUrls: attached }).body })
  return { attached, pending: [...wanted].filter((n) => !attached[n]) }
}

/** The whole filing, in the order that never shows an incomplete issue as complete: open the issue saying what is being
 *  added (opening it is the proof the filer can file there), save each file against that issue, then edit the links in. */
export async function fileSuggestion(cfg: GitHubConfig, input: FileSuggestionInput): Promise<FiledSuggestion> {
  const hasFiles = reportFiles(input.report).length > 0
  const first = composeIssue(input.report, { ...input.compose, pending: hasFiles })
  const issue = await fileIssue(cfg, first)
  if (!hasFiles) return { ...issue, attached: {}, pending: [] }
  const rest = await attachPending(cfg, { ...input, number: issue.number })
  return { ...issue, ...rest }
}
