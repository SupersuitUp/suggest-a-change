// ONE PLAIN ISSUE, AND THE LIST OF WHAT GOES INTO IT (suggestions-as-github-issues design, sections 1 and 2).
// `pieces` decides what a report carries; `whatGoes` says it in the sheet's words and `composeIssue` writes it into
// the body, both from that one decision, so the sheet can never promise less than the issue carries. No model is
// involved: the body is the person's own words and the facts the app stamped, laid out the same way every time.

/** A piece the report carries. `ctx:<key>` is one context item; routes, taps and errors are the trail; contact is how to reach them. */
export type Piece = 'words' | 'voice' | 'images' | 'video' | 'where' | 'app' | 'device' | 'time' | 'routes' | 'taps' | 'errors' | 'contact' | 'filer' | `ctx:${string}`
export interface ContextItem { key: string; label: string; value: string; why: string }
export interface DraftContext {
  items?: ContextItem[]
  routes?: { route: string; at: string }[]
  taps?: { label: string; at: string }[]
  errors?: { message: string; frame?: string; at: string }[]
}
export interface Contact { email?: string; phone?: string; handle?: string }
/** One line of the sheet's list. `optional` rows can be left out; `on` is whether they go by default, `reason` why not. */
export interface GoesItem { key: Piece; text: string; value?: string; why?: string; optional?: boolean; on?: boolean; reason?: string }
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
  /** The largest file this destination takes; a larger one is named in the list as staying on the phone. */
  maxInlineBytes?: number
}
/** What composeIssue and whatGoes read: a report in the contract's shape, plus two optional names for the list. */
export interface Draft {
  id?: string
  kind?: string
  words?: string
  who?: { member?: string; role?: string; contact?: Contact }
  /** Everything else shared so it can be fixed (the module's `collectContext`, and the app's own items). */
  context?: DraftContext
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
  /** The app label's host-given name (`app:<appLabel>`); null for none. Without it the label is made from appName. */
  appLabel?: string | null
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

const contactOf = (d: Draft): Contact | null => {
  const c = d.who?.contact
  return c && (c.email || c.phone || c.handle) ? c : null
}
/** Whether a report carries context; with it, the context table stands in for the About line. */
const hasContext = (d: Draft) => Boolean(d.context && ((d.context.items ?? []).length || (d.context.routes ?? []).length || (d.context.taps ?? []).length || (d.context.errors ?? []).length))

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
  if (hasContext(d)) {
    for (const i of d.context!.items ?? []) out.push(`ctx:${i.key}`)
    if ((d.context!.routes ?? []).length) out.push('routes')
    if ((d.context!.taps ?? []).length) out.push('taps')
    if ((d.context!.errors ?? []).length) out.push('errors')
  } else {
    if (text(g.device) || text(g.screen)) out.push('device')
    if (text(g.at)) out.push('time')
  }
  if (contactOf(d)) out.push('contact')
  out.push('filer')
  return out
}

export const TRAIL_WORDS = {
  routes: { label: 'Pages you visited before this', heading: 'Pages visited before this', why: 'so the fixer can retrace how you got here' },
  taps: { label: 'Your last taps', heading: 'Last taps', why: 'so the fixer can repeat what you did, by what the buttons are called; never what you typed' },
  errors: { label: 'Errors the page hit', heading: 'Errors on the page', why: 'the error the app hit is often the fastest way to the cause' },
}
export const CONTACT_WHY = 'so whoever fixes it can thank you or ask a follow-up question'
export const PUBLIC_CONTACT_REASON = 'this repo is public, so anyone could read it'
const contactValue = (c: Contact) => [c.email, c.phone, c.handle].filter(Boolean).join(' · ')

/** The sheet's list, in plain words, one item per piece the issue will carry, with the value and why for each piece
 *  of context. Anything but what the person added, the app's version and their name can be left out (`optional`). */
export function whatGoes(draft: Draft, destination: Destination): GoesItem[] {
  const ctxItems = new Map((draft.context?.items ?? []).map((i) => [`ctx:${i.key}`, i]))
  const contact = contactOf(draft)
  const trailCount = (k: 'routes' | 'taps' | 'errors') => (draft.context?.[k] ?? []).length
  const trailUnit = { routes: 'page', taps: 'tap', errors: 'error' } as const
  return basicGoes(draft, destination).map((g) => {
    const c = ctxItems.get(g.key)
    if (c) return { key: g.key, text: c.label, value: c.value, why: c.why, optional: true, on: true }
    if (g.key === 'routes' || g.key === 'taps' || g.key === 'errors') {
      const w = TRAIL_WORDS[g.key]
      return { key: g.key, text: w.label, value: plural(trailCount(g.key), trailUnit[g.key]), why: w.why, optional: true, on: true }
    }
    if (g.key === 'contact' && contact) {
      return { key: g.key, text: 'How to reach you', value: contactValue(contact), why: CONTACT_WHY, optional: true, on: !destination.public, ...(destination.public ? { reason: PUBLIC_CONTACT_REASON } : {}) }
    }
    return g
  })
}

function basicGoes(draft: Draft, destination: Destination): GoesItem[] {
  const media = draft.media ?? []
  const g = draft.diagnostics ?? {}
  const kept = destination.attaches
    ? `saved to the suggestion-attachments branch of ${destination.repo}`
    : `added once ${destination.repo} can take attachments`
  const voices = (draft.voice ?? []).length
  // A file the destination cannot take is said so in advance, by name, before anything is sent.
  const max = destination.maxInlineBytes
  const mb = (n: number) => (n < 2 ** 20 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${Math.round((n / 2 ** 20) * 10) / 10} MB`)
  const tooBig = (files: { file: string; bytes?: number }[]) => {
    const over = max ? files.filter((m) => (m.bytes ?? 0) > max) : []
    return over.length ? `; ${list(over.map((m) => m.file))} ${over.length === 1 ? 'is' : 'are'} over the ${mb(max!)} ${destination.repo} can take, so ${over.length === 1 ? 'it does' : 'they do'} not reach the issue` : ''
  }
  const say: Record<string, () => string> = {
    words: () => 'your words',
    voice: () => destination.transcribes === false
      ? (voices === 1 ? 'your voice note' : `your ${voices} voice notes`)
      : (voices === 1 ? 'your voice note and its transcript' : `your ${voices} voice notes and their transcripts`),
    images: () => `${plural(media.filter(isImage).length, 'screenshot')}, ${kept}${tooBig(media.filter(isImage))}`,
    video: () => `${plural(media.filter(isVideo).length, 'video')}, ${kept}${tooBig(media.filter(isVideo))}`,
    where: () => `this screen (${[text(draft.where?.screen), text(draft.where?.route)].filter(Boolean).join(', ')})`,
    app: () => `${draft.appName || 'the app'} ${text(g.appVersion)}`,
    device: () => [text(g.device), text(g.screen)].filter(Boolean).join(', '),
    time: () => 'the time',
    filer: () => (draft.filerName ? `your name, ${draft.filerName}` : 'that it came from you'),
  }
  return pieces(draft).map((key) => ({ key, text: say[key]?.() ?? key }))
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
  if (!Number.isFinite(t)) return inline(at) // not a time: shown, escaped, as any other line
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
/** Text that cannot become markup in the issue. */
const html = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** A table cell: no markup, no pipe that ends the cell, on one line. */
const cell = (s: string) => inline(s).replace(/\|/g, '\\|')
/** One line of report-borne text, made inert: no HTML, no emphasis, code, link or image syntax, no @mention, no #123
 *  reference, on one line. Every string a report brings that is not inside a fence goes through this. */
const inline = (s: string) => html(String(s)).replace(/[\\`*_[\]~!]/g, '\\$&').replace(/@(?=[\w-])/g, '@\u200d').replace(/#(?=\d)/g, '#\u200d').replace(/\r?\n/g, ' ')
/** Text a person wrote, shown as they wrote it inside a fence longer than any backtick run in it, so nothing in it renders. */
const fence = (s: string) => {
  const run = Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length))
  const f = '`'.repeat(Math.max(3, run + 1))
  return `${f}\n${s}\n${f}`
}
/** Link text with no markdown of its own (an email address keeps its @: it is not a mention inside link text). */
const linkText = (s: string) => html(String(s)).replace(/[\\`*_[\]~!]/g, '\\$&').replace(/\r?\n/g, ' ')
/** Only an https link with nothing that could end or break the link may become one; anything else is not linked. */
const safeUrl = (u: unknown): string | null => (typeof u === 'string' && /^https:\/\/[^\s()<>"'`]+$/.test(u) ? u : null)
/** THE LAST LINE OF EVERY ISSUE, written and recognized by these two and nothing else: a relay accepts an attachment for
 *  a report only on an issue that ends with this line for it, so the writer and the reader must never drift apart. */
export const FILED_BY = '## Filed by'
export function filedByLine(filer: string, role: string, appName: string | undefined, reportId: string): string {
  return `${inline(filer)} (${inline(role)}), through Suggest a change in ${appName ? `the ${inline(appName)}` : 'an app'}. Report ${inline(reportId)}.`
}
/** Whether an issue's body ends with the composer's own Filed by line for this report, in either of its forms. */
export function endsWithFiledBy(body: string, reportId: string): boolean {
  if (!/^r-\d{14}-[a-z0-9]{6}$/.test(reportId)) return false
  const lines = String(body).replace(/\s+$/, '').split('\n')
  const last = lines[lines.length - 1] ?? ''
  return lines[lines.length - 2]?.trim() === FILED_BY && new RegExp(`^\\S.* \\(.+\\), through Suggest a change in (the .+|an app)\\. Report ${reportId}\\.$`).test(last)
}
/** "2026-10-26T17:04:05Z" -> "17:04:05 UTC"; anything else as it is. */
const clock = (at: string) => { const t = Date.parse(at); return Number.isFinite(t) ? `${new Date(t).toISOString().slice(11, 19)} UTC` : inline(String(at)) }
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
  // Only links the host produced, and only plain https ones, become images or links; anything else is still "being added".
  const urls: Record<string, string> = opts.pending ? {} : Object.fromEntries(Object.entries(opts.attachmentUrls ?? {}).flatMap(([k, u]) => (safeUrl(u) ? [[k, u]] : [])))
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

  type TrailCut = { routes: number; taps: number; errors: number }
  const full = { routes: report.context?.routes ?? [], taps: report.context?.taps ?? [], errors: report.context?.errors ?? [] }
  const contact = contactOf(report)
  // The trail is kept newest-last; a cut keeps the newest.
  const shown = (k: keyof TrailCut, cut: TrailCut) => full[k].slice(cut[k])
  const build = (said: string, heard: string, cut: TrailCut = { routes: 0, taps: 0, errors: 0 }): string => {
    const out: string[] = []
    if (has.has('words')) out.push('## What they said', fence(said), '')
    if (has.has('voice')) {
      out.push(transcript ? "## Voice note (transcribed on the owner's Mac)" : '## Voice note', heard ? fence(heard) : 'Not transcribed.')
      const links = voice.filter((v) => urls[v.file]).map((v) => `[${inline(v.file)}](${urls[v.file]})`)
      if (links.length) out.push('', ...links)
      if (coming && !has.has('images') && !has.has('video')) out.push('', coming)
      out.push('')
    }
    if (has.has('images') || has.has('video')) {
      out.push('## Screenshots')
      for (const m of media) {
        const u = urls[m.file]
        if (!u) continue
        out.push(isImage(m) ? `![${inline(m.file)}](${u})` : `[${inline(m.file)}](${u})`)
      }
      if (coming) out.push(coming)
      out.push('')
    }
    if (has.has('where')) {
      out.push('## Where', [text(report.where?.screen) && `Screen: ${inline(text(report.where?.screen))}`, text(report.where?.route) && `Route: ${inline(text(report.where?.route))}`].filter(Boolean).join(' · '), '')
    }
    if (hasContext(report)) {
      out.push('## Context (shared so this can be fixed)', '', '| What | Value | Why |', '| --- | --- | --- |')
      if (has.has('app')) out.push(`| App | ${cell(`${appName ? `${appName} ` : ''}${text(g.appVersion)}`)} | so the fixer works on the same version you have |`)
      for (const i of report.context!.items ?? []) out.push(`| ${cell(i.label)} | ${cell(i.value)} | ${cell(i.why)} |`)
      out.push('')
      const block = (k: keyof TrailCut, line: (x: never) => string) => {
        if (!has.has(k)) return
        const rows = shown(k, cut)
        out.push(`<details><summary>${TRAIL_WORDS[k].heading} (${full[k].length})</summary>`, '')
        if (cut[k]) out.push(`(The ${cut[k]} oldest were cut to fit GitHub's limit.)`, '')
        out.push(...rows.map((x) => line(x as never)), '', '</details>', '')
      }
      block('routes', (r: { route: string; at: string }) => `- ${clock(r.at)} ${inline(r.route)}`)
      block('taps', (t: { label: string; at: string }) => `- ${clock(t.at)} ${inline(t.label)}`)
      block('errors', (e: { message: string; frame?: string; at: string }) => `- ${clock(e.at)} ${inline(e.message)}${e.frame ? `\n  ${inline(e.frame)}` : ''}`)
    } else if (has.has('app') || has.has('device') || has.has('time')) {
      const about = [
        has.has('app') ? `App: ${inline(`${appName ? `${appName} ` : ''}${text(g.appVersion)}`)}` : '',
        text(g.device) ? `Device: ${inline(text(g.device))}` : '',
        text(g.screen) ? `Screen ${inline(text(g.screen))}` : '',
        has.has('time') ? `Sent ${when(text(g.at))}` : '',
      ].filter(Boolean)
      out.push('## About', about.join(' · '), '')
    }
    if (has.has('contact') && contact) {
      const ways = [
        contact.email ? `[${linkText(contact.email)}](mailto:${encodeURIComponent(contact.email).replace(/%40/g, '@')})` : '',
        contact.phone ? `[${linkText(contact.phone)}](tel:${contact.phone.replace(/[^\d+]/g, '')})` : '',
        contact.handle ? inline(contact.handle) : '',
      ].filter(Boolean)
      out.push('## Reach them', 'To thank them or ask a follow-up question:', '', ...ways.map((w) => `- ${w}`), '')
    }
    const role = opts.filerRole ?? text(report.who?.role) ?? 'member'
    // "Report <id>" is exact on purpose: the attachment relay reads the issue and requires this line before it saves a file.
    out.push(FILED_BY, filedByLine(opts.filerName ?? report.filerName ?? 'A member', role || 'member', appName, text(report.id)))
    return out.join('\n')
  }

  let said = words
  let heard = transcript
  const cut: TrailCut = { routes: 0, taps: 0, errors: 0 }
  let body = build(said, heard, cut)
  // Too long for GitHub: the trail gives way first (taps, then pages, then errors, oldest first), then the transcript,
  // then the words, each with a note saying it was cut to fit.
  for (const k of ['taps', 'routes', 'errors'] as const) {
    while (body.length > BODY_LIMIT && cut[k] < full[k].length) {
      cut[k] += Math.max(1, Math.ceil((full[k].length - cut[k]) / 2))
      body = build(said, heard, cut)
    }
  }
  if (body.length > BODY_LIMIT && heard) {
    const keep = Math.max(0, heard.length - (body.length - BODY_LIMIT) - 200)
    heard = `${heard.slice(0, keep)}\n\n(The transcript was cut here at ${keep} characters to fit GitHub's limit; the recording itself is attached.)`
    body = build(said, heard, cut)
  }
  if (body.length > BODY_LIMIT && said) {
    const keep = Math.max(0, said.length - (body.length - BODY_LIMIT) - 200)
    said = `${said.slice(0, keep)}\n\n(Their words were cut here at ${keep} characters to fit GitHub's limit.)`
    body = build(said, heard, cut)
  }

  // A title is plain text on GitHub; it still never pings anyone or links an issue.
  const title = clip(firstSentence(words) || firstSentence(transcript) || `Suggestion from ${appName || 'an app'}`, 70).replace(/@(?=[\w-])/g, '@‍').replace(/#(?=\d)/g, '#‍')
  const appLabel = opts.appLabel === null ? '' : opts.appLabel !== undefined ? slug(opts.appLabel) : appName ? slug(appName) : ''
  const labels = [LABEL[text(report.kind)] ?? 'feedback', ...(appLabel ? [`app:${appLabel}`] : [])]
  return { title, body, labels, carries }
}
