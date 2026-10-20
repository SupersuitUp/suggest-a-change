// What the person last LOOKED at, per account: a report that has moved since shows as New, once.
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { openStore } from '../../src/client/idb.ts'
import { clearViewCache } from '../../src/client/view-cache.ts'
import { fresh, markSeen, moved, seenStatuses } from '../../src/client/seen.ts'

let n = 0
const db = () => openStore(`seen-${++n}`)
const SAM = { app: 'notes', account: 'sam' }
const JO = { app: 'notes', account: 'jo' }

describe('seen statuses', () => {
  it('a report seen for the first time is recorded silently, so taking the release toasts nothing old', async () => {
    const s = await db()
    expect(await moved(s, SAM, [{ id: 'a', status: 'live' }, { id: 'b', status: 'received' }])).toEqual([])
    expect(await seenStatuses(s, SAM)).toEqual({ a: 'live', b: 'received' })
  })

  it('a move to a telling status is New until it is looked at; a quiet move is recorded silently', async () => {
    const s = await db()
    await moved(s, SAM, [{ id: 'a', status: 'received' }, { id: 'b', status: 'received' }])
    expect(await moved(s, SAM, [{ id: 'a', status: 'live' }, { id: 'b', status: 'with-freeda' }])).toEqual([{ id: 'a', status: 'live' }])
    expect((await seenStatuses(s, SAM)).b).toBe('with-freeda')
    // still New on the next open, until it is looked at
    expect(await moved(s, SAM, [{ id: 'a', status: 'live' }, { id: 'b', status: 'with-freeda' }])).toEqual([{ id: 'a', status: 'live' }])
    await markSeen(s, SAM, 'a', 'live')
    expect(await moved(s, SAM, [{ id: 'a', status: 'live' }])).toEqual([])
  })

  it('another account never sees the marks, and signing out clears them', async () => {
    const s = await db()
    await moved(s, SAM, [{ id: 'a', status: 'received' }])
    expect(await moved(s, JO, [{ id: 'a', status: 'live' }])).toEqual([]) // first sight for jo
    expect(await moved(s, SAM, [{ id: 'a', status: 'live' }])).toEqual([{ id: 'a', status: 'live' }])
    await clearViewCache(s, SAM)
    expect(await seenStatuses(s, SAM)).toEqual({})
    expect(await seenStatuses(s, JO)).toEqual({ a: 'live' })
  })

  it('a move the last page load already saw is not fresh again; a newer move is, and an opened one drops out', async () => {
    const s = await db()
    expect(await fresh(s, SAM, [{ id: 'a', status: 'live' }])).toEqual([{ id: 'a', status: 'live' }]) // first load on the release
    expect(await fresh(s, SAM, [{ id: 'a', status: 'live' }])).toEqual([]) // the next load: old news
    expect(await fresh(s, SAM, [{ id: 'a', status: 'live' }, { id: 'b', status: 'filed' }])).toEqual([{ id: 'b', status: 'filed' }])
    expect(await fresh(s, SAM, [{ id: 'b', status: 'filed' }])).toEqual([]) // a was opened
    expect(await fresh(s, SAM, [{ id: 'a', status: 'not-now' }, { id: 'b', status: 'filed' }])).toEqual([{ id: 'a', status: 'not-now' }])
    expect(await fresh(s, JO, [{ id: 'b', status: 'filed' }])).toEqual([{ id: 'b', status: 'filed' }]) // per account
  })
})
