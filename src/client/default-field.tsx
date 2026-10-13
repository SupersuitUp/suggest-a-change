// THE MODULE'S OWN VOICE FIELD, for hosted apps that have no golden one. A text area with a hold-to-talk
// button beside it, in one [data-voice-field] container with nothing else typeable in it. A take is
// recorded with the module's recorder (written to the phone's database as it is made). Transcription is
// not done here: the take goes to `upload`, and the receiving Mac writes the transcript. A voice note
// alone is a whole report, so a field with no words and one take is a complete answer.
//
// Holding the button records; letting go (or leaving it) stops. For anyone who cannot hold, Space or
// Enter on the focused button starts a take and again stops it.
import { useEffect, useRef, useState } from 'react'
import type { FieldProps } from './adapters.ts'
import { startTake as defaultStartTake } from './recorder.ts'
import { toast } from './toast.tsx'
import { DEFAULT_STRINGS } from './words.ts'

type Take = Awaited<ReturnType<typeof defaultStartTake>>

export function DefaultField(props: FieldProps) {
  const { rt, id, label, value, onChange, placeholder, multiline = false, type = 'text', upload, onHeard, onKept, onHearing, disabled, startTake = defaultStartTake, maxMs } = props
  const [recording, setRecording] = useState(false)
  const take = useRef<Take | null>(null)
  const wanted = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef(value)
  latest.current = value
  const cb = useRef({ onChange, upload, onHeard, onKept, onHearing })
  cb.current = { onChange, upload, onHeard, onKept, onHearing }

  async function begin() {
    if (take.current || wanted.current || disabled) return
    wanted.current = true
    try {
      const t = await startTake(rt.store, `take:${id}:${Date.now()}`, `field:${id}`)
      if (!wanted.current) { await t.cancel(); return }
      take.current = t
      setRecording(true)
      if (maxMs) timer.current = setTimeout(() => void end(), maxMs)
    } catch {
      wanted.current = false
      toast({ id: 'sac-mic', text: DEFAULT_STRINGS.micDenied, tone: 'warn' })
    }
  }
  async function end() {
    wanted.current = false
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    const t = take.current
    if (!t) return
    take.current = null
    setRecording(false)
    const r = await t.stop()
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

  const control = (
    <button
      type="button"
      data-voice-control=""
      className="sac-record"
      aria-pressed={recording}
      aria-label={`${recording ? DEFAULT_STRINGS.stopTalking : DEFAULT_STRINGS.holdToTalk}: ${label}`}
      disabled={disabled}
      onPointerDown={(e) => { e.preventDefault(); void begin() }}
      onPointerUp={() => void end()}
      onPointerLeave={() => { if (wanted.current) void end() }}
      onPointerCancel={() => void end()}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key !== ' ' && e.key !== 'Enter') return
        e.preventDefault()
        if (e.repeat) return
        void (take.current || wanted.current ? end() : begin())
      }}
    >
      <span aria-hidden="true" className="sac-record-dot" />
    </button>
  )
  const shared = { id: `sac-field-${id}`, value, placeholder, disabled, className: 'sac-input', onChange: (e: { target: { value: string } }) => onChange(e.target.value) }
  return (
    <div data-voice-field="" className="sac-voice" data-recording={recording ? '' : undefined}>
      {control}
      <label htmlFor={`sac-field-${id}`} className="sac-sr">{label}</label>
      {multiline ? <textarea rows={3} {...shared} /> : <input type={type} {...shared} />}
    </div>
  )
}
