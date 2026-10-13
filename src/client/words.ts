// EVERY WORD A PERSON READS THAT THE CONTRACT DOES NOT ALREADY OWN. The status words and their meanings
// live in contract.mjs (`wordsFor`, `meaningFor`); the receipt lines, the sheet's labels and the
// button come from design section 2. The owner's name and the app's name are passed in by the host,
// never written here. An app may replace any string through `words.text`.
import { CEILINGS } from '../contract.mjs'

export interface Words {
  /** A short id for the app. It names the draft on the phone, so it may not contain ":". */
  app: string
  /** The owner's first name, as the receipt says it ("Gary"). */
  owner: string
  /** Replaces any string below. */
  text?: Partial<Strings>
}

export interface Strings {
  entry: string
  reportProblem: string
  signedOut: string
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
  includesNothing: string
  send: string
  sendHint: string
  sending: string
  retry: string
  done: string
  restored: string
  appendLabel: string
  appendSend: string
  appended: string
  mineTitle: string
  mineEmpty: string
  back: string
  stripLegend: string
  holdToTalk: string
  stopTalking: string
  micDenied: string
  loading: string
}

export const DEFAULT_STRINGS: Strings = {
  entry: 'Suggest a change',
  reportProblem: 'Report a problem',
  signedOut: 'Sign in to suggest a change.',
  sheetTitle: 'Suggest a change',
  close: 'Close',
  kindLegend: 'What kind?',
  kindChange: 'Change something',
  kindBroken: 'Something is broken',
  kindFeedback: 'Just feedback',
  brokenHappened: 'What happened?',
  brokenExpected: 'What did you expect?',
  brokenSteps: 'How can it be made to happen again?',
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
  goesTo: (owner) => `Goes to ${owner} and Freeda.`,
  includes: (parts) => `Includes ${list(parts)}.`,
  includesNothing: 'Includes nothing extra.',
  send: 'Send',
  sendHint: 'Type, say or show something first.',
  sending: 'Sending',
  retry: 'Try again',
  done: 'Done',
  restored: 'Restored your unsent suggestion',
  appendLabel: 'Add to it',
  appendSend: 'Add',
  appended: 'Added.',
  mineTitle: 'My suggestions',
  mineEmpty: 'You have not sent a suggestion yet.',
  back: 'Back',
  stripLegend: 'Where it is',
  holdToTalk: 'Hold to talk',
  stopTalking: 'Stop and keep the recording',
  micDenied: 'The microphone could not be used. You can type it instead.',
  loading: 'Loading',
}

export function stringsFor(words: Words): Strings {
  return { ...DEFAULT_STRINGS, ...words.text }
}

function list(parts: string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

export type ReceiptState = 'on-phone' | 'received' | 'on-mac'

/** The receipt's one line (design section 2). `received` is only ever asked for after the adapter said `done`. */
export function receiptWords(state: ReceiptState, words: Pick<Words, 'owner'>): string {
  if (state === 'received') return `Got it. Freeda picks it up next time ${words.owner}'s Mac is on.`
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
