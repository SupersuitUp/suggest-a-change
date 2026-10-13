'use client'
// THE SHEET (design section 2): kind, say it, show it, what goes with it, send. Phone first. Everything
// typed is saved as it is typed, every recording as it is made, and nothing leaves the phone except
// through the outbox, so a closed app loses nothing. A voice note alone is a whole report.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { isAcceptedMedia, sanitizeRoute, typeForFile, validateReport } from '../contract.mjs'
import type { Adapters, FieldProps, Kind } from './adapters.ts'
import { useDialog } from './dialog.ts'
import { DefaultField } from './default-field.tsx'
import { draftKey, loadDraft, saveDraft } from './drafts.ts'
import { recoverTakes } from './recorder.ts'
import { queueReport, type PartRef } from './reports.ts'
import { Receipt } from './receipt.tsx'
import { useRuntime, useTick } from './runtime.ts'
import { toast, Toasts } from './toast.tsx'
import { effectiveCeilings, lengthWords, phoneType, screenSize, sizeWords, stringsFor } from './words.ts'

export interface SheetInitial { kind?: Kind; happened?: string }
export interface Voice { key: string; file: string; ms: number; field: string }
export interface Media { key: string; file: string; name: string; type: string; bytes: number; ms?: number }
type Answers = { happened: string; expected: string; steps: string }
const NO_ANSWERS: Answers = { happened: '', expected: '', steps: '' }
type Diag = 'appVersion' | 'at' | 'screen' | 'device'
// The fields of this sheet. A take cut off by a closed app is routed back by its question id, which names
// the draft (app and account), so only the same account's interrupted take rejoins its draft.
const OUR_FIELDS = ['words', 'happened', 'expected', 'steps']

const metaKey = (key: string) => `sac-meta:${key}`
const answersKey = (draft: string) => `${draft}#answers`
const tail = (key: string) => Number(key.slice(key.lastIndexOf(':') + 1)) || 0
const highest = (keys: string[]) => keys.reduce((n, k) => Math.max(n, tail(k)), 0)

/** The length of a video in ms, read by the browser's own player; undefined when it cannot be read in time. */
async function playerLength(file: Blob, probeMs: number): Promise<number | undefined> {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || typeof document === 'undefined') return undefined
  return new Promise((resolve) => {
    const v = document.createElement('video')
    const url = URL.createObjectURL(file)
    let over = false
    const done = (ms?: number) => { if (over) return; over = true; URL.revokeObjectURL(url); resolve(ms) }
    v.preload = 'metadata'
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : undefined)
    v.onerror = () => done(undefined)
    setTimeout(() => done(undefined), probeMs)
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
  return (type ?? '').split('/')[1]?.split(';')[0] || 'bin'
}

export function SuggestSheet({ adapters, where, onClose, initial }: { adapters: Adapters; where: { screen: string; route: string }; onClose?: () => void; initial?: SheetInitial }) {
  const S = stringsFor(adapters.words)
  const Field: React.ComponentType<FieldProps> = adapters.Field ?? DefaultField
  const ceilings = useMemo(() => effectiveCeilings(adapters.limits), [adapters.limits])
  const { rt, who } = useRuntime(adapters)
  const tick = useTick(rt)
  const titleId = useId()
  const box = useRef<HTMLDivElement>(null)
  useDialog(box, onClose)

  const [kind, setKind] = useState<Kind>(initial?.kind ?? 'change')
  const [words, setWords] = useState('')
  const [answers, setAnswers] = useState<Answers>({ ...NO_ANSWERS, happened: initial?.happened ?? '' })
  const [voice, setVoice] = useState<Voice[]>([])
  const [media, setMedia] = useState<Media[]>([])
  // The design's example line is the default: version, screen name (always) and phone type. The time and the screen size are opt-in.
  const [on, setOn] = useState<Record<Diag, boolean>>({ appVersion: true, at: false, screen: false, device: true })
  const [error, setError] = useState('')
  const [announce, setAnnounce] = useState('')
  const [sent, setSent] = useState<{ id: string; files: { file: string; name: string; bytes: number }[] } | null>(null)
  const [loaded, setLoaded] = useState(false)
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  // What is on the sheet, kept in step with state so a second take or picture added a moment later counts the first.
  const voiceRef = useRef<Voice[]>([])
  const mediaRef = useRef<Media[]>([])
  const voiceN = useRef(0)
  const mediaN = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const videoInput = useRef<HTMLInputElement>(null)
  const putVoice = (v: Voice[]) => { voiceRef.current = v; setVoice(v) }
  const putMedia = (m: Media[]) => { mediaRef.current = m; setMedia(m) }

  const key = who ? draftKey({ app: adapters.words.app, account: who.account }) : null

  // Put back what an earlier open left behind, and any take the app was closed in the middle of.
  useEffect(() => {
    if (!rt || !key) return
    let live = true
    void (async () => {
      const d = await loadDraft(rt.store, key)
      if (!live) return
      let takes: Voice[] = []
      let metas: Media[] = []
      if (d && !d.queued) {
        for (const k of d.attachments) {
          const m = await rt.store.get<Media | Voice>('kv', metaKey(k))
          if (m && await rt.store.get('blobs', k)) ('field' in m ? takes : metas).push(m as never)
        }
        const a = (await rt.store.get<Answers>('kv', answersKey(key))) ?? NO_ANSWERS
        if (!live) return
        // "Report a problem" opens as broken whatever kind an earlier draft was.
        if (!initial?.kind && (d.kind === 'change' || d.kind === 'broken' || d.kind === 'feedback')) setKind(d.kind)
        setWords(d.words)
        setAnswers((cur) => ({ ...a, happened: cur.happened || a.happened }))
        if (d.words.trim() || takes.length || metas.length) toast({ id: 'sac-restored', text: S.restored })
      }
      voiceN.current = highest(takes.map((t) => t.key))
      mediaN.current = highest(metas.map((m) => m.key))
      // A take cut off by a closed app is made whole by the recorder; the ones from this sheet's fields rejoin the draft.
      const prefix = `${key}|field:`
      const rescued = await recoverTakes(rt.store, (q) => q.startsWith(prefix) && OUR_FIELDS.includes(q.slice(prefix.length)))
      if (rescued.length) {
        const id = (await saveDraft(rt.store, key, {})).reportId
        for (const t of rescued) {
          const blob = await rt.store.get<Blob>('blobs', t.key)
          if (!blob) continue
          const n = ++voiceN.current
          const k = `voice:${id}:${n}`
          await rt.store.put('blobs', k, blob)
          await rt.store.del('blobs', t.key)
          const v: Voice = { key: k, file: `voice-${n}.${extOf(blob.type, '')}`, ms: t.ms, field: t.questionId.slice(prefix.length) }
          await rt.store.put('kv', metaKey(k), v)
          takes = [...takes, v]
        }
      }
      if (!live) return
      putVoice(takes)
      putMedia(metas)
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

  // A finished take: kept as a copy under this report, and listed. Transcription is the Mac's job.
  const keepTake = useCallback(async (fieldId: string, original: string, blob: Blob, ms: number) => {
    if (!rt || !key) return { refused: S.loading }
    if (ms > ceilings.voiceMs) return { refused: S.voiceTooLong }
    if (voiceRef.current.reduce((n, v) => n + v.ms, 0) + ms > ceilings.voiceTotalMs) return { refused: S.voiceTotalLimit }
    const id = await ensureId()
    const n = ++voiceN.current
    const k = `voice:${id}:${n}`
    await rt.store.put('blobs', k, blob)
    // The copy is the report's; the recorder's own blob goes, so a note is not stored twice.
    if (original && original !== k) await rt.store.del('blobs', original)
    const v: Voice = { key: k, file: `voice-${n}.${extOf(blob.type, '')}`, ms, field: fieldId }
    await rt.store.put('kv', metaKey(k), v)
    putVoice([...voiceRef.current, v])
    setAnnounce(S.voiceNoteKept(voiceRef.current.length))
    return { audio: k, text: '' }
  }, [rt, key, ceilings, ensureId, S])

  function fieldFor(id: string, label: string, value: string, set: (v: string) => void, opts: { placeholder?: string; multiline?: boolean } = {}) {
    const used = voice.reduce((n, v) => n + v.ms, 0)
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
        startTake={adapters.startTake}
        labels={{ holdToTalk: S.holdToTalk, stopTalking: S.stopTalking, micDenied: S.micDenied, voiceUnavailable: S.voiceUnavailable, voiceTotalLimit: S.voiceTotalLimit }}
        scope={key ?? undefined}
        maxMs={Math.min(ceilings.voiceMs, Math.max(0, ceilings.voiceTotalMs - used))}
        upload={(k, blob, ms) => keepTake(id, k, blob, ms)}
      />
    )
  }

  async function lengthOf(file: Blob) {
    return adapters.phone?.videoLength ? adapters.phone.videoLength(file) : playerLength(file, adapters.phone?.probeMs ?? 3000)
  }

  async function addMedia(files: File[], what: 'image' | 'video') {
    if (!rt) return
    setError('')
    const id = await ensureId()
    const limit = what === 'image' ? ceilings.images : ceilings.videos
    for (const f of files) {
      const name = f.name || what
      // The browser's type, or (a HEIC from an iPhone can come with none) the one the extension names.
      const type = typeForFile(f.type, f.name)
      if (type.startsWith(`${what}/`) && !isAcceptedMedia(type)) { setError(S.notAccepted(name)); continue }
      if (!type.startsWith(`${what}/`)) { setError(what === 'image' ? S.notPicture(name) : S.notVideo(name)); continue }
      if (mediaRef.current.filter((m) => m.type.startsWith(`${what}/`)).length >= limit) { setError(what === 'image' ? S.upToImages(ceilings.images) : S.oneVideoOnly); break }
      const ceiling = what === 'image' ? ceilings.imageBytes : ceilings.videoBytes
      if (f.size > ceiling) { setError(S.overSize(name, Math.round(ceiling / 2 ** 20))); continue }
      let ms: number | undefined
      if (what === 'video') {
        ms = await lengthOf(f)
        if (ms == null) { setError(S.videoUnreadable(name)); continue }
        if (ms > ceilings.videoMs) { setError(S.videoTooLong(name, Math.round(ceilings.videoMs / 1000))); continue }
      }
      const n = ++mediaN.current
      const k = `att:${id}:${n}`
      const m: Media = { key: k, file: `${what}-${n}.${extOf(type, f.name)}`, name, type, bytes: f.size, ...(ms != null ? { ms } : {}) }
      await rt.store.put('blobs', k, f)
      await rt.store.put('kv', metaKey(k), m)
      putMedia([...mediaRef.current, m])
    }
  }

  async function takeScreenshot() {
    try {
      const blob = await adapters.snapshot!()
      await addMedia([new File([blob], 'screenshot.png', { type: blob.type || 'image/png' })], 'image')
    } catch { setError(S.screenshotFailed) }
  }

  async function removeMedia(m: Media) {
    putMedia(mediaRef.current.filter((x) => x.key !== m.key))
    await rt?.store.del('blobs', m.key)
    await rt?.store.del('kv', metaKey(m.key))
    setAnnounce(S.attachmentRemoved(m.name))
  }
  async function removeVoice(v: Voice) {
    putVoice(voiceRef.current.filter((x) => x.key !== v.key))
    await rt?.store.del('blobs', v.key)
    await rt?.store.del('kv', metaKey(v.key))
    setAnnounce(S.voiceNoteRemoved)
  }

  // What goes with it: exactly the contract's four diagnostics, each with a switch that really removes it.
  // Where the person was (the screen's name and address) is what the report is about, so it is always sent and shown as such.
  const avail = ([
    { name: 'appVersion', label: S.diagAppVersion, value: adapters.about?.version },
    { name: 'at', label: S.diagAt, value: new Date(adapters.phone?.now?.() ?? Date.now()).toISOString() },
    { name: 'screen', label: S.diagScreen, value: screenSize() },
    { name: 'device', label: S.diagDevice, value: adapters.device ? adapters.device() : phoneType() },
  ] as { name: Diag; label: string; value: string | undefined }[]).filter((d): d is { name: Diag; label: string; value: string } => Boolean(d.value))
  // The design's order: the app's version, this screen's name (always), then whatever else is on, phone type last.
  const isOn = (n: Diag) => avail.find((d) => d.name === n && on[d.name])?.label
  const lineParts = [isOn('appVersion'), S.screenName, isOn('at'), isOn('screen'), isOn('device')].filter((x): x is string => Boolean(x))
  const summary = `${S.goesTo(adapters.words.owner)} ${S.includes(lineParts)}`

  // Answers to the broken questions only count while the kind is broken: they are not sent otherwise.
  const hasAnything = Boolean(words.trim() || voice.length || media.length || (kind === 'broken' && (answers.happened.trim() || answers.expected.trim() || answers.steps.trim())))

  async function send() {
    if (!rt || !who || !key || !hasAnything) return
    setError('')
    await chain.current
    const d = await saveDraft(rt.store, key, { kind, words, attachments: [...voice.map((v) => v.key), ...media.map((m) => m.key)] })
    const diagnostics: Record<string, string> = {}
    for (const x of avail) if (on[x.name]) diagnostics[x.name] = x.value
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
    // The checks above already speak in plain words; if the contract still objects, say so without its wording.
    if (validateReport(report, { ceilings }).length) { setError(S.overLimit); return }
    const partRefs: PartRef[] = [
      ...voice.map((v) => ({ file: v.file, part: 0, blob: v.key })),
      ...media.map((m) => ({ file: m.file, part: 0, blob: m.key })),
    ]
    await queueReport({ store: rt.store, outbox: rt.outbox, report, parts: partRefs, draft: key, ...(adapters.phone?.now ? { now: adapters.phone.now } : {}) })
    await rt.store.del('kv', answersKey(key))
    for (const v of voice) await rt.store.del('kv', metaKey(v.key))
    for (const m of media) await rt.store.del('kv', metaKey(m.key))
    setSent({ id: report.id, files: [...voice.map((v, i) => ({ file: v.file, name: S.voiceNote(i + 1, lengthWords(v.ms)), bytes: 0 })), ...media.map((m) => ({ file: m.file, name: m.name, bytes: m.bytes }))] })
    void rt.drain()
  }

  // The unmounted Send button takes focus with it: the receipt takes it instead.
  useEffect(() => { if (sent) box.current?.querySelector<HTMLElement>('[data-receipt]')?.focus() }, [sent])

  // Progress for each attachment, announced.
  void tick
  const states = sent && rt ? sent.files.map((f) => rt.part(sent.id, f.file).state) : []
  useEffect(() => {
    if (!sent || !states.length) return
    const sentCount = states.filter((s) => s === 'sent').length
    if (states.includes('failed')) setAnnounce(S.attachmentFailed)
    else setAnnounce(sentCount === states.length ? S.attachmentsAllSent : S.attachmentsSending(sentCount, states.length))
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
        <div className="sac-sr" data-sac-live="" role="status" aria-live="polite" aria-atomic="true">{announce}</div>
        {who === undefined ? <p>{S.loading}</p> : who === null ? <p role="alert">{S.signedOut}</p> : !rt ? <p>{S.loading}</p> : sent ? (
          <div className="sac-sent">
            <Receipt adapters={adapters} reportId={sent.id} quiet onLine={setAnnounce} />
            {sent.files.length ? (
              <ul className="sac-list" aria-label={S.attachmentsLabel}>
                {sent.files.map((f) => {
                  const p = rt.part(sent.id, f.file)
                  return (
                    <li key={f.file} className="sac-item" data-attachment-state={p.state}>
                      <span className="sac-item-name">{f.name}{f.bytes ? `, ${sizeWords(f.bytes)}` : ''}</span>
                      <span className="sac-item-state">
                        {p.state === 'sending' ? <progress aria-label={`${S.sending} ${f.name}`} /> : null}
                        {p.state === 'waiting' ? S.waitingToSend : p.state === 'sending' ? S.sending : p.state === 'sent' ? S.sentWord : S.didNotSend(p.reason ?? '')}
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
                <ul className="sac-list" aria-label={S.voiceNotesLabel}>
                  {voice.map((v, i) => (
                    <li key={v.key} className="sac-item">
                      <span className="sac-item-name">{S.voiceNote(i + 1, lengthWords(v.ms))}</span>
                      <button type="button" className="sac-button" aria-label={`${S.remove} ${S.voiceNote(i + 1, lengthWords(v.ms))}`} onClick={() => void removeVoice(v)}>{S.remove}</button>
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
                <ul className="sac-list" aria-label={S.attachmentsLabel}>
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
              <p className="sac-muted" data-sac-where="">{S.alwaysSent(where.screen, sanitizeRoute(where.route))}</p>
              {avail.map((d) => (
                <label key={d.name} className="sac-switch">
                  <input type="checkbox" role="switch" checked={on[d.name]} aria-label={S.include(d.label)} onChange={(e) => setOn((cur) => ({ ...cur, [d.name]: e.target.checked }))} />
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
