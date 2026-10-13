// @vitest-environment jsdom
// The reachability probe is the host's: `reach` is injected here as a host injects it.
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { openStore } from '../../src/client/idb.ts'
import { makeOutbox, type Op } from '../../src/client/outbox.ts'

let n = 0
const fresh = () => openStore(`t-${++n}`)

describe('the outbox', () => {
  const op = (id: string, over: Partial<Op> = {}): Op => ({ id, kind: 'answer', body: { answerId: id }, at: Date.now(), ...over })

  it('holds writes on the phone while the receiver is away, durably, in order', async () => {
    const store = await fresh()
    const sent: string[] = []
    const ob = makeOutbox({ store, reach: { check: async () => false, mark() {} }, send: async (o) => { sent.push(o.id); return 'done' } })
    await ob.enqueue(op('a-1'))
    await ob.enqueue(op('a-2'))
    await ob.drain()
    expect(sent).toEqual([])
    const again = makeOutbox({ store: await openStore(`t-${n}`), reach: { check: async () => true, mark() {} }, send: async (o) => { sent.push(o.id); return 'done' } })
    expect((await again.pending()).map((o) => o.id)).toEqual(['a-1', 'a-2'])
    await again.drain()
    expect(sent).toEqual(['a-1', 'a-2'])
    expect(await again.pending()).toEqual([])
  })

  it('stops at the first network failure and keeps the rest for the next try', async () => {
    const store = await fresh()
    let marked: boolean | null = null
    const ob = makeOutbox({ store, reach: { check: async () => true, mark(v) { marked = v } }, send: async (o) => { if (o.id === 'a-2') throw new TypeError('Load failed'); return 'done' } })
    for (const id of ['a-1', 'a-2', 'a-3']) await ob.enqueue(op(id))
    await ob.drain()
    expect((await ob.pending()).map((o) => o.id)).toEqual(['a-2', 'a-3'])
    expect(marked).toBe(false)
  })

  it('a write the receiver refuses is kept with the reason, never deleted, and does not block the queue', async () => {
    const store = await fresh()
    const ob = makeOutbox({ store, reach: { check: async () => true, mark() {} }, send: async (o) => (o.id === 'a-1' ? { refused: 'question domain is not one the operator elected' } : 'done') })
    await ob.enqueue(op('a-1'))
    await ob.enqueue(op('a-2'))
    await ob.drain()
    const left = await ob.pending()
    expect(left.map((o) => o.id)).toEqual(['a-1'])
    expect(left[0].error).toMatch(/elected/)
    await ob.drain()
    expect((await ob.pending()).map((o) => o.id)).toEqual(['a-1'])
  })

  it('tells listeners how many writes wait, and when one lands', async () => {
    const store = await fresh()
    let online = false
    const seen: { waiting: number; landed?: string }[] = []
    const ob = makeOutbox({ store, reach: { check: async () => online, mark() {} }, send: async () => 'done' })
    ob.subscribe((s) => seen.push(s))
    await ob.enqueue(op('a-1'))
    online = true
    await ob.drain()
    expect(seen.at(-1)).toMatchObject({ waiting: 0, landed: 'a-1' })
    expect(seen.some((s) => s.waiting === 1)).toBe(true)
  })

  it('two drains at once send each write once', async () => {
    const store = await fresh()
    const sent: string[] = []
    const ob = makeOutbox({ store, reach: { check: async () => true, mark() {} }, send: async (o) => { sent.push(o.id); await new Promise((r) => setTimeout(r, 5)); return 'done' } })
    await ob.enqueue(op('a-1'))
    await Promise.all([ob.drain(), ob.drain()])
    expect(sent).toEqual(['a-1'])
  })

  it('a write made while a drain is already running is sent by that drain, not left for the next tick', async () => {
    const store = await fresh()
    const sent: string[] = []
    // eslint-disable-next-line prefer-const
    let ob!: ReturnType<typeof makeOutbox>
    ob = makeOutbox({ store, reach: { check: async () => true, mark() {} }, send: async (o) => {
      sent.push(o.id)
      if (o.id === 'a-1') { await ob.enqueue(op('a-2', { at: Date.now() + 1 })); void ob.drain() }
      return 'done'
    } })
    await ob.enqueue(op('a-1'))
    await ob.drain()
    await new Promise((r) => setTimeout(r, 10))
    expect(sent).toEqual(['a-1', 'a-2'])
    expect(await ob.pending()).toEqual([])
  })

  it('a take is kept as a blob beside its write and removed only once the write lands', async () => {
    const store = await fresh()
    const ob = makeOutbox({ store, reach: { check: async () => true, mark() {} }, send: async (o) => { expect(await store.get('blobs', o.blob!)).toBeDefined(); return 'done' } })
    await store.put('blobs', 'take-1', new Blob(['x'], { type: 'audio/mp4' }))
    await ob.enqueue(op('a-1', { kind: 'voiceAnswer', blob: 'take-1' }))
    await ob.drain()
    expect(await store.get('blobs', 'take-1')).toBeUndefined()
  })
})

it('openStore with no name opens the module\'s own database, so a host that wants another name passes it', async () => {
  await openStore()
  const names = (await indexedDB.databases()).map((d) => d.name)
  expect(names).toContain('suggest-a-change')
})
