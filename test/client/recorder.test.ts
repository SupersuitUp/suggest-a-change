// Runs in Node's own environment: it has a Blob that survives IndexedDB's structured clone with its bytes, which jsdom's does not.
// An interrupted recording is recovered. Only the microphone (a fake MediaRecorder) and IndexedDB
// (fake-indexeddb) are stand-ins. 
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openStore } from '../../src/client/idb.ts'
import { recoverTakes, startTake } from '../../src/client/recorder.ts'

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
    const got = await recoverTakes(next)
    expect(got).toEqual([{ questionId: 'q-1', key: 'take-1', ms: 3000 }])
    const whole = await next.get<Blob>('blobs', 'take-1')
    expect(whole).toBeDefined()
    expect(await read(whole!)).toBe('sound-0sound-1sound-2')
    expect((await next.all('blobs')).map((r) => r.key)).toEqual(['take-1'])
    expect(await next.get('kv', 'rec:take-1')).toBeUndefined()
    // Recovering again finds nothing: a take is made whole once.
    expect(await recoverTakes(next)).toEqual([])
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
    expect(await recoverTakes(await openStore(`rec-${n}`))).toEqual([])
    expect(await store.get('kv', 'rec:take-4')).toBeUndefined()
  })
})
