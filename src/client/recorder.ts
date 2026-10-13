// A take, recorded on the phone and written to the phone's database AS IT IS MADE: every second of
// sound is a chunk in IndexedDB, so a closed app, a call coming in or a dead battery mid-take loses
// at most the last second. `recoverTakes` turns any take that was never stopped back into a whole
// take on the next open.
import type { Store } from './idb.ts'

export function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  for (const m of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']) if (MediaRecorder.isTypeSupported?.(m)) return m
  return ''
}

interface Meta { questionId: string; mime: string; startedAt: number }
export interface Recorded { key: string; blob: Blob; ms: number }

export async function startTake(store: Store, key: string, questionId: string) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
  const mime = pickMime()
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64_000 } : undefined)
  const type = rec.mimeType || mime || 'audio/webm'
  const started = Date.now()
  const chunks: Blob[] = []
  const writes: Promise<void>[] = []
  await store.put('kv', `rec:${key}`, { questionId, mime: type, startedAt: started } satisfies Meta)
  rec.ondataavailable = (e) => {
    if (!e.data?.size) return
    const seq = chunks.length
    chunks.push(e.data)
    writes.push(store.put('blobs', `${key}#${String(seq).padStart(5, '0')}`, e.data).catch(() => {}))
  }
  rec.start(1000)
  const meter = makeMeter(stream)
  const release = () => { meter?.close(); stream.getTracks().forEach((t) => t.stop()) }
  return {
    started,
    /** The input's loudness now, 0 to 1 (RMS of the waveform), or null where the browser cannot measure it. */
    level: (): number | null => meter?.level() ?? null,
    stop: () => new Promise<Recorded>((resolve) => {
      rec.onstop = async () => {
        release()
        await Promise.all(writes)
        const blob = new Blob(chunks, { type })
        await store.put('blobs', key, blob)
        for (let i = 0; i < chunks.length; i++) await store.del('blobs', `${key}#${String(i).padStart(5, '0')}`)
        await store.del('kv', `rec:${key}`)
        resolve({ key, blob, ms: Date.now() - started })
      }
      try { rec.stop() } catch { rec.onstop?.(new Event('stop')) }
    }),
    async cancel() {
      rec.ondataavailable = null
      rec.onstop = null
      try { rec.stop() } catch { /* already stopped */ }
      release()
      await Promise.all(writes)
      for (let i = 0; i < chunks.length; i++) await store.del('blobs', `${key}#${String(i).padStart(5, '0')}`)
      await store.del('kv', `rec:${key}`)
    },
  }
}

/** The live input level through an AnalyserNode. Null when there is no Web Audio (tests, old browsers):
 *  the take still records, only the level ring and the no-speech warning are skipped. */
function makeMeter(stream: MediaStream): { level(): number; close(): void } | null {
  const AC = (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
    ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return null
  try {
    const ctx = new AC()
    const src = ctx.createMediaStreamSource(stream)
    const an = ctx.createAnalyser()
    an.fftSize = 1024
    src.connect(an)
    const buf = new Float32Array(an.fftSize)
    // iOS starts an AudioContext suspended outside a gesture; this one is made inside the tap.
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    return {
      level() {
        an.getFloatTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
        return Math.min(1, Math.sqrt(sum / buf.length))
      },
      close() { try { src.disconnect(); void ctx.close() } catch { /* already closed */ } },
    }
  } catch { return null }
}

/** Takes the app was closed in the middle of, made whole again. */
export async function recoverTakes(store: Store): Promise<{ questionId: string; key: string; ms: number }[]> {
  const out: { questionId: string; key: string; ms: number }[] = []
  // By prefix: this runs before the first paint, and `kv` also holds every saved view.
  const metas = (await store.all<Meta>('kv', 'rec:')).filter((r) => r.key.startsWith('rec:'))
  if (!metas.length) return out
  const blobs = await store.all<Blob>('blobs')
  for (const { key: metaKey, value: m } of metas) {
    const key = metaKey.slice(4)
    const parts = blobs.filter((b) => b.key.startsWith(`${key}#`)).sort((a, b) => a.key.localeCompare(b.key))
    if (parts.length) {
      await store.put('blobs', key, new Blob(parts.map((p) => p.value), { type: m.mime }))
      for (const p of parts) await store.del('blobs', p.key)
      out.push({ questionId: m.questionId, key, ms: parts.length * 1000 })
    }
    await store.del('kv', metaKey)
  }
  return out
}
