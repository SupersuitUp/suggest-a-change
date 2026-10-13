'use client'
// THE ENTRY: one control, `data-suggest-entry`, which is the contract the screen checker looks for.
// Signed out, it opens nothing and says why. Signed in, it hands over to the host (`onOpen`), which
// shows the sheet. `<ReportProblem>` is the same control for an error screen, already filled in.
import { useEffect, useState } from 'react'
import type { Adapters } from './adapters.ts'
import { useRuntime } from './runtime.ts'
import { SuggestSheet } from './sheet.tsx'
import { stringsFor } from './words.ts'

/** Keeps the phone's outbox moving (on reconnect and every 15 seconds) for as long as it is mounted, with nothing drawn.
 *  <SuggestEntry> already does this; a host with no always-mounted entry mounts this once, high in the app. */
export function KeepSending({ adapters }: { adapters: Adapters }) {
  useRuntime(adapters)
  return null
}

export function SuggestEntry({ adapters, onOpen, className }: { adapters: Adapters; onOpen(): void; className?: string }) {
  const S = stringsFor(adapters.words)
  const [why, setWhy] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setWhy('') }, [adapters])
  async function press() {
    setBusy(true)
    let who = null
    try { who = await adapters.identity() } catch { who = null }
    setBusy(false)
    if (!who) { setWhy(S.signedOut); return }
    setWhy('')
    onOpen()
  }
  return (
    <span className="sac-entry-wrap">
      <KeepSending adapters={adapters} />
      <button type="button" data-suggest-entry="" className={`sac-entry${className ? ` ${className}` : ''}`} aria-busy={busy || undefined} onClick={() => void press()}>{S.entry}</button>
      {why ? <span role="status" className="sac-entry-why">{why}</span> : null}
    </span>
  )
}

/** For an error screen: opens the sheet as "something is broken", with the screen and what went wrong filled in. */
export function ReportProblem({ adapters, screen, error }: { adapters: Adapters; screen: string; error?: unknown }) {
  const S = stringsFor(adapters.words)
  const [open, setOpen] = useState(false)
  const [why, setWhy] = useState('')
  const happened = error instanceof Error ? error.message : error == null ? '' : String(error)
  async function press() {
    let who = null
    try { who = await adapters.identity() } catch { who = null }
    if (!who) { setWhy(S.signedOut); return }
    setWhy('')
    setOpen(true)
  }
  return (
    <>
      <button type="button" className="sac-button sac-report-problem" onClick={() => void press()}>{S.reportProblem}</button>
      {why ? <span role="status" className="sac-entry-why">{why}</span> : null}
      {open ? (
        <SuggestSheet adapters={adapters} where={{ screen, route: typeof location === 'undefined' ? '' : location.pathname }} initial={{ kind: 'broken', happened }} onClose={() => setOpen(false)} />
      ) : null}
    </>
  )
}
