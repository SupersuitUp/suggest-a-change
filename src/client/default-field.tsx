'use client'
// THE MODULE'S OWN VOICE FIELD, for hosted apps that have no golden one. One box, like a message composer:
// the text area on top and, inside the same border, a bar with the Record button and whatever the host puts
// in `toolbar` (the sheet's attach buttons and chips). One [data-voice-field] container with nothing else
// typeable in it. A take is
// recorded with the module's recorder (written to the phone's database as it is made). Transcription is
// not done here: the take goes to `upload`, and the receiving Mac writes the transcript. A voice note
// alone is a whole report, so a field with no words and one take is a complete answer.
//
// A TAP starts a take and a second tap stops it (mouse, touch, Space and Enter alike). It was hold-to-talk
// until 0.1.14, and a hold could not survive the first use: the browser's microphone prompt takes the finger
// off the button, so the take was cancelled before it began, and on a phone that asks again per visit it never
// recorded at all (the operator, 2026-10-24). While it records the button shows the running time.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { FieldProps } from './adapters.ts'
import { startTake as defaultStartTake } from './recorder.ts'
import { toast } from './toast.tsx'
import { DEFAULT_STRINGS, lengthWords } from './words.ts'


type Take = Awaited<ReturnType<typeof defaultStartTake>>

const MicIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" />
  </svg>
)

export function DefaultField(props: FieldProps & { toolbar?: ReactNode }) {
  const { rt, id, label, value, onChange, placeholder, multiline = false, type = 'text', upload, onHeard, onKept, onHearing, disabled, startTake = defaultStartTake, maxMs, labels, scope, toolbar } = props
  const L = { ...DEFAULT_STRINGS, ...labels }
  // With nowhere to send a take, recording would lose it silently: the control stays, switched off, and says why.
  const canRecord = Boolean(upload || onKept)
  const [recording, setRecording] = useState(false)
  const [startedAt, setStartedAt] = useState(0)
  const [, setNow] = useState(0)
  const take = useRef<Take | null>(null)
  const wanted = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(value)
  latest.current = value
  const cb = useRef({ onChange, upload, onHeard, onKept, onHearing })
  cb.current = { onChange, upload, onHeard, onKept, onHearing }

  async function begin() {
    if (take.current || wanted.current || disabled) return
    // No time left: say so before recording instead of recording a note that will be refused.
    if (maxMs !== undefined && maxMs <= 0) { toast({ id: 'sac-limit', text: L.voiceTotalLimit, tone: 'warn' }); return }
    wanted.current = true
    try {
      const t = await startTake(rt.store, `take:${id}:${Date.now()}`, scope ? `${scope}|field:${id}` : `field:${id}`)
      if (!wanted.current) { await t.cancel(); return }
      take.current = t
      setRecording(true)
      setStartedAt(Date.now())
      if (maxMs) timer.current = setTimeout(() => void end(), maxMs)
    } catch {
      wanted.current = false
      toast({ id: 'sac-mic', text: L.micDenied, tone: 'warn' })
    }
  }
  async function end() {
    wanted.current = false
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    const t = take.current
    if (!t) return
    take.current = null
    setRecording(false)
    const r0 = await t.stop()
    // A take the timer ended is kept at the limit: the recorder reports a little longer than the timer ran.
    const r = maxMs ? { ...r0, ms: Math.min(r0.ms, maxMs) } : r0
    cb.current.onHearing?.(true)
    try {
      if (!cb.current.upload) { cb.current.onKept?.({ key: r.key, ms: r.ms }); return }
      const h = await cb.current.upload(r.key, r.blob, r.ms)
      if ('refused' in h) { toast({ id: 'sac-refused', text: h.refused, tone: 'warn' }); return }
      cb.current.onHeard?.(h)
      if (h.text) cb.current.onChange([latest.current.trim(), h.text].filter(Boolean).join(' '))
    } finally { cb.current.onHearing?.(false) }
  }
  useEffect(() => () => { wanted.current = false; if (timer.current) clearTimeout(timer.current); void take.current?.cancel() }, [])
  // The running time on the button, so a person can see it is listening.
  useEffect(() => {
    if (!recording) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [recording])
  const elapsed = recording ? lengthWords(Math.max(0, Date.now() - startedAt)) : ''

  const control = (
    <button
      type="button"
      data-voice-control=""
      className="sac-record"
      aria-pressed={recording}
      aria-label={canRecord ? `${recording ? L.stopTalking : L.holdToTalk}: ${label}` : `${L.voiceUnavailable}: ${label}`}
      disabled={disabled || !canRecord}
      onClick={() => void (take.current || wanted.current ? end() : begin())}
    >
      <MicIcon />
      <span aria-hidden="true" className="sac-record-words">{recording ? L.recordingShort(elapsed) : L.recordShort}</span>
    </button>
  )
  const shared = { id: `sac-field-${id}`, value, placeholder, disabled, className: 'sac-input', onChange: (e: { target: { value: string } }) => onChange(e.target.value) }
  return (
    <div data-voice-field="" className="sac-voice" data-recording={recording ? '' : undefined}>
      <label htmlFor={`sac-field-${id}`} className="sac-sr">{label}</label>
      {multiline ? <textarea rows={3} {...shared} /> : <input type={type} {...shared} />}
      <div className="sac-voice-bar">
        {control}
        {toolbar}
      </div>
    </div>
  )
}
