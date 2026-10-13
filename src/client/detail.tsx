'use client'
// ONE SUGGESTION: the words, the attachments, the step strip from the flow, and a way to add to it until
// it has an end status. A report's words are data: they are rendered as text, never as markup. A report
// that is still only on this phone is shown from the phone's own copy, with the app's refusal if it gave one.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { END, STATUSES } from '../contract.mjs'
import type { Adapters, FieldProps } from './adapters.ts'
import { DefaultField } from './default-field.tsx'
import { draftKey } from './drafts.ts'
import { recoverTakes } from './recorder.ts'
import { queueFollowUp, type Report } from './reports.ts'
import { useRuntime, useTick, type FollowUp } from './runtime.ts'
import { Toasts } from './toast.tsx'
import { oneCacheKey, readCache, writeCache } from './view-cache.ts'
import { effectiveCeilings, lengthWords, sizeWords, statusMeaning, statusWords, stringsFor } from './words.ts'

export function statusOf(r: Record<string, unknown>): string {
  if (typeof r.status === 'string') return r.status
  const t = r.timeline
  if (Array.isArray(t) && t.length) { const last = t[t.length - 1] as { status?: unknown }; if (typeof last?.status === 'string') return last.status }
  return 'received'
}

/** The step shown under "Being made". The timeline entry is the truth (that is where the receiving side puts it); a top-level `step` is read only when there is no timeline. */
export function stepOf(r: Record<string, unknown>): string | undefined {
  const t = r.timeline
  if (Array.isArray(t) && t.length) { const s = (t[t.length - 1] as { step?: unknown })?.step; return typeof s === 'string' && s ? s : undefined }
  return typeof r.step === 'string' ? r.step : undefined
}
const timelineOf = (r?: Record<string, unknown>): string[] | undefined =>
  Array.isArray(r?.timeline) ? (r!.timeline as { status?: unknown }[]).map((t) => String(t?.status)) : undefined

/** The strip is made from the contract's own statuses, one step per distinct word ("planned" reads as "With Freeda"),
 *  and a step is marked from the report's timeline: reached, skipped (the report went past it), or still ahead. */
export function StatusStrip({ status, owner, step, timeline, label }: { status: string; owner: string; step?: string; timeline?: string[]; /** The list's accessible name; the screens pass the app's own (words.text.stepLabel). */ label?: string }) {
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
    <ol className="sac-strip" aria-label={label ?? stringsFor({ app: 'x', owner }).stepLabel} data-status={status}>
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

function makeDeferred() { let done = () => {}; const ready = new Promise<void>((r) => { done = r }); return { ready, done: () => done() } }
type Heard = { key: string; file: string; ms: number }
const newFollowId = () => `f-${Math.random().toString(36).slice(2, 8)}`

export function SuggestionDetail({ adapters, id }: { adapters: Adapters; id: string }) {
  const S = stringsFor(adapters.words)
  const Field: React.ComponentType<FieldProps> = adapters.Field ?? DefaultField
  const { rt, who } = useRuntime(adapters)
  const tick = useTick(rt)
  const ceilings = useMemo(() => effectiveCeilings(adapters.limits), [adapters.limits])
  const [report, setReport] = useState<(Report & Record<string, unknown>) | null | undefined>(undefined)
  const [refusal, setRefusal] = useState<string | undefined>()
  const [pending, setPending] = useState<FollowUp[]>([])
  const [more, setMore] = useState('')
  const [heard, setHeard] = useState<Heard[]>([])
  const [note, setNote] = useState('')
  const [bad, setBad] = useState('')
  const [ready, setReady] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [offline, setOffline] = useState(false)
  // The follow-up being written: its id is made when the person starts it, so queuing it twice is one follow-up.
  const followId = useRef<string | null>(null)
  const n = useRef(0)
  const key = who ? draftKey({ app: adapters.words.app, account: who.account }) : null
  const fuKey = key ? `${key}#fu:${id}` : null
  const labels = { holdToTalk: S.holdToTalk, stopTalking: S.stopTalking, micDenied: S.micDenied, voiceUnavailable: S.voiceUnavailable, voiceTotalLimit: S.voiceTotalLimit }

  // Each load takes a number; only the newest may paint, so a load still running for the account that
  // was just replaced never draws its rows under the new one.
  const loads = useRef(0)
  // True once a report from the phone's copy or the app is on screen for this id and account.
  const shown = useRef(false)
  // Anything that writes the follow-up waits until its draft has been read, so the counter is right.
  const restored = useRef(makeDeferred())

  // A different account (or none) shows nothing of the last one.
  useEffect(() => { loads.current++; shown.current = false; setUpdating(false); setOffline(false); setReport(undefined); setPending([]); setReady(false); setMore(''); setHeard([]); followId.current = null; n.current = 0; restored.current = makeDeferred() }, [rt])

  const load = useCallback(async () => {
    if (!rt) return
    const mine_ = ++loads.current
    const fresh = () => mine_ === loads.current
    try {
      const waiting = await rt.followUps(id)
      const mine = await rt.local(id)
      if (!fresh()) return
      setPending(waiting)
      if (mine) { setReport({ ...(mine.report as Report & Record<string, unknown>), status: 'on-phone' }); setRefusal(mine.error); return }
      setRefusal(undefined)
      const ckey = oneCacheKey({ app: adapters.words.app, account: rt.who.account }, id)
      // Draw at once from the phone's copy, then ask the app.
      if (!shown.current) {
        const saved = await readCache<Report & Record<string, unknown>>(rt.store, ckey)
        if (!fresh()) return
        if (saved && typeof saved === 'object') { shown.current = true; setReport(saved); setUpdating(true) }
      }
      let r: (Report & Record<string, unknown>) | undefined
      try { r = (await adapters.store.one(id)) as Report & Record<string, unknown> } catch { r = undefined }
      if (!fresh()) return
      setUpdating(false)
      if (r) { shown.current = true; setOffline(false); setReport(r); void writeCache(rt.store, ckey, r) }
      else if (shown.current) setOffline(true)
      else setReport(null)
    } catch { if (fresh()) setReport(null) }
  }, [adapters, id, rt])
  useEffect(() => { void load() }, [load, tick])

  // The follow-up in progress is kept on the phone as it is written, and a take cut off by a closed app rejoins it.
  useEffect(() => {
    if (!rt || !fuKey || !key) return
    let live = true
    void (async () => {
      const d = await rt.store.get<{ followId: string; words: string; heard: Heard[] }>('kv', fuKey)
      let list = d?.heard ?? []
      // The counter starts from the notes already kept, before a rescued take takes the next number.
      followId.current = d?.followId ?? followId.current
      n.current = list.reduce((m, h) => Math.max(m, Number(h.key.slice(h.key.lastIndexOf(':') + 1)) || 0), 0)
      const rescued = await recoverTakes(rt.store, (q) => q === `${key}|field:append-${id}`)
      for (const t of rescued) {
        const blob = await rt.store.get<Blob>('blobs', t.key)
        if (!blob) continue
        followId.current ??= d?.followId ?? newFollowId()
        const k = `fu:${id}:${followId.current}:${++n.current}`
        await rt.store.put('blobs', k, blob)
        await rt.store.del('blobs', t.key)
        list = [...list, { key: k, file: `added-${followId.current}-${n.current}.${(blob.type ?? '').split('/')[1]?.split(';')[0] || 'bin'}`, ms: t.ms }]
      }
      if (!live) return
      // What was typed while this was loading wins over the saved words.
      if (d) setMore((cur) => (cur.trim() ? cur : d.words))
      setHeard((cur) => [...list, ...cur])
      setReady(true)
      restored.current.done()
    })()
    return () => { live = false }
  }, [rt, fuKey, key, id])
  useEffect(() => {
    if (!rt || !fuKey || !ready) return
    if (!more.trim() && !heard.length) void rt.store.del('kv', fuKey)
    else void rt.store.put('kv', fuKey, { followId: (followId.current ??= newFollowId()), words: more, heard })
  }, [rt, fuKey, ready, more, heard])

  if (who === null) return <p role="alert">{S.signedOutMine}</p>
  if (report === undefined) return <p>{S.loading}</p>
  if (report === null) return <p role="alert">{S.couldNotOpen}</p>
  const status = statusOf(report)
  const owner = adapters.words.owner
  const open = !END.includes(status) && status !== 'on-phone'
  const answers = (report.answers ?? {}) as Record<string, string>
  const voice = Array.isArray(report.voice) ? (report.voice as { file: string; ms: number }[]) : []
  const media = Array.isArray(report.media) ? (report.media as { file: string; type: string; bytes: number }[]) : []

  // Words and voice notes follow the report through the outbox, so they survive a bad connection like the report did.
  async function add() {
    const words = more.trim()
    if (!rt || !key || !fuKey || (!words && !heard.length)) return
    setBad(''); setNote('')
    try {
      const fid = (followId.current ??= newFollowId())
      await queueFollowUp({ outbox: rt.outbox, reportId: id, followId: fid, words, voice: heard.map((h) => ({ file: h.file, ms: h.ms, blob: h.key })), draft: key, ...(adapters.phone?.now ? { now: adapters.phone.now } : {}) })
      await rt.store.del('kv', fuKey)
      followId.current = null
      n.current = 0
      setMore(''); setHeard([]); setNote(S.appended)
      void rt.drain()
      void load()
    } catch { setBad(S.addFailed) }
  }

  // A note recorded here is kept on the phone (the recorder's own blob goes) and sent when Add is tapped.
  async function keepHeard(original: string, blob: Blob, ms: number) {
    if (!rt) return { refused: S.loading }
    if (ms > ceilings.voiceMs) return { refused: S.voiceTooLong }
    await restored.current.ready
    const fid = (followId.current ??= newFollowId())
    const k = `fu:${id}:${fid}:${++n.current}`
    await rt.store.put('blobs', k, blob)
    if (original && original !== k) await rt.store.del('blobs', original)
    const file = `added-${fid}-${n.current}.${(blob.type ?? '').split('/')[1]?.split(';')[0] || 'bin'}`
    setHeard((cur) => [...cur, { key: k, file, ms }])
    return { audio: k, text: '' }
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
      {updating ? <p role="status" className="sac-muted" data-updating="">{S.updating}</p> : null}
      {offline ? <p role="alert" className="sac-error">{S.offlineShowingSaved}</p> : null}
      <StatusStrip status={status} owner={owner} label={S.stepLabel} step={stepOf(report)} timeline={timelineOf(report)} />
      {typeof report.words === 'string' && report.words ? <p className="sac-words">{report.words}</p> : null}
      {Object.entries(answers).filter(([, v]) => v).map(([k, v]) => <p key={k} className="sac-words" data-answer={k}>{v}</p>)}
      {voice.length ? <ul className="sac-list" aria-label={S.voiceNotesLabel}>{voice.map((v, i) => <li key={v.file} className="sac-item">{S.voiceNote(i + 1, lengthWords(v.ms))}</li>)}</ul> : null}
      {media.length ? <ul className="sac-list" aria-label={S.attachmentsLabel}>{media.map((m) => <li key={m.file} className="sac-item">{m.file}, {sizeWords(m.bytes)}</li>)}</ul> : null}
      {Array.isArray(report.added) ? (report.added as { words?: string }[]).map((a, i) => <p key={i} className="sac-words">{a.words}</p>) : null}
      {pending.length ? (
        <ul className="sac-list" aria-label={S.waitingToSend} data-followups="">
          {pending.map((f) => (
            <li key={f.followId} className="sac-item" data-followup={f.followId}>
              <span className="sac-words">{f.words || S.attachmentsLabel}</span>
              {f.error ? <span role="alert" className="sac-error">{f.error}</span> : <span className="sac-muted">{S.waitingToSend}</span>}
              {f.error && rt ? <button type="button" className="sac-button" onClick={() => void rt.retry(id)}>{S.retry}</button> : null}
              {f.error && rt ? <button type="button" className="sac-button" onClick={() => void rt.discardFollowUp(id, f.followId)}>{S.discard}</button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {open ? (
        <form className="sac-form" onSubmit={(e) => { e.preventDefault(); void add() }}>
          {rt ? (
            <Field rt={{ store: rt.store }} id={`append-${id}`} label={S.appendLabel} value={more} onChange={setMore} multiline persist={false}
              startTake={adapters.startTake} maxMs={ceilings.voiceMs} scope={key ?? undefined} labels={labels}
              {...(adapters.appendVoice === false ? {} : { upload: (k: string, b: Blob, ms: number) => keepHeard(k, b, ms) })} />
          ) : null}
          {heard.length ? <ul className="sac-list" aria-label={S.voiceNotesLabel}>{heard.map((h, i) => <li key={h.key} className="sac-item">{S.voiceNote(i + 1, lengthWords(h.ms))}</li>)}</ul> : null}
          {bad ? <p role="alert" className="sac-error">{bad}</p> : null}
          {note ? <p role="status">{note}</p> : null}
          <button type="submit" className="sac-button" disabled={!more.trim() && !heard.length}>{S.appendSend}</button>
        </form>
      ) : null}
      <Toasts />
    </article>
  )
}
