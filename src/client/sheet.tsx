// THE SHEET (design section 2): kind, say it, show it, what goes with it, send. Phone first. Everything
// typed is saved as it is typed, every recording as it is made, and nothing leaves the phone except
// through the outbox, so a closed app loses nothing. A voice note alone is a whole report.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { sanitizeRoute, validateReport } from '../contract.mjs'
import type { Adapters, FieldProps, Identity, Kind } from './adapters.ts'
import { useDialog } from './dialog.ts'
import { DefaultField } from './default-field.tsx'
import { draftKey, loadDraft, saveDraft } from './drafts.ts'
import { queueReport, type PartRef } from './reports.ts'
import { Receipt } from './receipt.tsx'
import { useRuntime, useTick } from './runtime.ts'
import { toast, Toasts } from './toast.tsx'
import { effectiveCeilings, lengthWords, sizeWords, stringsFor } from './words.ts'

export interface SheetInitial { kind?: Kind; happened?: string }
export interface Voice { key: string; file: string; ms: number; field: string }
export interface Media { key: string; file: string; name: string; type: string; bytes: number; ms?: number }
type Answers = { happened: string; expected: string; steps: string }
const NO_ANSWERS: Answers = { happened: '', expected: '', steps: '' }
type Diag = 'appVersion' | 'at' | 'screen' | 'device'

const metaKey = (key: string) => `sac-meta:${key}`
const answersKey = (draft: string) => `${draft}#answers`

async function videoMs(file: Blob): Promise<number | undefined> {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || typeof document === 'undefined') return undefined
  return new Promise((resolve) => {
    const v = document.createElement('video')
    const url = URL.createObjectURL(file)
    const done = (ms?: number) => { URL.revokeObjectURL(url); resolve(ms) }
    v.preload = 'metadata'
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : undefined)
    v.onerror = () => done(undefined)
    setTimeout(() => done(undefined), 3000)
    v.src = url
  })
}

async function fingerprint(blob: Blob): Promise<string | undefined> {
  try {
    const buf = await blob.arrayBuffer()
    const h = await crypto.subtle.digest('SHA-256', buf)
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch { return undefined }
}

const extOf = (type: string, name: string) => {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name)
  if (m) return m[1].toLowerCase()
  return type.split('/')[1]?.split(';')[0] ?? 'bin'
}

export function SuggestSheet({ adapters, where, onClose, initial }: { adapters: Adapters; where: { screen: string; route: string }; onClose?: () => void; initial?: SheetInitial }) {
  const S = stringsFor(adapters.words)
  const Field: React.ComponentType<FieldProps> = adapters.Field ?? DefaultField
  const ceilings = useMemo(() => effectiveCeilings(adapters.limits), [adapters.limits])
  const rt = useRuntime(adapters)
  const tick = useTick(rt)
  const titleId = useId()
  const box = useRef<HTMLDivElement>(null)
  useDialog(box, onClose)

  const [who, setWho] = useState<Identity | null | undefined>(undefined)
  const [kind, setKind] = useState<Kind>(initial?.kind ?? 'change')
  const [words, setWords] = useState('')
  const [answers, setAnswers] = useState<Answers>({ ...NO_ANSWERS, happened: initial?.happened ?? '' })
  const [voice, setVoice] = useState<Voice[]>([])
  const [media, setMedia] = useState<Media[]>([])
  const [on, setOn] = useState<Record<Diag, boolean>>({ appVersion: true, at: true, screen: true, device: true })
  const [error, setError] = useState('')
  const [announce, setAnnounce] = useState('')
  const [sent, setSent] = useState<{ id: string; files: { file: string; name: string; bytes: number }[] } | null>(null)
  const [loaded, setLoaded] = useState(false)
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const voiceN = useRef(0)
  const mediaN = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const videoInput = useRef<HTMLInputElement>(null)

  useEffect(() => { let live = true; void adapters.identity().then((w) => { if (live) setWho(w) }, () => { if (live) setWho(null) }); return () => { live = false } }, [adapters])

  const key = who ? draftKey({ app: adapters.words.app, account: who.account }) : null

  // Put back what an earlier open left behind.
  useEffect(() => {
    if (!rt || !key) return
    let live = true
    void (async () => {
      const d = await loadDraft(rt.store, key)
      if (!live) return
      if (d && !d.queued) {
        const metas: Media[] = []
        const takes: Voice[] = []
        for (const k of d.attachments) {
          const m = await rt.store.get<Media | Voice>('kv', metaKey(k))
          if (m && await rt.store.get('blobs', k)) ('field' in m ? takes : metas).push(m as never)
        }
        const a = (await rt.store.get<Answers>('kv', answersKey(key))) ?? NO_ANSWERS
        if (!live) return
        if (d.kind === 'change' || d.kind === 'broken' || d.kind === 'feedback') setKind(d.kind)
        setWords(d.words)
        setAnswers((cur) => ({ ...a, happened: a.happened || cur.happened }))
        setVoice(takes)
        setMedia(metas)
        voiceN.current = takes.length
        mediaN.current = metas.length
        if (d.words.trim() || takes.length || metas.length) toast({ id: 'sac-restored', text: S.restored })
      }
      setLoaded(true)
    })()
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rt, key])

  // Words are saved as they are typed, a recording as it is made. Writes run one after another.
  useEffect(() => {
    if (!rt || !key || !loaded || sent) return
    const fields = { kind, words, attachments: [...voice.map((v) => v.key), ...media.map((m) => m.key)] }
    chain.current = chain.current.then(async () => {
      await saveDraft(rt.store, key, fields)
      await rt.store.put('kv', answersKey(key), answers)
    }).catch(() => {})
  }, [rt, key, loaded, sent, kind, words, answers, voice, media])

  const ensureId = useCallback(async () => {
    await chain.current
    return (await saveDraft(rt!.store, key!, {})).reportId
  }, [rt, key])

  const totalVoice = voice.reduce((n, v) => n + v.ms, 0)

  // A finished take: kept as a copy under this report, and listed. Transcription is the Mac's job.
  const keepTake = useCallback(async (fieldId: string, blob: Blob, ms: number) => {
    if (!rt || !key) return { refused: S.loading }
    if (ms > ceilings.voiceMs) return { refused: 'That recording is longer than the limit.' }
    if (totalVoice + ms > ceilings.voiceTotalMs) return { refused: 'Voice notes are at their limit; type the rest.' }
    const id = await ensureId()
    const n = ++voiceN.current
    const k = `voice:${id}:${n}`
    await rt.store.put('blobs', k, blob)
    const v: Voice = { key: k, file: `voice-${n}.${extOf(blob.type, '')}`, ms, field: fieldId }
    await rt.store.put('kv', metaKey(k), v)
    setVoice((cur) => [...cur, v])
    setAnnounce(`Voice note ${n} kept, ${lengthWords(ms)}.`)
    return { audio: k, text: '' }
  }, [rt, key, voice.length, totalVoice, ceilings, ensureId, S.loading])

  function fieldFor(id: string, label: string, value: string, set: (v: string) => void, opts: { placeholder?: string; multiline?: boolean } = {}) {
    return (
      <Field
        rt={{ store: rt!.store }}
        id={id}
        label={label}
        value={value}
        onChange={set}
        placeholder={opts.placeholder}
        multiline={opts.multiline ?? true}
        persist={false}
        maxMs={Math.min(ceilings.voiceMs, Math.max(0, ceilings.voiceTotalMs - totalVoice))}
        upload={(_k, blob, ms) => keepTake(id, blob, ms)}
      />
    )
  }

  async function addMedia(files: File[], what: 'image' | 'video') {
    if (!rt) return
    setError('')
    const id = await ensureId()
    const counted = media.filter((m) => m.type.startsWith(`${what}/`)).length
    let added = 0
    for (const f of files) {
      const type = f.type || ''
      if (!type.startsWith(`${what}/`)) { setError(`${f.name} is not ${what === 'image' ? 'a picture' : 'a video'}.`); continue }
      if (counted + added >= (what === 'image' ? ceilings.images : ceilings.videos)) { setError(what === 'image' ? `Up to ${ceilings.images} pictures.` : `One video at most.`); break }
      if (f.size > (what === 'image' ? ceilings.imageBytes : ceilings.videoBytes)) { setError(`${f.name} is over ${sizeWords(what === 'image' ? ceilings.imageBytes : ceilings.videoBytes)}.`); continue }
      let ms: number | undefined
      if (what === 'video') {
        ms = await videoMs(f)
        if (ms != null && ms > ceilings.videoMs) { setError(`${f.name} is longer than ${Math.round(ceilings.videoMs / 1000)} seconds.`); continue }
      }
      const n = ++mediaN.current
      const k = `att:${id}:${n}`
      const m: Media = { key: k, file: `${what}-${n}.${extOf(type, f.name)}`, name: f.name || `${what} ${n}`, type, bytes: f.size, ...(ms != null ? { ms } : {}) }
      await rt.store.put('blobs', k, f)
      await rt.store.put('kv', metaKey(k), m)
      setMedia((cur) => [...cur, m])
      added++
    }
  }

  async function takeScreenshot() {
    try {
      const blob = await adapters.snapshot!()
      await addMedia([new File([blob], 'screenshot.png', { type: blob.type || 'image/png' })], 'image')
    } catch { setError('The screenshot could not be taken.') }
  }

  async function removeMedia(m: Media) {
    setMedia((cur) => cur.filter((x) => x.key !== m.key))
    await rt?.store.del('blobs', m.key)
    await rt?.store.del('kv', metaKey(m.key))
    setAnnounce(`${m.name} removed.`)
  }
  async function removeVoice(v: Voice) {
    setVoice((cur) => cur.filter((x) => x.key !== v.key))
    await rt?.store.del('blobs', v.key)
    await rt?.store.del('kv', metaKey(v.key))
    setAnnounce('Voice note removed.')
  }

  // What goes with it: only the four names the contract allows, each with a switch.
  const avail = ([
    { name: 'appVersion', label: "the app's version", value: adapters.about?.version },
    { name: 'at', label: 'the time', value: new Date(adapters.phone?.now?.() ?? Date.now()).toISOString() },
    { name: 'screen', label: "this screen's name", value: where.screen },
    { name: 'device', label: 'your phone type', value: adapters.device ? adapters.device() : typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 120) : undefined },
  ] as { name: Diag; label: string; value: string | undefined }[]).filter((d): d is { name: Diag; label: string; value: string } => Boolean(d.value))
  const included = avail.filter((d) => on[d.name])
  const summary = `${S.goesTo(adapters.words.owner)} ${included.length ? S.includes(included.map((d) => d.label)) : S.includesNothing}`

  const hasAnything = Boolean(words.trim() || voice.length || media.length || answers.happened.trim() || answers.expected.trim() || answers.steps.trim())

  async function send() {
    if (!rt || !who || !key || !hasAnything) return
    setError('')
    const d = await (async () => { await chain.current; return saveDraft(rt.store, key, { kind, words, attachments: [...voice.map((v) => v.key), ...media.map((m) => m.key)] }) })()
    const diagnostics: Record<string, string> = {}
    for (const x of included) diagnostics[x.name] = x.value
    const report: Record<string, unknown> & { id: string } = {
      id: d.reportId,
      kind,
      ...(adapters.about ? { app: Object.fromEntries(Object.entries(adapters.about).filter(([k]) => k !== 'version')) } : {}),
      who: { member: who.account, role: who.role },
      words: words.trim(),
      ...(kind === 'broken' ? { answers: { happened: answers.happened.trim(), expected: answers.expected.trim(), steps: answers.steps.trim() } } : {}),
      voice: voice.map((v) => ({ file: v.file, ms: v.ms, field: v.field })),
      media: await Promise.all(media.map(async (m) => {
        const blob = await rt.store.get<Blob>('blobs', m.key)
        const sha = blob ? await fingerprint(blob) : undefined
        return { file: m.file, type: m.type, bytes: m.bytes, ...(m.ms != null ? { ms: m.ms } : {}), ...(sha ? { sha256: sha } : {}) }
      })),
      where: { screen: where.screen, route: sanitizeRoute(where.route) },
      diagnostics,
    }
    const errs = validateReport(report, { ceilings })
    if (errs.length) { setError(errs.join(' ')); return }
    const parts: PartRef[] = [
      ...voice.map((v) => ({ file: v.file, part: 0, blob: v.key })),
      ...media.map((m) => ({ file: m.file, part: 0, blob: m.key })),
    ]
    await queueReport({ store: rt.store, outbox: rt.outbox, report, parts, draft: key, ...(adapters.phone?.now ? { now: adapters.phone.now } : {}) })
    await rt.store.del('kv', answersKey(key))
    for (const v of voice) await rt.store.del('kv', metaKey(v.key))
    for (const m of media) await rt.store.del('kv', metaKey(m.key))
    setSent({ id: report.id, files: [...voice.map((v) => ({ file: v.file, name: `Voice note (${lengthWords(v.ms)})`, bytes: 0 })), ...media.map((m) => ({ file: m.file, name: m.name, bytes: m.bytes }))] })
    void rt.drain()
  }

  // Progress for each attachment, announced.
  void tick
  const progressFor = (file: string) => rt!.part(sent!.id, file)
  const states = sent && rt ? sent.files.map((f) => progressFor(f.file).state) : []
  useEffect(() => {
    if (!sent || !states.length) return
    const sentCount = states.filter((s) => s === 'sent').length
    if (states.includes('failed')) setAnnounce('An attachment did not send.')
    else setAnnounce(sentCount === states.length ? 'All attachments sent.' : `Sending attachments: ${sentCount} of ${states.length} sent.`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [states.join(',')])

  const kinds: { id: Kind; label: string }[] = [
    { id: 'change', label: S.kindChange },
    { id: 'broken', label: S.kindBroken },
    { id: 'feedback', label: S.kindFeedback },
  ]

  return (
    <div className="sac-backdrop" data-suggest-sheet="">
      <div ref={box} className="sac-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="sac-header">
          <h2 id={titleId} className="sac-title">{S.sheetTitle}</h2>
          {onClose ? <button type="button" className="sac-button sac-close" onClick={onClose}>{S.close}</button> : null}
        </header>
        <div className="sac-sr" role="status" aria-live="polite" aria-atomic="true">{announce}</div>
        {who === undefined ? <p>{S.loading}</p> : who === null ? <p role="alert">{S.signedOut}</p> : !rt ? <p>{S.loading}</p> : sent ? (
          <div className="sac-sent">
            <Receipt adapters={adapters} reportId={sent.id} />
            {sent.files.length ? (
              <ul className="sac-list" aria-label="Attachments">
                {sent.files.map((f) => {
                  const p = progressFor(f.file)
                  return (
                    <li key={f.file} className="sac-item" data-attachment-state={p.state}>
                      <span className="sac-item-name">{f.name}{f.bytes ? `, ${sizeWords(f.bytes)}` : ''}</span>
                      <span className="sac-item-state">
                        {p.state === 'sending' ? <progress aria-label={`Sending ${f.name}`} /> : null}
                        {p.state === 'waiting' ? 'Waiting to send' : p.state === 'sending' ? `${S.sending}` : p.state === 'sent' ? 'Sent' : `Did not send: ${p.reason ?? ''}`}
                      </span>
                      {p.state === 'failed' ? <button type="button" className="sac-button" onClick={() => void rt.retry(sent.id)}>{S.retry}</button> : null}
                    </li>
                  )
                })}
              </ul>
            ) : null}
            {onClose ? <button type="button" className="sac-button sac-primary" onClick={onClose}>{S.done}</button> : null}
          </div>
        ) : (
          <form className="sac-form" onSubmit={(e) => { e.preventDefault(); void send() }}>
            <fieldset role="radiogroup" className="sac-group sac-kinds">
              <legend>{S.kindLegend}</legend>
              {kinds.map((k) => (
                <label key={k.id} className="sac-choice">
                  <input type="radio" name="sac-kind" value={k.id} checked={kind === k.id} onChange={() => setKind(k.id)} />
                  <span>{k.label}</span>
                </label>
              ))}
            </fieldset>

            {kind === 'broken' ? (
              <fieldset className="sac-group">
                <legend>{S.kindBroken} ({S.optional})</legend>
                {fieldFor('happened', S.brokenHappened, answers.happened, (v) => setAnswers((a) => ({ ...a, happened: v })))}
                {fieldFor('expected', S.brokenExpected, answers.expected, (v) => setAnswers((a) => ({ ...a, expected: v })))}
                {fieldFor('steps', S.brokenSteps, answers.steps, (v) => setAnswers((a) => ({ ...a, steps: v })))}
              </fieldset>
            ) : null}

            <fieldset className="sac-group">
              <legend>{S.sayItLegend}</legend>
              {fieldFor('words', S.sayItLabel, words, setWords, { placeholder: S.sayItPlaceholder })}
              {voice.length ? (
                <ul className="sac-list" aria-label="Voice notes">
                  {voice.map((v, i) => (
                    <li key={v.key} className="sac-item">
                      <span className="sac-item-name">Voice note {i + 1}, {lengthWords(v.ms)}</span>
                      <button type="button" className="sac-button" aria-label={`${S.remove} voice note ${i + 1}`} onClick={() => void removeVoice(v)}>{S.remove}</button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </fieldset>

            <fieldset className="sac-group">
              <legend>{S.showItLegend}</legend>
              <div className="sac-actions">
                <button type="button" className="sac-button" onClick={() => fileInput.current?.click()}>{S.addImages}</button>
                <button type="button" className="sac-button" onClick={() => videoInput.current?.click()}>{S.addVideo}</button>
                {adapters.snapshot ? <button type="button" className="sac-button" onClick={() => void takeScreenshot()}>{S.takeScreenshot}</button> : null}
              </div>
              <input ref={fileInput} type="file" accept="image/*" multiple hidden aria-label={S.addImages} data-sac-images="" onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; void addMedia(f, 'image') }} />
              <input ref={videoInput} type="file" accept="video/*" hidden aria-label={S.addVideo} data-sac-video="" onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; void addMedia(f, 'video') }} />
              {media.length ? (
                <ul className="sac-list" aria-label="Attachments">
                  {media.map((m) => (
                    <li key={m.key} className="sac-item">
                      <span className="sac-item-name">{m.name}, {sizeWords(m.bytes)}</span>
                      <button type="button" className="sac-button" aria-label={`${S.remove} ${m.name}`} onClick={() => void removeMedia(m)}>{S.remove}</button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </fieldset>

            <fieldset className="sac-group">
              <legend>{S.withLegend}</legend>
              <p className="sac-summary" data-sac-summary="" aria-live="polite">{summary}</p>
              {avail.map((d) => (
                <label key={d.name} className="sac-switch">
                  <input type="checkbox" role="switch" checked={on[d.name]} aria-label={`Include ${d.label}`} onChange={(e) => setOn((cur) => ({ ...cur, [d.name]: e.target.checked }))} />
                  <span>{d.label}: <span className="sac-muted">{d.value}</span></span>
                </label>
              ))}
            </fieldset>

            {error ? <p role="alert" className="sac-error">{error}</p> : null}
            <div className="sac-actions">
              <button type="submit" className="sac-button sac-primary" disabled={!hasAnything} aria-describedby={hasAnything ? undefined : `${titleId}-hint`}>{S.send}</button>
              {hasAnything ? null : <span id={`${titleId}-hint`} className="sac-muted">{S.sendHint}</span>}
            </div>
          </form>
        )}
        <Toasts />
      </div>
    </div>
  )
}
