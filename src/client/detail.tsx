'use client'
// ONE SUGGESTION: the words, the attachments, the step strip from the flow, and a way to add to it until
// it has an end status. A report's words are data: they are rendered as text, never as markup. A report
// that is still only on this phone is shown from the phone's own copy, with the app's refusal if it gave one.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { END, STATUSES } from '../contract.mjs'
import type { Adapters, FieldProps } from './adapters.ts'
import { DefaultField } from './default-field.tsx'
import { useRuntime, useTick } from './runtime.ts'
import type { Report } from './reports.ts'
import { Toasts } from './toast.tsx'
import { effectiveCeilings, lengthWords, sizeWords, statusMeaning, statusWords, stringsFor } from './words.ts'

export function statusOf(r: Record<string, unknown>): string {
  if (typeof r.status === 'string') return r.status
  const t = r.timeline
  if (Array.isArray(t) && t.length) { const last = t[t.length - 1] as { status?: unknown }; if (typeof last?.status === 'string') return last.status }
  return 'received'
}

const timelineOf = (r?: Record<string, unknown>): string[] | undefined =>
  Array.isArray(r?.timeline) ? (r!.timeline as { status?: unknown }[]).map((t) => String(t?.status)) : undefined

/** The strip is made from the contract's own statuses, one step per distinct word ("planned" reads as "With Freeda"),
 *  and a step is marked from the report's timeline: reached, skipped (the report went past it), or still ahead. */
export function StatusStrip({ status, owner, step, timeline }: { status: string; owner: string; step?: string; timeline?: string[] }) {
  const nodes = useMemo(() => {
    const out: { words: string; ids: string[] }[] = []
    for (const id of STATUSES.filter((s: string) => !END.includes(s))) {
      const words = statusWords(id, owner)
      const had = out.find((n) => n.words === words)
      if (had) had.ids.push(id); else out.push({ words, ids: [id] })
    }
    return out
  }, [owner])
  const ended = END.includes(status)
  const here = nodes.findIndex((n) => n.ids.includes(status))
  const at = ended ? nodes.length : Math.max(0, here)
  const items = [...nodes, { words: statusWords(ended ? status : 'live', owner), ids: [ended ? status : 'end'] }]
  const reached = new Set(timeline ?? [])
  return (
    <ol className="sac-strip" aria-label={stringsFor({ app: 'x', owner }).stepLabel} data-status={status}>
      {items.map((it, i) => {
        const state = i === at ? 'now'
          : it.ids.some((id) => reached.has(id)) ? 'past'
          : i > at ? 'next'
          : timeline ? 'skipped'
          // No timeline to read: an open report has passed what is before it; an ended one may have skipped any step.
          : ended ? 'unknown' : 'past'
        return (
          <li key={it.words + i} className="sac-step" data-state={state} aria-current={i === at ? 'step' : undefined}>
            <span>{it.words}</span>
            {i === at && it.ids.includes('being-made') && step ? <span className="sac-step-detail">{step}</span> : null}
          </li>
        )
      })}
    </ol>
  )
}

export function SuggestionDetail({ adapters, id }: { adapters: Adapters; id: string }) {
  const S = stringsFor(adapters.words)
  const Field: React.ComponentType<FieldProps> = adapters.Field ?? DefaultField
  const { rt, who } = useRuntime(adapters)
  const tick = useTick(rt)
  const ceilings = useMemo(() => effectiveCeilings(adapters.limits), [adapters.limits])
  const [report, setReport] = useState<(Report & Record<string, unknown>) | null | undefined>(undefined)
  const [refusal, setRefusal] = useState<string | undefined>()
  const [more, setMore] = useState('')
  const [heard, setHeard] = useState<{ file: string; ms: number }[]>([])
  const [note, setNote] = useState('')
  const [bad, setBad] = useState('')
  const load = useCallback(async () => {
    if (!rt) return
    try {
      const mine = await rt.local(id)
      if (mine) { setReport({ ...(mine.report as Report & Record<string, unknown>), status: 'on-phone' }); setRefusal(mine.error); return }
      setRefusal(undefined)
      setReport((await adapters.store.one(id)) as Report & Record<string, unknown>)
    } catch { setReport(null) }
  }, [adapters, id, rt])
  useEffect(() => { void load() }, [load, tick])

  if (who === null) return <p role="alert">{S.signedOutMine}</p>
  if (report === undefined) return <p>{S.loading}</p>
  if (report === null) return <p role="alert">{S.couldNotOpen}</p>
  const status = statusOf(report)
  const owner = adapters.words.owner
  const open = !END.includes(status) && status !== 'on-phone'
  const answers = (report.answers ?? {}) as Record<string, string>
  const voice = Array.isArray(report.voice) ? (report.voice as { file: string; ms: number }[]) : []
  const media = Array.isArray(report.media) ? (report.media as { file: string; type: string; bytes: number }[]) : []

  async function add() {
    const words = more.trim()
    if (!words && !heard.length) return
    setBad(''); setNote('')
    try {
      const r = await adapters.store.append(id, { words, at: new Date().toISOString(), ...(heard.length ? { voice: heard } : {}) })
      if (r === 'done') { setMore(''); setHeard([]); setNote(S.appended); void load() } else setBad(r.refused)
    } catch { setBad(S.addFailed) }
  }

  // A note recorded here goes to the app as a part of this report; the words that follow name it.
  async function keepHeard(_k: string, blob: Blob, ms: number) {
    if (ms > ceilings.voiceMs) return { refused: S.voiceTooLong }
    const file = `added-${Date.now()}.${(blob.type.split('/')[1] ?? 'bin').split(';')[0]}`
    try {
      const r = await adapters.store.uploadPart(id, file, 0, blob)
      if (r !== 'done') return { refused: r.refused }
    } catch { return { refused: S.addFailed } }
    setHeard((cur) => [...cur, { file, ms }])
    return { audio: file, text: '' }
  }

  return (
    <article className="sac-detail" data-report={id}>
      <h3 className="sac-status" data-status={status}>{statusWords(status, owner)}</h3>
      <p className="sac-muted">{statusMeaning(status, owner)}{status === 'live' && typeof report.liveAt === 'string' ? ` (${new Date(report.liveAt).toLocaleDateString()})` : ''}</p>
      {refusal ? (
        <>
          <p role="alert" className="sac-error">{refusal}</p>
          {rt ? <button type="button" className="sac-button" onClick={() => void rt.retry(id)}>{S.retry}</button> : null}
        </>
      ) : null}
      <StatusStrip status={status} owner={owner} step={typeof report.step === 'string' ? report.step : undefined} timeline={timelineOf(report)} />
      {typeof report.words === 'string' && report.words ? <p className="sac-words">{report.words}</p> : null}
      {Object.entries(answers).filter(([, v]) => v).map(([k, v]) => <p key={k} className="sac-words" data-answer={k}>{v}</p>)}
      {voice.length ? <ul className="sac-list" aria-label={S.voiceNotesLabel}>{voice.map((v, i) => <li key={v.file} className="sac-item">{S.voiceNote(i + 1, lengthWords(v.ms))}</li>)}</ul> : null}
      {media.length ? <ul className="sac-list" aria-label={S.attachmentsLabel}>{media.map((m) => <li key={m.file} className="sac-item">{m.file}, {sizeWords(m.bytes)}</li>)}</ul> : null}
      {Array.isArray(report.added) ? (report.added as { words?: string }[]).map((a, i) => <p key={i} className="sac-words">{a.words}</p>) : null}
      {open ? (
        <form className="sac-form" onSubmit={(e) => { e.preventDefault(); void add() }}>
          {rt ? (
            <Field rt={{ store: rt.store }} id={`append-${id}`} label={S.appendLabel} value={more} onChange={setMore} multiline persist={false}
              startTake={adapters.startTake} maxMs={ceilings.voiceMs}
              labels={{ holdToTalk: S.holdToTalk, stopTalking: S.stopTalking, micDenied: S.micDenied, voiceUnavailable: S.voiceUnavailable }}
              {...(adapters.appendVoice === false ? {} : { upload: keepHeard })} />
          ) : null}
          {heard.length ? <ul className="sac-list" aria-label={S.voiceNotesLabel}>{heard.map((h, i) => <li key={h.file} className="sac-item">{S.voiceNote(i + 1, lengthWords(h.ms))}</li>)}</ul> : null}
          {bad ? <p role="alert" className="sac-error">{bad}</p> : null}
          {note ? <p role="status">{note}</p> : null}
          <button type="submit" className="sac-button" disabled={!more.trim() && !heard.length}>{S.appendSend}</button>
        </form>
      ) : null}
      <Toasts />
    </article>
  )
}
