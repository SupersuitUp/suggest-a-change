'use client'
// THE MODULE'S OWN VOICE FIELD, for hosted apps that have no golden one. A text area with its microphone
// INSIDE the box (bottom right; centred at the right of a one-line input), in one [data-voice-field]
// container with nothing else typeable in it. A take is
// recorded with the module's recorder (written to the phone's database as it is made). Transcription is
// not done here: the take goes to `upload`, and the receiving Mac writes the transcript. A voice note
// alone is a whole report, so a field with no words and one take is a complete answer.
//
// A tap starts a take that keeps recording until the next tap (or the time limit); a press held longer
// than a tap records until it is let go, as hold-to-talk always did. Leaving the button, or a pointer the
// browser cancels (iOS Safari does when its microphone prompt appears), never ends a tapped take. The
// recorder is asked synchronously inside the press, with nothing awaited first, so iOS Safari treats the
// microphone request as part of the gesture. Space or Enter on the focused button starts and stops a take.
// (The operator, 2026-10-26: a tap on the hold-only button did nothing, because the release ended the take
// before the microphone had answered.)
import { useEffect, useRef, useState } from 'react'
import type { FieldProps } from './adapters.ts'
import { startTake as defaultStartTake } from './recorder.ts'
import { toast } from './toast.tsx'
import { DEFAULT_STRINGS } from './words.ts'


type Take = Awaited<ReturnType<typeof defaultStartTake>>
/** A press shorter than this is a tap: it starts a take that a second tap stops. */
const TAP_MS = 350

export function DefaultField(props: FieldProps) {
  const { rt, id, label, value, onChange, placeholder, multiline = false, type = 'text', upload, onHeard, onKept, onHearing, disabled, startTake = defaultStartTake, maxMs, labels, scope } = props
  const L = labels ?? DEFAULT_STRINGS
  // With nowhere to send a take, recording would lose it silently: the control stays, switched off, and says why.
  const canRecord = Boolean(upload || onKept)
  const [recording, setRecording] = useState(false)
  const take = useRef<Take | null>(null)
  const wanted = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The press in progress that started a take: when it began. Null between presses, and for a press that stopped one.
  const press = useRef<number | null>(null)
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

  const control = (
    <button
      type="button"
      data-voice-control=""
      className="sac-record"
      aria-pressed={recording}
      aria-label={canRecord ? `${recording ? L.stopTalking : L.holdToTalk}: ${label}` : `${L.voiceUnavailable}: ${label}`}
      disabled={disabled || !canRecord}
      onPointerDown={(e) => {
        e.preventDefault()
        // A take already going (a tapped one): this press stops it.
        if (take.current || wanted.current) { press.current = null; void end(); return }
        press.current = Date.now()
        void begin() // startTake is called before begin's first await: still inside the gesture
      }}
      onPointerUp={() => {
        const at = press.current
        press.current = null
        // A tap keeps recording until the next tap; a hold stops on release.
        if (at !== null && Date.now() - at >= TAP_MS) void end()
      }}
      onPointerLeave={() => {
        // Sliding off a held press stops it, as hold-to-talk did; a tapped take, or one still starting, goes on.
        const at = press.current
        press.current = null
        if (at !== null && take.current && Date.now() - at >= TAP_MS) void end()
      }}
      onPointerCancel={() => {
        // The browser took the pointer (a permission prompt, a scroll): the take carries on as a tapped one.
        press.current = null
      }}
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
      <label htmlFor={`sac-field-${id}`} className="sac-sr">{label}</label>
      <div className={`sac-voice-box ${multiline ? 'sac-voice-multi' : 'sac-voice-single'}`}>
        {multiline ? <textarea rows={3} {...shared} /> : <input type={type} {...shared} />}
        {control}
      </div>
    </div>
  )
}
