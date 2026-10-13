// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { clearDraft, draftKey, loadDraft, saveDraft } from '../../src/client/drafts.ts'
import { openStore } from '../../src/client/idb.ts'
import { isReportId } from '../../src/contract.mjs'

let n = 0
const fresh = () => openStore(`d-${++n}`)

describe('drafts', () => {
  it('the key is sac:<app>:<account>, exactly', () => {
    expect(draftKey({ app: 'us', account: 'alex' })).toBe('sac:us:alex')
  })

  it('a draft belongs to one app and one account: switching people never shows the other\'s draft', async () => {
    const store = await fresh()
    const alex = draftKey({ app: 'us', account: 'alex' })
    const sam = draftKey({ app: 'us', account: 'sam' })
    const other = draftKey({ app: 'cofounders', account: 'alex' })
    await saveDraft(store, alex, { words: 'the photos are small' })
    expect(await loadDraft(store, sam)).toBeUndefined()
    expect(await loadDraft(store, other)).toBeUndefined()
    await saveDraft(store, sam, { words: 'add a dark mode' })
    expect((await loadDraft(store, alex))?.words).toBe('the photos are small')
    expect((await loadDraft(store, sam))?.words).toBe('add a dark mode')
  })

  it('the report id is made when the draft starts and stays through every later save', async () => {
    const store = await fresh()
    const key = draftKey({ app: 'us', account: 'alex' })
    const first = await saveDraft(store, key, { words: 'a' })
    expect(isReportId(first.reportId)).toBe(true)
    const second = await saveDraft(store, key, { words: 'ab', kind: 'broken' }, { makeId: () => { throw new Error('no new id') } })
    expect(second.reportId).toBe(first.reportId)
    expect(second).toMatchObject({ words: 'ab', kind: 'broken' })
    expect((await loadDraft(store, key))?.reportId).toBe(first.reportId)
  })

  it('a cleared draft is gone, and the next one starts a new report', async () => {
    const store = await fresh()
    const key = draftKey({ app: 'us', account: 'alex' })
    const a = await saveDraft(store, key, { words: 'x' })
    await clearDraft(store, key)
    expect(await loadDraft(store, key)).toBeUndefined()
    const b = await saveDraft(store, key, { words: 'y' }, { makeId: () => 'r-20261012000000-zzzzzz' })
    expect(b.reportId).not.toBe(a.reportId)
  })
})
