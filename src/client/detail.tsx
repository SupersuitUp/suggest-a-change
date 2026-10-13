// ONE SUGGESTION: the words, the attachments, the step strip from the flow, and a way to add to it until
// it has an end status. A report's words are data: they are rendered as text, never as markup.
import { useCallback, useEffect, useState } from 'react'
import { END, meaningFor, wordsFor } from '../contract.mjs'
import type { Adapters, FieldProps } from './adapters.ts'
import { DefaultField } from './default-field.tsx'
import { useRuntime, useTick } from './runtime.ts'
import type { Report } from './reports.ts'
import { lengthWords, sizeWords, stringsFor } from './words.ts'

// The path a report walks, one word each. "planned" reads as "With Freeda", so it is not a step of its own.
const PATH = ['on-phone', 'received', 'with-freeda', 'waiting-on-owner', 'being-made'] as const

export function statusOf(r: Record<string, unknown>): string {
  if (typeof r.status === 'string') return r.status
  const t = r.timeline
  if (Array.isArray(t) && t.length) { const last = t[t.length - 1] as { status?: unknown }; if (typeof last?.status === 'string') return last.status }
  return 'received'
}

export function StatusStrip({ status, owner, step }: { status: string; owner: string; step?: string }) {
  const here = status === 'planned' ? 'with-freeda' : status
  const ended = END.includes(status)
  const at = ended ? PATH.length : Math.max(0, PATH.indexOf(here as (typeof PATH)[number]))
  const items: { id: string; words: string }[] = [...PATH.map((id) => ({ id, words: wordsFor(id, { owner }) })), { id: ended ? status : 'end', words: ended ? wordsFor(status, { owner }) : wordsFor('live', { owner }) }]
  return (
    <ol className="sac-strip" aria-label="Where it is" data-status={status}>
      {items.map((it, i) => (
        <li key={it.id} className="sac-step" data-state={i < at ? 'past' : i === at ? 'now' : 'next'} aria-current={i === at ? 'step' : undefined}>
          <span>{it.words}</span>
          {i === at && it.id === 'being-made' && step ? <span className="sac-step-detail">{step}</span> : null}
        </li>
      ))}
    </ol>
  )
}

export function SuggestionDetail({ adapters, id }: { adapters: Adapters; id: string }) {
  const S = stringsFor(adapters.words)
  const Field: React.ComponentType<FieldProps> = adapters.Field ?? DefaultField
  const rt = useRuntime(adapters)
  const tick = useTick(rt)
  const [report, setReport] = useState<(Report & Record<string, unknown>) | null | undefined>(undefined)
  const [more, setMore] = useState('')
  const [note, setNote] = useState('')
  const [bad, setBad] = useState('')
  const load = useCallback(async () => {
    try { setReport((await adapters.store.one(id)) as Report & Record<string, unknown>) } catch { setReport(null) }
  }, [adapters, id])
  useEffect(() => { void load() }, [load, tick])

  if (report === undefined) return <p>{S.loading}</p>
  if (report === null) return <p role="alert">This suggestion could not be opened.</p>
  const status = statusOf(report)
  const owner = adapters.words.owner
  const open = !END.includes(status)
  const answers = (report.answers ?? {}) as Record<string, string>
  const voice = Array.isArray(report.voice) ? (report.voice as { file: string; ms: number }[]) : []
  const media = Array.isArray(report.media) ? (report.media as { file: string; type: string; bytes: number }[]) : []

  async function add() {
    const words = more.trim()
    if (!words) return
    setBad(''); setNote('')
    const r = await adapters.store.append(id, { words, at: new Date().toISOString() })
    if (r === 'done') { setMore(''); setNote(S.appended); void load() } else setBad(r.refused)
  }

  return (
    <article className="sac-detail" data-report={id}>
      <h3 className="sac-status" data-status={status}>{wordsFor(status, { owner })}</h3>
      <p className="sac-muted">{meaningFor(status, { owner })}{status === 'live' && typeof report.liveAt === 'string' ? ` (${new Date(report.liveAt).toLocaleDateString()})` : ''}</p>
      <StatusStrip status={status} owner={owner} step={typeof report.step === 'string' ? report.step : undefined} />
      {typeof report.words === 'string' && report.words ? <p className="sac-words">{report.words}</p> : null}
      {Object.entries(answers).filter(([, v]) => v).map(([k, v]) => <p key={k} className="sac-words" data-answer={k}>{v}</p>)}
      {voice.length ? <ul className="sac-list" aria-label="Voice notes">{voice.map((v, i) => <li key={v.file} className="sac-item">Voice note {i + 1}, {lengthWords(v.ms)}</li>)}</ul> : null}
      {media.length ? <ul className="sac-list" aria-label="Attachments">{media.map((m) => <li key={m.file} className="sac-item">{m.file}, {sizeWords(m.bytes)}</li>)}</ul> : null}
      {Array.isArray(report.added) ? (report.added as { words?: string }[]).map((a, i) => <p key={i} className="sac-words">{a.words}</p>) : null}
      {open ? (
        <form className="sac-form" onSubmit={(e) => { e.preventDefault(); void add() }}>
          {rt ? <Field rt={{ store: rt.store }} id={`append-${id}`} label={S.appendLabel} value={more} onChange={setMore} multiline persist={false} /> : null}
          {bad ? <p role="alert" className="sac-error">{bad}</p> : null}
          {note ? <p role="status">{note}</p> : null}
          <button type="submit" className="sac-button" disabled={!more.trim()}>{S.appendSend}</button>
        </form>
      ) : null}
    </article>
  )
}
