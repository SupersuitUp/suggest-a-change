// Runs in Node's own environment: it has a Blob that survives IndexedDB's structured clone with its bytes, which jsdom's does not.
// An interrupted recording is recovered. Only the microphone (a fake MediaRecorder) and IndexedDB
// (fake-indexeddb) are stand-ins. 
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openStore } from '../../src/client/idb.ts'
import { LIVE_TAKE_MS, recoverTakes, startTake } from '../../src/client/recorder.ts'

const recorders: FakeRecorder[] = []
class FakeRecorder {
  static isTypeSupported = (m: string) => m === 'audio/mp4'
  mimeType = 'audio/mp4'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: ((e: Event) => void) | null = null
  state = 'inactive'
  constructor() { recorders.push(this) }
  start() { this.state = 'recording' }
  /** One second of sound, as the browser hands it over with a 1 s timeslice. */
  second(n: number) { this.ondataavailable?.({ data: new Blob([`sound-${n}`], { type: 'audio/mp4' }) }) }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['last'], { type: 'audio/mp4' }) }); this.onstop?.(new Event('stop')) }
}
beforeEach(() => {
  recorders.length = 0
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } })
})
afterEach(() => { vi.unstubAllGlobals() })

let n = 0
const fresh = () => openStore(`rec-${++n}`)
const read = (b: Blob) => b.text()
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('the recorder', () => {
  it('an interrupted recording is recovered as a whole take on the next open', async () => {
    const store = await fresh()
    const take = await startTake(store, 'take-1', 'q-1')
    for (let i = 0; i < 3; i++) recorders[0].second(i)
    await settle()
    expect((await store.all('blobs')).length).toBe(3)
    // The page dies: no stop, no cleanup. The next open has a new connection to the same database.
    recorders[0].ondataavailable = null
    void take
    const next = await openStore(`rec-${n}`)
    // Opened at once, the take still reads as live in some tab, and is left alone.
    expect(await recoverTakes(next)).toEqual([])
    expect((await next.all('blobs')).length).toBe(3)
    // Opened once it has gone quiet, it is made whole.
    const later = { now: Date.now() + LIVE_TAKE_MS + 1 }
    const got = await recoverTakes(next, undefined, later)
    expect(got).toEqual([{ questionId: 'q-1', key: 'take-1', ms: 3000 }])
    const whole = await next.get<Blob>('blobs', 'take-1')
    expect(whole).toBeDefined()
    expect(await read(whole!)).toBe('sound-0sound-1sound-2')
    expect((await next.all('blobs')).map((r) => r.key)).toEqual(['take-1'])
    expect(await next.get('kv', 'rec:take-1')).toBeUndefined()
    // Recovering again finds nothing: a take is made whole once.
    expect(await recoverTakes(next, undefined, later)).toEqual([])
  })

  it('recovery can be limited to the takes the caller owns; the rest stay exactly as they were', async () => {
    const store = await fresh()
    await store.put('kv', 'rec:mine-1', { questionId: 'a|q', mime: 'audio/webm', startedAt: 1 })
    await store.put('blobs', 'mine-1#00000', new Blob(['x']))
    await store.put('kv', 'rec:theirs-1', { questionId: 'b|q', mime: 'audio/webm', startedAt: 1 })
    await store.put('blobs', 'theirs-1#00000', new Blob(['y']))
    expect((await recoverTakes(store, (q) => q.startsWith('a|'))).map((t) => t.key)).toEqual(['mine-1'])
    expect(await store.get('kv', 'rec:theirs-1')).toBeDefined()
    expect(await store.get('blobs', 'theirs-1#00000')).toBeDefined()
    expect((await recoverTakes(store, (q) => q.startsWith('b|'))).map((t) => t.key)).toEqual(['theirs-1'])
  })

  it('a take stopped normally is one blob, and leaves no chunks or marker behind', async () => {
    const store = await fresh()
    const take = await startTake(store, 'take-2', 'q-2')
    recorders[0].second(0)
    const rec = await take.stop()
    expect(rec.key).toBe('take-2')
    expect(await read(rec.blob)).toBe('sound-0last')
    expect((await store.all('blobs')).map((r) => r.key)).toEqual(['take-2'])
    expect(await recoverTakes(store)).toEqual([])
  })

  it('a cancelled take leaves nothing on the phone', async () => {
    const store = await fresh()
    const take = await startTake(store, 'take-3', 'q-3')
    recorders[0].second(0)
    await take.cancel()
    expect(await store.all('blobs')).toEqual([])
    expect(await store.get('kv', 'rec:take-3')).toBeUndefined()
  })

  it('a take that was begun but never heard is cleared without inventing a recording', async () => {
    const store = await fresh()
    await startTake(store, 'take-4', 'q-4')
    expect(await recoverTakes(await openStore(`rec-${n}`), undefined, { now: Date.now() + LIVE_TAKE_MS + 1 })).toEqual([])
    expect(await store.get('kv', 'rec:take-4')).toBeUndefined()
  })

  it("a second tab opening while the first records leaves the first tab's take alone, and the take ends whole (freedom-app-template#1)", async () => {
    const store = await fresh()
    const take = await startTake(store, 'take-5', 'review:r1')
    recorders[0].second(0)
    recorders[0].second(1)
    await settle()
    // Tab B opens on the same database while tab A is still recording: its boot runs recovery.
    const tabB = await openStore(`rec-${n}`)
    expect(await recoverTakes(tabB)).toEqual([])
    expect(await tabB.get('kv', 'rec:take-5')).toBeDefined()
    expect((await tabB.all('blobs')).map((r) => r.key).sort()).toEqual(['take-5#00000', 'take-5#00001'])
    // Tab A keeps talking and stops normally: one whole take, nothing recovered twice.
    recorders[0].second(2)
    const rec = await take.stop()
    expect(await read(rec.blob)).toBe('sound-0sound-1sound-2last')
    expect(await recoverTakes(tabB, undefined, { now: Date.now() + LIVE_TAKE_MS + 1 })).toEqual([])
  })

  it('every second of a take refreshes its heartbeat, so a long take is never mistaken for abandoned', async () => {
    const store = await fresh()
    await startTake(store, 'take-6', 'q-6')
    const first = (await store.get<{ beatAt: number }>('kv', 'rec:take-6'))!.beatAt
    await new Promise((r) => setTimeout(r, 15))
    recorders[0].second(0)
    await settle()
    const beat = (await store.get<{ beatAt: number; startedAt: number }>('kv', 'rec:take-6'))!
    expect(beat.beatAt).toBeGreaterThan(first)
    expect(beat.startedAt).toBe(first)
  })
})
