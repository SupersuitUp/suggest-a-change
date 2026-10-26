// ONE PLAIN ISSUE, AND THE LIST OF WHAT GOES INTO IT (suggestions-as-github-issues design, sections 1 and 2).
// `pieces` decides what a report carries; `whatGoes` says it in the sheet's words and `composeIssue` writes it into
// the body, both from that one decision, so the sheet can never promise less than the issue carries. No model is
// involved: the body is the person's own words and the facts the app stamped, laid out the same way every time.

export type Piece = 'words' | 'voice' | 'images' | 'video' | 'where' | 'app' | 'device' | 'time' | 'filer'
export interface Destination {
  /** owner/name of the repo the issue files on. */
  repo: string
  /** True for a public repo: the sheet says so in the danger colour. */
  public: boolean
  /** The GitHub login the issue is filed from. */
  account: string
  /** False when files cannot reach this repo yet (no App installed and the filer cannot push): they wait. */
  attaches: boolean
  /** False when nobody transcribes voice notes (an app's own server): the list does not promise a transcript. */
  transcribes?: boolean
}
/** What composeIssue and whatGoes read: a report in the contract's shape, plus two optional names for the list. */
export interface Draft {
  id?: string
  kind?: string
  words?: string
  who?: { member?: string; role?: string }
  voice?: { file: string; ms?: number }[]
  media?: { file: string; type: string; bytes?: number; ms?: number }[]
  where?: { screen?: string; route?: string }
  diagnostics?: { appVersion?: string; at?: string; device?: string; screen?: string; [k: string]: unknown }
  /** The sender's name as the issue will say it (the list's "your name, ..."). */
  filerName?: string
  /** The app's name, for the list's "Helm 2.14.0". */
  appName?: string
  [k: string]: unknown
}
export interface ComposeOptions {
  appName?: string
  appVersion?: string
  filerName?: string
  filerRole?: string
  /** file name -> its link, from an AttachmentHost. A file with no link yet is written as still being added. */
  attachmentUrls?: Record<string, string>
  /** The voice notes' transcript, made on the owner's Mac. */
  transcript?: string
  /** The first body, written before any file is saved: every attachment is "being added". */
  pending?: boolean
}
export interface ComposedIssue { title: string; body: string; labels: string[]; carries: Piece[] }

/** GitHub refuses a body of 65536 characters or more; this leaves room. */
export const BODY_LIMIT = 65_000
const LABEL: Record<string, string> = { change: 'enhancement', broken: 'bug', feedback: 'feedback' }
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

const isImage = (m: { type: string }) => String(m.type).startsWith('image/')
const isVideo = (m: { type: string }) => String(m.type).startsWith('video/')
const text = (v: unknown) => (typeof v === 'string' ? v : '')
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const list = (parts: string[]) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`)

/** Which pieces a report carries, in the order the issue and the list both use. */
export function pieces(d: Draft): Piece[] {
  const media = d.media ?? []
  const g = d.diagnostics ?? {}
  const out: Piece[] = []
  if (text(d.words).trim()) out.push('words')
  if ((d.voice ?? []).length) out.push('voice')
  if (media.some(isImage)) out.push('images')
  if (media.some(isVideo)) out.push('video')
  if (text(d.where?.screen) || text(d.where?.route)) out.push('where')
  if (text(g.appVersion)) out.push('app')
  if (text(g.device) || text(g.screen)) out.push('device')
  if (text(g.at)) out.push('time')
  out.push('filer')
  return out
}

/** The sheet's list, in plain words, one item per piece the issue will carry. */
export function whatGoes(draft: Draft, destination: Destination): { key: Piece; text: string }[] {
  const media = draft.media ?? []
  const g = draft.diagnostics ?? {}
  const kept = destination.attaches
    ? `saved to the suggestion-attachments branch of ${destination.repo}`
    : `added once ${destination.repo} can take attachments`
  const voices = (draft.voice ?? []).length
  const say: Record<Piece, () => string> = {
    words: () => 'your words',
    voice: () => destination.transcribes === false
      ? (voices === 1 ? 'your voice note' : `your ${voices} voice notes`)
      : (voices === 1 ? 'your voice note and its transcript' : `your ${voices} voice notes and their transcripts`),
    images: () => `${plural(media.filter(isImage).length, 'screenshot')}, ${kept}`,
    video: () => `${plural(media.filter(isVideo).length, 'video')}, ${kept}`,
    where: () => `this screen (${[text(draft.where?.screen), text(draft.where?.route)].filter(Boolean).join(', ')})`,
    app: () => `${draft.appName || 'the app'} ${text(g.appVersion)}`,
    device: () => [text(g.device), text(g.screen)].filter(Boolean).join(', '),
    time: () => 'the time',
    filer: () => (draft.filerName ? `your name, ${draft.filerName}` : 'that it came from you'),
  }
  return pieces(draft).map((key) => ({ key, text: say[key]() }))
}

/** The lines around the list: where it files, who can read it there, and whose account files it. */
export function destinationWords(d: Destination): { headline: string; privacy: string; danger: boolean; account: string } {
  return {
    headline: `Sending this files an issue on ${d.repo}`,
    privacy: d.public ? 'public: anyone on the internet can read this' : `private: people with access to ${d.repo}'s code can read it`,
    danger: Boolean(d.public),
    account: `Filed from ${d.account}'s GitHub account.`,
  }
}

/** "2026-10-26T17:04:12Z" -> "2026-10-26 17:04 UTC"; anything unreadable as it is. */
function when(at: string): string {
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return at
  const iso = new Date(t).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}
function firstSentence(s: string): string {
  const line = s.trim().split('\n')[0].trim()
  const m = /^.*?[.!?](?=\s|$)/.exec(line)
  return (m ? m[0] : line).trim()
}
function clip(s: string, max: number): string {
  if (s.length <= max) return s
  let cut = s.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  if (space > max / 2) cut = cut.slice(0, space)
  return `${cut.trimEnd()}…`
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

export function composeIssue(report: Draft, opts: ComposeOptions = {}): ComposedIssue {
  // Never the sender's account key or an email, whatever the words say: the privacy catch should have held them, and this is the floor.
  const key = text(report.who?.member)
  const scrub = (s: string) => {
    let out = s.replace(EMAIL, '[removed]')
    if (key.length >= 12) out = out.split(key).join('[removed]')
    return out
  }
  const words = scrub(text(report.words).trim())
  const transcript = scrub(text(opts.transcript).trim())
  const urls = opts.pending ? {} : (opts.attachmentUrls ?? {})
  const media = report.media ?? []
  const voice = report.voice ?? []
  const g = report.diagnostics ?? {}
  const appName = opts.appName ?? report.appName
  const has = new Set(pieces(report))
  const carries = pieces(report)

  // Everything not yet linked, counted, so the issue never claims to be complete before it is.
  const missing = [...media, ...voice].filter((f) => !urls[f.file])
  const waitImages = media.filter((m) => isImage(m) && !urls[m.file]).length
  const waitVideos = media.filter((m) => isVideo(m) && !urls[m.file]).length
  const waitVoice = voice.filter((v) => !urls[v.file]).length
  const coming = missing.length
    ? `${list([waitImages ? plural(waitImages, 'screenshot') : '', waitVideos ? plural(waitVideos, 'video') : '', waitVoice ? plural(waitVoice, 'voice recording') : ''].filter(Boolean))} ${missing.length === 1 ? 'is' : 'are'} being added.`
    : ''

  const build = (said: string, heard: string): string => {
    const out: string[] = []
    if (has.has('words')) out.push('## What they said', said, '')
    if (has.has('voice')) {
      out.push(transcript ? "## Voice note (transcribed on the owner's Mac)" : '## Voice note', heard || 'Not transcribed.')
      const links = voice.filter((v) => urls[v.file]).map((v) => `[${v.file}](${urls[v.file]})`)
      if (links.length) out.push('', ...links)
      if (coming && !has.has('images') && !has.has('video')) out.push('', coming)
      out.push('')
    }
    if (has.has('images') || has.has('video')) {
      out.push('## Screenshots')
      for (const m of media) {
        const u = urls[m.file]
        if (!u) continue
        out.push(isImage(m) ? `![${m.file}](${u})` : `[${m.file}](${u})`)
      }
      if (coming) out.push(coming)
      out.push('')
    }
    if (has.has('where')) {
      out.push('## Where', [text(report.where?.screen) && `Screen: ${text(report.where?.screen)}`, text(report.where?.route) && `Route: ${text(report.where?.route)}`].filter(Boolean).join(' · '), '')
    }
    if (has.has('app') || has.has('device') || has.has('time')) {
      const about = [
        has.has('app') ? `App: ${appName ? `${appName} ` : ''}${text(g.appVersion)}` : '',
        text(g.device) ? `Device: ${text(g.device)}` : '',
        text(g.screen) ? `Screen ${text(g.screen)}` : '',
        has.has('time') ? `Sent ${when(text(g.at))}` : '',
      ].filter(Boolean)
      out.push('## About', about.join(' · '), '')
    }
    const role = opts.filerRole ?? text(report.who?.role) ?? 'member'
    // "Report <id>" is exact on purpose: the attachment relay reads the issue and requires this line before it saves a file.
    out.push('## Filed by', `${opts.filerName ?? report.filerName ?? 'A member'} (${role || 'member'}), through Suggest a change in the ${appName || 'app'}. Report ${text(report.id)}.`)
    return out.join('\n')
  }

  let said = words
  let heard = transcript
  let body = build(said, heard)
  // Too long for GitHub: the transcript gives way first, then the words, each with a note saying where it was cut.
  if (body.length > BODY_LIMIT && heard) {
    const keep = Math.max(0, heard.length - (body.length - BODY_LIMIT) - 200)
    heard = `${heard.slice(0, keep)}\n\n(The transcript was cut here at ${keep} characters to fit GitHub's limit; the recording itself is attached.)`
    body = build(said, heard)
  }
  if (body.length > BODY_LIMIT && said) {
    const keep = Math.max(0, said.length - (body.length - BODY_LIMIT) - 200)
    said = `${said.slice(0, keep)}\n\n(Their words were cut here at ${keep} characters to fit GitHub's limit.)`
    body = build(said, heard)
  }

  const title = clip(firstSentence(words) || firstSentence(transcript) || `Suggestion from ${appName || 'an app'}`, 70)
  const labels = [LABEL[text(report.kind)] ?? 'feedback', ...(appName ? [`app:${slug(appName)}`] : [])]
  return { title, body, labels, carries }
}
