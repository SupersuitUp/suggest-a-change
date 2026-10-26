// WHAT AN APP SUPPLIES. The module owns the screens; the app owns who is signed in, where reports are
// kept, the words and the limits. `Field` is the slot a host with a golden voice field fills; hosted apps
// leave it empty and get the module's own (default-field.tsx).
import type { ComponentType } from 'react'
import type { CEILINGS } from '../contract.mjs'
import type { Store } from './idb.ts'
import type { StoreAdapter } from './reports.ts'
import type { startTake } from './recorder.ts'
import type { Words } from './words.ts'
import type { Destination } from '../github/compose.ts'
import type { AppContextItem } from './context.ts'

export type Role = 'operator' | 'member' | 'maintainer'
export type Kind = 'change' | 'broken' | 'feedback'
/** `name` (or `username`) is how the person is called in the app; it goes in the context, and the account never does. */
export type Identity = { account: string; role: Role; name?: string; username?: string }
/** How whoever fixes it can reach the sender: what the app already knows. */
export type Contact = { email?: string; phone?: string; handle?: string }

export type HeardUpload = (key: string, blob: Blob, ms: number) => Promise<{ audio: string; text: string } | { refused: string }>

/** What a field needs of the host's runtime: the phone's database. A host's richer runtime fits. */
export interface FieldRuntime { store: Store }

/** The props every text field the module renders receives. Named and shaped after the Helm's golden
 *  voice field (VoiceFieldProps), so the Helm passes that component into the `Field` slot as it is. */
export interface FieldProps {
  rt: FieldRuntime
  id: string
  label: string
  value: string
  onChange(v: string): void
  placeholder?: string
  multiline?: boolean
  type?: 'text' | 'search'
  /** Gets each finished take. The sheet keeps the recording; transcription is the receiving Mac's job. */
  upload?: HeardUpload
  onHeard?(h: { audio: string; text: string }): void
  onKept?(t: { key: string; ms: number }): void
  onHearing?(hearing: boolean): void
  disabled?: boolean
  persist?: boolean
  startTake?: typeof startTake
  /** A take stops by itself here and is kept at this length (the module's default field only). */
  maxMs?: number
  /** Scopes this field's recorded takes (the sheet passes the draft key: app and account), so an interrupted take can only rejoin its own account. */
  scope?: string
  /** The default field's own words, from the app's `words.text`. */
  labels?: { holdToTalk: string; stopTalking: string; micDenied: string; voiceUnavailable: string; voiceTotalLimit: string }
}

export interface Adapters {
  /** Who is signed in; null when no one is. */
  identity(): Promise<Identity | null>
  /** Where reports are kept. Must dedupe by report id (see StoreAdapter). */
  store: StoreAdapter
  words: Words
  /** Lowers the ceilings; never raises them. */
  limits?: Partial<typeof CEILINGS>
  Field?: ComponentType<FieldProps>
  /** One tap to attach a picture of the current screen. Without it the control is not shown. */
  snapshot?(): Promise<Blob>
  /** Which app and version this is, stamped into every report. */
  about?: { app?: string; template?: string; templateVersion?: string; copy?: string; version?: string }
  /** Where a received report lands: `'mac'` on a Helm that posts straight to the owner's Mac. */
  lands?: 'app' | 'mac'
  /** The phone's own database and reachability, for hosts that already hold them (and for tests). */
  phone?: {
    store?: Store
    reach?: { check(force?: boolean): Promise<boolean>; mark(up: boolean): void }
    now?: () => number
    /** Reads a video's length in ms; undefined when it cannot be read. Defaults to the browser's own player. */
    videoLength?(file: Blob): Promise<number | undefined>
    /** How long the default reader waits for the video's length before giving up. Default 3000. */
    probeMs?: number
  }
  /** Phone type for the device diagnostic. Defaults to a short name ("iPhone", "Android phone"). */
  device?(): string
  /** The recorder the default field uses. Defaults to the module's own. */
  startTake?: typeof startTake
  /** False when the receiving side cannot take a voice note added to a report afterwards (the detail view then says so). */
  appendVoice?: boolean
  /** Where a sent report files as a GitHub issue. With it, the sheet lists exactly what goes and where above Send
   *  (the same list the issue is written from); null or absent keeps the one-line note. */
  destination?(): Promise<SheetDestination | null>
  /** Anything app-specific that would help fix it, each with why it is shared (an item without a why is dropped). Or
   *  `{ items?, precise? }`, where `precise: true` also asks the browser for the person's location (its permission prompt). */
  context?: (() => Promise<AppContextItem[]>) | { items?(): Promise<AppContextItem[]>; precise?: boolean }
  /** How to reach the sender, from what the app already knows. Shared by default to a private repo, off for a public one. */
  contact?(): Promise<Contact | null>
}

/** The issue's destination as the sheet shows it: the repo, whether it is public, the GitHub login it files from,
 *  whether files can reach it yet, and (optionally) the sender's name as the issue will say it. */
export interface SheetDestination extends Destination { name?: string }
