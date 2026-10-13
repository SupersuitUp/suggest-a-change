// MY SUGGESTIONS: everything this person has sent, newest first, each with its status in plain words.
// A report still on the phone is listed too (as "On this phone"), so a suggestion never disappears
// between the Send button and the app's first answer.
import { useCallback, useEffect, useState } from 'react'
import { meaningFor, wordsFor } from '../contract.mjs'
import type { Adapters } from './adapters.ts'
import { SuggestionDetail } from './detail.tsx'
import type { Summary } from './reports.ts'
import { useRuntime, useTick } from './runtime.ts'
import { stringsFor } from './words.ts'

export function MySuggestions({ adapters, onOpen }: { adapters: Adapters; onOpen?(id: string): void }) {
  const S = stringsFor(adapters.words)
  const owner = adapters.words.owner
  const rt = useRuntime(adapters)
  const tick = useTick(rt)
  const [rows, setRows] = useState<Summary[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [bad, setBad] = useState('')

  const load = useCallback(async () => {
    let theirs: Summary[] = []
    try { theirs = await adapters.store.mine(); setBad('') } catch { setBad('Your suggestions could not be loaded.') }
    const local = rt ? await rt.waiting() : []
    const have = new Set(theirs.map((s) => s.id))
    const phone: Summary[] = local.filter((l) => !have.has(l.id)).map((l) => ({ id: l.id, status: 'on-phone', at: l.at }))
    setRows([...theirs, ...phone].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)))
  }, [adapters, rt])
  useEffect(() => { void load() }, [load, tick])

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
      {rows === null ? <p>{S.loading}</p> : rows.length === 0 ? <p>{S.mineEmpty}</p> : (
        <ul className="sac-list">
          {rows.map((r) => {
            const preview = typeof r.words === 'string' ? r.words : typeof r.title === 'string' ? r.title : ''
            return (
              <li key={r.id} className="sac-row" data-status={r.status}>
                <button type="button" className="sac-row-button" onClick={() => (onOpen ? onOpen(r.id) : setOpen(r.id))}>
                  {preview ? <span className="sac-row-words">{preview}</span> : null}
                  <span className="sac-row-status">{wordsFor(r.status, { owner })}</span>
                  <span className="sac-muted">{meaningFor(r.status, { owner })}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
