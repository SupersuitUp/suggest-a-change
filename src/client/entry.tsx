'use client'
// THE ENTRY: one control, `data-suggest-entry`, which is the contract the screen checker looks for.
// Signed out, it opens nothing and says why. Signed in, it hands over to the host (`onOpen`), which
// shows the sheet. `<ReportProblem>` is the same control for an error screen, already filled in.
import { useEffect, useState, type AriaRole } from 'react'
import type { Adapters } from './adapters.ts'
import { useRuntime } from './runtime.ts'
import { firstToastThisOpen, moved, onSeen } from './seen.ts'
import { SuggestSheet } from './sheet.tsx'
import { toast, Toasts } from './toast.tsx'
import { useClearOnSignOut } from './view-cache.ts'
import { statusWords, stringsFor } from './words.ts'

/** Keeps the phone's outbox moving (on reconnect and every 15 seconds) for as long as it is mounted, with nothing drawn.
 *  <SuggestEntry> already does this; a host with no always-mounted entry mounts this once, high in the app. */
export function KeepSending({ adapters }: { adapters: Adapters }) {
  useRuntime(adapters)
  return null
}

export function SuggestEntry({ adapters, onOpen, className, role }: { adapters: Adapters; onOpen(): void; className?: string; /** An ARIA role for the button (for example `menuitem` when the host shows it as a menu row). Unset by default. */ role?: AriaRole }) {
  const S = stringsFor(adapters.words)
  const [why, setWhy] = useState('')
  const [busy, setBusy] = useState(false)
  // The runtime keeps the outbox moving while the entry is mounted (what <KeepSending> does).
  const { rt, who } = useRuntime(adapters)
  const [news, setNews] = useState(0)
  const [toasting, setToasting] = useState(false)
  useEffect(() => { setWhy('') }, [adapters])
  useClearOnSignOut(rt, who, adapters.words.app)
  // Once per mount, asks the app for this person's reports and compares each with what they last opened: a move since
  // then shows the dot, and the newest one gets the open's one toast. Opening a report (anywhere) clears it.
  useEffect(() => {
    setNews(0)
    if (!rt) return
    let live = true
    const id = { app: adapters.words.app, account: rt.who.account }
    let rows: { id: string; status: string; note?: unknown; at?: number }[] | null = null
    const count = async () => {
      if (!rows) return
      const m = await moved(rt.store, id, rows)
      if (live) setNews(m.length)
      return m
    }
    void (async () => {
      try { rows = await adapters.store.mine() } catch { rows = null }
      let now: { account: string } | null = null
      try { now = await adapters.identity() } catch { now = null }
      if (!live || !rows || !now || now.account !== rt.who.account) return
      const m = await count()
      if (!live || !m?.length || !firstToastThisOpen(id)) return
      const at = (x: string) => rows!.find((r) => r.id === x)?.at ?? 0
      const top = [...m].sort((a, b) => at(b.id) - at(a.id))[0]
      const note = top.status === 'not-now' ? rows.find((r) => r.id === top.id)?.note : undefined
      setToasting(true)
      toast({ id: `sac-moved-${top.id}`, text: S.movedToast(statusWords(top.status, adapters.words.owner), typeof note === 'string' && note ? note : undefined), ms: 6000 })
    })()
    const off = onSeen(() => { void count() })
    return () => { live = false; off() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rt])
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
      <button type="button" role={role} data-suggest-entry="" className={`sac-entry${className ? ` ${className}` : ''}`} aria-busy={busy || undefined} onClick={() => void press()}>
        {S.entry}
        {news ? <><span className="sac-entry-dot" data-sac-moved="" aria-hidden="true" /><span className="sac-sr">{S.entryMoved}</span></> : null}
      </button>
      {why ? <span role="status" className="sac-entry-why">{why}</span> : null}
      {toasting ? <Toasts /> : null}
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
