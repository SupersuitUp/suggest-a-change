'use client'
// MY SUGGESTIONS: everything this person has sent, newest first, each with its status in plain words.
// A report still on the phone is listed too (as "On this phone"), with the app's refusal and a Try again
// when it gave one. Only this signed-in account's reports are shown; another person's waiting reports
// on the same phone are not.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Adapters } from './adapters.ts'
import { SuggestionDetail } from './detail.tsx'
import type { Summary } from './reports.ts'
import { useRuntime, useTick } from './runtime.ts'
import { mineCacheKey, readCache, writeCache } from './view-cache.ts'
import { Toasts } from './toast.tsx'
import { statusMeaning, statusWords, stringsFor } from './words.ts'

type Row = Summary & { error?: string }

export function MySuggestions({ adapters, onOpen }: { adapters: Adapters; onOpen?(id: string): void }) {
  const S = stringsFor(adapters.words)
  const owner = adapters.words.owner
  const { rt, who } = useRuntime(adapters)
  const tick = useTick(rt)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [bad, setBad] = useState('')
  const [updating, setUpdating] = useState(false)

  // Another account (or none) shows nothing of the last one's rows.
  const loads = useRef(0)
  // What the app last said (or the phone kept of it) for this account; null until either is known.
  const known = useRef<Summary[] | null>(null)
  useEffect(() => { loads.current++; known.current = null; setRows(null); setOpen(null); setBad(''); setUpdating(false) }, [rt])

  const load = useCallback(async () => {
    if (!rt) return
    // Only the newest load may paint: one still running for the account just replaced must not draw its rows.
    const mine_ = ++loads.current
    const key = mineCacheKey({ app: adapters.words.app, account: rt.who.account })
    const paint = (theirs: Summary[], local: Awaited<ReturnType<typeof rt.waiting>>) => {
      const waiting = new Map(local.map((l) => [l.id, l]))
      // A report the app already lists keeps its own status; one still on the phone is listed as on the phone.
      const phone: Row[] = local.filter((l) => !l.onlyFollowUp && !theirs.some((t) => t.id === l.id)).map((l) => ({ id: l.id, status: 'on-phone', at: l.at, ...(l.words ? { words: l.words } : {}), ...(l.error ? { error: l.error } : {}) }))
      setRows([...theirs.map((t) => ({ ...t, ...(waiting.get(t.id)?.error ? { error: waiting.get(t.id)!.error } : {}) })), ...phone].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)))
    }
    // Draw at once from what the phone already holds, then ask the app.
    if (known.current === null) {
      const saved = await readCache<Summary[]>(rt.store, key)
      if (mine_ !== loads.current) return
      if (Array.isArray(saved)) known.current = saved
    }
    if (known.current !== null) {
      const local = await rt.waiting()
      if (mine_ !== loads.current) return
      paint(known.current, local)
      setUpdating(true)
    }
    let theirs: Summary[] | null = null
    try { theirs = await adapters.store.mine() } catch { theirs = null }
    const local = await rt.waiting()
    if (mine_ !== loads.current) return
    setUpdating(false)
    if (theirs) {
      known.current = theirs
      void writeCache(rt.store, key, theirs)
      setBad('')
      paint(theirs, local)
    } else if (known.current !== null) {
      setBad(S.offlineShowingSaved)
      paint(known.current, local)
    } else {
      setBad(S.couldNotLoadMine)
      paint([], local)
    }
  }, [adapters, rt, S.couldNotLoadMine, S.offlineShowingSaved])
  useEffect(() => { void load() }, [load, tick])

  if (who === null) return <p role="alert">{S.signedOutMine}</p>
  if (open && !onOpen) {
    return (
      <section className="sac-mine">
        <button type="button" className="sac-button" onClick={() => setOpen(null)}>{S.back}</button>
        <SuggestionDetail adapters={adapters} id={open} />
      </section>
    )
  }
  return (
    <section className="sac-mine" aria-labelledby="sac-mine-title">
      <h2 id="sac-mine-title" className="sac-title">{S.mineTitle}</h2>
      {bad ? <p role="alert" className="sac-error">{bad}</p> : null}
      {updating ? <p role="status" className="sac-muted" data-updating="">{S.updating}</p> : null}
      {rows === null ? <p>{S.loading}</p> : rows.length === 0 ? <p>{S.mineEmpty}</p> : (
        <ul className="sac-list">
          {rows.map((r) => {
            const preview = typeof r.words === 'string' ? r.words : typeof r.title === 'string' ? r.title : ''
            return (
              <li key={r.id} className="sac-row" data-status={r.status}>
                <button type="button" className="sac-row-button" onClick={() => (onOpen ? onOpen(r.id) : setOpen(r.id))}>
                  {preview ? <span className="sac-row-words">{preview}</span> : null}
                  <span className="sac-row-status">{statusWords(r.status, owner)}</span>
                  <span className="sac-muted">{statusMeaning(r.status, owner)}</span>
                </button>
                {r.error ? (
                  <>
                    <p role="alert" className="sac-error">{r.error}</p>
                    {rt ? <button type="button" className="sac-button" onClick={() => void rt.retry(r.id)}>{S.retry}</button> : null}
                  </>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <Toasts />
    </section>
  )
}
