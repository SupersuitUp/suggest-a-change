// EVERY WORD A PERSON READS THAT THE CONTRACT DOES NOT ALREADY OWN. The status words and their meanings
// live in contract.mjs (`wordsFor`, `meaningFor`); the receipt lines, the sheet's labels and the
// button come from design section 2. The owner's name and the app's name are passed in by the host,
// never written here. An app may replace any string through `words.text`.
import { CEILINGS, meaningFor, wordsFor } from '../contract.mjs'

export interface Words {
  /** A short id for the app. It names the draft on the phone, so it may not contain ":". */
  app: string
  /** The owner's first name, as the receipt says it ("Alex"). */
  owner: string
  /** Replaces any string below. */
  text?: Partial<Strings>
}

export interface Strings {
  entry: string
  reportProblem: string
  signedOut: string
  signedOutMine: string
  sheetTitle: string
  close: string
  kindLegend: string
  kindChange: string
  kindBroken: string
  kindFeedback: string
  brokenHappened: string
  brokenExpected: string
  brokenSteps: string
  optional: string
  sayItLegend: string
  sayItLabel: string
  sayItPlaceholder: string
  showItLegend: string
  addImages: string
  addVideo: string
  takeScreenshot: string
  remove: string
  withLegend: string
  goesTo: (owner: string) => string
  includes: (parts: string[]) => string
  /** The part of the line that is always sent: where the person was. */
  screenName: string
  alwaysSent: (screen: string, route: string) => string
  diagAppVersion: string
  diagAt: string
  diagScreen: string
  diagDevice: string
  include: (what: string) => string
  send: string
  sendHint: string
  sending: string
  retry: string
  discard: string
  done: string
  restored: string
  appendLabel: string
  appendSend: string
  appended: string
  mineTitle: string
  mineEmpty: string
  back: string
  holdToTalk: string
  stopTalking: string
  micDenied: string
  voiceUnavailable: string
  loading: string
  voiceNotesLabel: string
  attachmentsLabel: string
  voiceNote: (n: number, length: string) => string
  voiceNoteKept: (n: number) => string
  voiceNoteRemoved: string
  /** Under a voice note while the host's `hear` is working on it. */
  hearingIt: string
  /** Under a voice note nothing could be heard in, or whose transcriber could not be reached. */
  heardLater: string
  attachmentRemoved: (name: string) => string
  waitingToSend: string
  sentWord: string
  didNotSend: (reason: string) => string
  attachmentsSending: (sent: number, total: number) => string
  attachmentsAllSent: string
  attachmentFailed: string
  upToImages: (n: number) => string
  oneVideoOnly: string
  notPicture: (name: string) => string
  notVideo: (name: string) => string
  /** A file of a kind the app cannot take (a picture or video format outside the accepted list). */
  notAccepted: (name: string) => string
  overSize: (name: string, mb: number) => string
  videoTooLong: (name: string, seconds: number) => string
  videoUnreadable: (name: string) => string
  voiceTooLong: string
  voiceTotalLimit: string
  screenshotFailed: string
  couldNotOpen: string
  couldNotLoadMine: string
  updating: string
  offlineShowingSaved: string
  addFailed: string
  overLimit: string
  stepLabel: string
  /** On a row in My suggestions that moved since the person last opened it. */
  newMark: string
  /** Read by a screen reader on the entry when a suggestion has moved (the dot itself is decoration). */
  entryMoved: string
  /** The one toast per open. `words` is the status's own word (wordsFor); `note` is the not-now reason, when there is one. */
  movedToast: (words: string, note?: string) => string
}

export const DEFAULT_STRINGS: Strings = {
  entry: 'Suggest a change',
  reportProblem: 'Report a problem',
  signedOut: 'Sign in to suggest a change.',
  signedOutMine: 'Sign in to see your suggestions.',
  sheetTitle: 'Suggest a change',
  close: 'Close',
  kindLegend: 'What kind?',
  kindChange: 'Change something',
  kindBroken: 'Something is broken',
  kindFeedback: 'Just feedback',
  brokenHappened: 'What happened',
  brokenExpected: 'What you expected',
  brokenSteps: 'How to make it happen again',
  optional: 'optional',
  sayItLegend: 'Say it',
  sayItLabel: 'Your suggestion',
  sayItPlaceholder: 'Type it, or hold the microphone and say it',
  showItLegend: 'Show it',
  addImages: 'Add a screenshot or photo',
  addVideo: 'Add a short video',
  takeScreenshot: 'Take a screenshot of this screen',
  remove: 'Remove',
  withLegend: 'What goes with it',
  goesTo: (owner) => `Goes to ${owner} and Pluma.`,
  includes: (parts) => `Includes ${list(parts)}.`,
  screenName: "this screen's name",
  alwaysSent: (screen, route) => `Always sent: the screen you are on (${screen}) and its address (${route}).`,
  diagAppVersion: "the app's version",
  diagAt: 'the time',
  diagScreen: 'your screen size',
  diagDevice: 'your phone type',
  include: (what) => `Include ${what}`,
  send: 'Send',
  sendHint: 'Type, say or show something first.',
  sending: 'Sending',
  retry: 'Try again',
  discard: 'Discard',
  done: 'Done',
  restored: 'Restored your unsent suggestion',
  appendLabel: 'Add to it',
  appendSend: 'Add',
  appended: 'Added.',
  mineTitle: 'My suggestions',
  mineEmpty: 'You have not sent a suggestion yet.',
  back: 'Back',
  holdToTalk: 'Hold to talk',
  stopTalking: 'Stop and keep the recording',
  micDenied: 'The microphone could not be used. You can type it instead.',
  voiceUnavailable: 'Voice notes cannot be added here',
  loading: 'Loading',
  voiceNotesLabel: 'Voice notes',
  attachmentsLabel: 'Attachments',
  voiceNote: (n, length) => `Voice note ${n}, ${length}`,
  voiceNoteKept: (n) => `Voice note ${n} kept.`,
  voiceNoteRemoved: 'Voice note removed.',
  hearingIt: 'Hearing it…',
  heardLater: 'The words get written out when it arrives.',
  attachmentRemoved: (name) => `${name} removed.`,
  waitingToSend: 'Waiting to send',
  sentWord: 'Sent',
  didNotSend: (reason) => `Did not send: ${reason}`,
  attachmentsSending: (sent, total) => `Sending attachments: ${sent} of ${total} sent.`,
  attachmentsAllSent: 'All attachments sent.',
  attachmentFailed: 'An attachment did not send.',
  upToImages: (n) => `Up to ${n} pictures.`,
  oneVideoOnly: 'One video at most.',
  notPicture: (name) => `${name} is not a picture.`,
  notVideo: (name) => `${name} is not a video.`,
  notAccepted: (name) => `${name} is a kind of file this app cannot take. Pictures can be JPEG, PNG, WebP, HEIC or GIF; videos can be MP4, MOV or WebM.`,
  overSize: (name, mb) => `${name} is over ${mb} MB.`,
  videoTooLong: (name, s) => `${name} is longer than ${s} seconds.`,
  videoUnreadable: (name) => `We could not check how long ${name} is. Try a shorter video.`,
  voiceTooLong: 'That recording is longer than the limit.',
  voiceTotalLimit: 'Voice notes are at their limit; type the rest.',
  screenshotFailed: 'The screenshot could not be taken.',
  couldNotOpen: 'This suggestion could not be opened.',
  couldNotLoadMine: 'Your suggestions could not be loaded.',
  updating: 'Updating',
  offlineShowingSaved: 'Could not reach the app. Showing what this phone last saw.',
  addFailed: 'That could not be added. Try again.',
  overLimit: 'Something in this suggestion is over a limit. Remove an attachment and try again.',
  stepLabel: 'Where it is',
  newMark: 'New',
  entryMoved: 'One of your suggestions has news',
  movedToast: (words, note) => (note ? `Your suggestion: ${words}. ${note}` : `Your suggestion: ${words}`),
}

export function stringsFor(words: Words): Strings {
  return { ...DEFAULT_STRINGS, ...words.text }
}

function list(parts: string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** The design's status word for a status; a status the contract does not know shows as itself instead of taking the list down. */
export function statusWords(status: string, owner: string): string {
  try { return wordsFor(status, { owner }) } catch { return String(status) }
}
export function statusMeaning(status: string, owner: string): string {
  try { return meaningFor(status, { owner }) } catch { return '' }
}

export type ReceiptState = 'on-phone' | 'received' | 'on-mac'

/** The receipt's one line (design section 2). `received` is only ever asked for after the adapter said `done`. */
export function receiptWords(state: ReceiptState, words: Pick<Words, 'owner'>): string {
  if (state === 'received') return `Got it. Pluma picks it up next time ${words.owner}'s Mac is on.`
  if (state === 'on-mac') return 'On your Mac.'
  return 'On this phone, waiting to send.'
}

/** An app may lower the ceilings and never raise them. */
export function effectiveCeilings(limits: Partial<typeof CEILINGS> | undefined): typeof CEILINGS {
  const out = { ...CEILINGS }
  for (const k of Object.keys(CEILINGS) as (keyof typeof CEILINGS)[]) {
    const v = limits?.[k]
    if (typeof v === 'number' && v >= 0) out[k] = Math.min(v, CEILINGS[k])
  }
  return out
}

export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function lengthWords(ms: number): string {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A short phone type for the device diagnostic, never the whole user agent string. */
export function phoneType(): string {
  if (typeof navigator === 'undefined') return 'Unknown device'
  const ua = navigator.userAgent
  const known: [RegExp, string][] = [[/iPhone/i, 'iPhone'], [/iPad/i, 'iPad'], [/Android/i, 'Android phone'], [/Macintosh|Mac OS/i, 'Mac'], [/Windows/i, 'Windows PC'], [/Linux/i, 'Linux computer']]
  return known.find(([re]) => re.test(ua))?.[1] ?? 'Unknown device'
}

export function screenSize(): string | undefined {
  return typeof window === 'undefined' ? undefined : `${window.innerWidth}x${window.innerHeight}`
}
