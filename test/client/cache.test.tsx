// @vitest-environment jsdom
// The last answer is kept on the phone: My suggestions and the detail view draw it at once and refresh behind.
import 'fake-indexeddb/auto'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Adapters, Identity } from '../../src/client/adapters.ts'
import { SuggestionDetail } from '../../src/client/detail.tsx'
import { SuggestEntry } from '../../src/client/entry.tsx'
import { openStore } from '../../src/client/idb.ts'
import { MySuggestions } from '../../src/client/mine.tsx'
import type { Report, StoreAdapter, Summary } from '../../src/client/reports.ts'
import { getRuntime, refreshIdentity } from '../../src/client/runtime.ts'
import { markSeen } from '../../src/client/seen.ts'

afterEach(() => cleanup())

let n = 0
const SAM: Identity = { account: 'sam', role: 'member' }
const JO: Identity = { account: 'jo', role: 'member' }
const RID = 'r-20261012120000-abcdef'
const never = <T,>() => new Promise<T>(() => {})

async function setup(storeOver: Partial<StoreAdapter> = {}, who: Identity | null = SAM, prev?: { phone: Awaited<ReturnType<typeof openStore>>; app: string }) {
  const store: StoreAdapter = { async submit() { return 'done' }, async uploadPart() { return 'done' }, async mine() { return [] }, async one(id) { return { id } }, async append() { return 'done' }, ...storeOver }
  const phone = prev?.phone ?? await openStore(`cache-${++n}`)
  const app = prev?.app ?? `cacheapp${n}`
  const adapters: Adapters = { identity: async () => who, store, words: { app, owner: 'Alex' }, phone: { store: phone, now: () => 1 } }
  return { adapters, phone, app }
}

describe('My suggestions keeps its last answer', () => {
  it('a second open draws the rows from the phone while the app has not answered', async () => {
    const rows: Summary[] = [{ id: 'a', status: 'received', at: 2, words: 'first row' }]
    const t = await setup({ mine: async () => rows })
    const first = render(<MySuggestions adapters={t.adapters} />)
    await screen.findByText('first row')
    await waitFor(async () => expect((await t.phone.all('kv', `sac:${t.app}:sam#view:mine`)).length).toBe(1))
    first.unmount()
    const again = await setup({ mine: () => never<Summary[]>() }, SAM, t)
    render(<MySuggestions adapters={again.adapters} />)
    await screen.findByText('first row')
    expect(screen.getByText('Updating')).toBeTruthy()
  })

  it('another account never sees the first account\'s cache', async () => {
    const t = await setup({ mine: async () => [{ id: 'a', status: 'received', at: 2, words: 'sam secret' }] })
    const first = render(<MySuggestions adapters={t.adapters} />)
    await screen.findByText('sam secret')
    await waitFor(async () => expect((await t.phone.all('kv', `sac:${t.app}:sam#view:mine`)).length).toBe(1))
    first.unmount()
    const jo = await setup({ mine: () => never<Summary[]>() }, JO, t)
    render(<MySuggestions adapters={jo.adapters} />)
    await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
    expect(screen.queryByText('sam secret')).toBeNull()
    expect(screen.getByText('Loading')).toBeTruthy()
  })

  it('a first open with no cache shows the loading state', async () => {
    const t = await setup({ mine: () => never<Summary[]>() })
    render(<MySuggestions adapters={t.adapters} />)
    expect(await screen.findByText('Loading')).toBeTruthy()
  })

  it('a failure keeps the cached rows and says the app could not be reached', async () => {
    const t = await setup({ mine: async () => [{ id: 'a', status: 'received', at: 2, words: 'kept row' }] })
    const first = render(<MySuggestions adapters={t.adapters} />)
    await screen.findByText('kept row')
    await waitFor(async () => expect((await t.phone.all('kv', `sac:${t.app}:sam#view:mine`)).length).toBe(1))
    first.unmount()
    const down = await setup({ mine: async () => { throw new Error('away') } }, SAM, t)
    render(<MySuggestions adapters={down.adapters} />)
    expect((await screen.findByRole('alert')).textContent).toBe('Could not reach the app. Showing what this phone last saw.')
    expect(screen.getByText('kept row')).toBeTruthy()
    expect(screen.queryByText('Updating')).toBeNull()
  })

  it('a report that vanished on the app disappears after the refresh', async () => {
    const t = await setup({ mine: async () => [{ id: 'a', status: 'received', at: 2, words: 'gone row' }, { id: 'b', status: 'received', at: 1, words: 'stays row' }] })
    const first = render(<MySuggestions adapters={t.adapters} />)
    await screen.findByText('gone row')
    await waitFor(async () => expect((await t.phone.all('kv', `sac:${t.app}:sam#view:mine`)).length).toBe(1))
    first.unmount()
    const later = await setup({ mine: async () => [{ id: 'b', status: 'received', at: 1, words: 'stays row' }] }, SAM, t)
    render(<MySuggestions adapters={later.adapters} />)
    await screen.findByText('stays row')
    await waitFor(() => expect(screen.queryByText('gone row')).toBeNull())
    expect(screen.queryByText('Updating')).toBeNull()
  })

  it('switching accounts while mounted does not draw the last account\'s cache', async () => {
    const t = await setup({ mine: async () => [{ id: 'a', status: 'received', at: 2, words: 'sam row' }] })
    let current: Identity | null = SAM
    const adapters: Adapters = { ...t.adapters, identity: async () => current }
    render(<MySuggestions adapters={adapters} />)
    await screen.findByText('sam row')
    current = JO
    adapters.store = { ...adapters.store, mine: async () => [] }
    await act(async () => { refreshIdentity(); await new Promise((r) => setTimeout(r, 40)) })
    await screen.findByText('You have not sent a suggestion yet.')
    expect(screen.queryByText('sam row')).toBeNull()
  })
})

describe('the detail view keeps its last answer', () => {
  const rep = { id: RID, status: 'received', words: 'cached words' } as Report

  it('a second open draws the report from the phone while the app has not answered, then replaces it', async () => {
    const t = await setup({ one: async () => rep })
    const first = render(<SuggestionDetail adapters={t.adapters} id={RID} />)
    await screen.findByText('cached words')
    await waitFor(async () => expect((await t.phone.all('kv', `sac:${t.app}:sam#view:one`)).length).toBe(1))
    first.unmount()
    let answer: (r: Report) => void = () => {}
    const again = await setup({ one: () => new Promise<Report>((r) => { answer = r }) }, SAM, t)
    render(<SuggestionDetail adapters={again.adapters} id={RID} />)
    await screen.findByText('cached words')
    expect(screen.getByText('Updating')).toBeTruthy()
    await act(async () => { answer({ id: RID, status: 'being-made', words: 'fresh words' } as Report) })
    await screen.findByText('fresh words')
    expect(screen.queryByText('cached words')).toBeNull()
    expect(screen.queryByText('Updating')).toBeNull()
  })

  it('another account never sees the cached report, and a failure keeps the cached one with a plain line', async () => {
    const t = await setup({ one: async () => rep })
    const first = render(<SuggestionDetail adapters={t.adapters} id={RID} />)
    await screen.findByText('cached words')
    await waitFor(async () => expect((await t.phone.all('kv', `sac:${t.app}:sam#view:one`)).length).toBe(1))
    first.unmount()
    const jo = await setup({ one: () => never<Report>() }, JO, t)
    const other = render(<SuggestionDetail adapters={jo.adapters} id={RID} />)
    await act(async () => { await new Promise((r) => setTimeout(r, 40)) })
    expect(screen.queryByText('cached words')).toBeNull()
    other.unmount()
    const down = await setup({ one: async () => { throw new Error('away') } }, SAM, t)
    render(<SuggestionDetail adapters={down.adapters} id={RID} />)
    await screen.findByText('cached words')
    expect((await screen.findByRole('alert')).textContent).toBe('Could not reach the app. Showing what this phone last saw.')
  })

  it('a first open that fails, with nothing cached, says it could not be opened', async () => {
    const t = await setup({ one: async () => { throw new Error('away') } })
    render(<SuggestionDetail adapters={t.adapters} id={RID} />)
    expect((await screen.findByRole('alert')).textContent).toBe('This suggestion could not be opened.')
  })
})

describe('the entry takes a role', () => {
  it('passes role and className through, and sets no role by default', async () => {
    const t = await setup()
    const a = render(<SuggestEntry adapters={t.adapters} onOpen={() => {}} role="menuitem" className="row" />)
    const b = a.container.querySelector('[data-suggest-entry]')!
    expect(b.getAttribute('role')).toBe('menuitem')
    expect(b.className).toContain('row')
    a.unmount()
    const c = render(<SuggestEntry adapters={t.adapters} onOpen={() => {}} />)
    expect(c.container.querySelector('[data-suggest-entry]')!.hasAttribute('role')).toBe(false)
  })
})

// The cached answers only: the seen-status and noticed records sit under the same prefix (and is cleared with them) but is not a view.
const keysOf = async (t: { phone: Awaited<ReturnType<typeof openStore>> }) => (await t.phone.all('kv')).map((r) => r.key).filter((k) => k.includes('#view') && !k.endsWith('#view:seen') && !k.endsWith('#view:noticed'))
const refusal = () => Object.assign(new Error('gone'), { refused: true })

describe('the cache belongs to whoever asked (fix round 1)', () => {
  it('a list that is answered after the session switched to another account is not kept under the first, or drawn', async () => {
    let current: Identity | null = SAM
    const answers: ((r: Summary[]) => void)[] = []
    const t = await setup({ mine: () => new Promise<Summary[]>((r) => { answers.push(r) }) })
    const adapters: Adapters = { ...t.adapters, identity: async () => current }
    render(<MySuggestions adapters={adapters} />)
    await waitFor(() => expect(answers.length).toBeGreaterThan(0))
    current = JO
    await act(async () => { for (const a of answers) a([{ id: 'a', status: 'received', at: 1, words: 'asked as sam' }]); await new Promise((r) => setTimeout(r, 40)) })
    expect(await keysOf(t)).toEqual([])
    expect(screen.queryByText('asked as sam')).toBeNull()
  })

  it('a report answered after the session switched is not kept under the first account', async () => {
    let current: Identity | null = SAM
    const answers: ((r: Report) => void)[] = []
    const t = await setup({ one: () => new Promise<Report>((r) => { answers.push(r) }) })
    const adapters: Adapters = { ...t.adapters, identity: async () => current }
    render(<SuggestionDetail adapters={adapters} id={RID} />)
    await waitFor(() => expect(answers.length).toBeGreaterThan(0))
    current = JO
    await act(async () => { for (const a of answers) a({ id: RID, status: 'received', words: 'asked as sam' } as Report); await new Promise((r) => setTimeout(r, 40)) })
    expect(await keysOf(t)).toEqual([])
    expect(screen.queryByText('asked as sam')).toBeNull()
  })
})

describe('a refusal is not an unreachable app (fix round 1)', () => {
  const rep = { id: RID, status: 'received', words: 'cached words' } as Report
  async function warmed(kind: 'one' | 'mine') {
    const t = await setup({ one: async () => rep, mine: async () => [{ id: RID, status: 'received', at: 1, words: 'cached row' }] })
    const first = kind === 'one' ? render(<SuggestionDetail adapters={t.adapters} id={RID} />) : render(<MySuggestions adapters={t.adapters} />)
    await screen.findByText(kind === 'one' ? 'cached words' : 'cached row')
    await waitFor(async () => expect((await keysOf(t)).length).toBeGreaterThan(0))
    first.unmount()
    return t
  }

  it('a report the app now refuses is dropped from the phone and shows as could not be opened, for a flagged error and for 404 and 403', async () => {
    for (const err of [refusal(), Object.assign(new Error('x'), { status: 404 }), Object.assign(new Error('x'), { status: 403 })]) {
      cleanup()
      const t = await warmed('one')
      const again = await setup({ one: async () => { throw err } }, SAM, t)
      render(<SuggestionDetail adapters={again.adapters} id={RID} />)
      expect((await screen.findByRole('alert')).textContent).toBe('This suggestion could not be opened.')
      expect(screen.queryByText('cached words')).toBeNull()
      await waitFor(async () => expect((await t.phone.all('kv', `sac:${t.app}:sam#view:one`)).length).toBe(0))
    }
  })

  it('a plain network error is still unreachable, and the cached report stays', async () => {
    const t = await warmed('one')
    const again = await setup({ one: async () => { throw new TypeError('Failed to fetch') } }, SAM, t)
    render(<SuggestionDetail adapters={again.adapters} id={RID} />)
    await screen.findByText('cached words')
    expect((await screen.findByRole('alert')).textContent).toContain('Could not reach the app')
    expect((await t.phone.all('kv', `sac:${t.app}:sam#view:one`)).length).toBe(1)
  })

  it('a refused list clears the cached list', async () => {
    const t = await warmed('mine')
    const again = await setup({ mine: async () => { throw refusal() } }, SAM, t)
    render(<MySuggestions adapters={again.adapters} />)
    expect((await screen.findByRole('alert')).textContent).toBe('Your suggestions could not be loaded.')
    expect(screen.queryByText('cached row')).toBeNull()
    await waitFor(async () => expect((await t.phone.all('kv', `sac:${t.app}:sam#view:mine`)).length).toBe(0))
  })
})

describe('the detail view follows its id (fix round 1)', () => {
  it('changing the id with the app unreachable never shows the first report under the second', async () => {
    const t = await setup({ one: async (id) => { if (id === RID) return { id, status: 'received', words: 'first report' } as Report; throw new TypeError('Failed to fetch') } })
    const view = render(<SuggestionDetail adapters={t.adapters} id={RID} />)
    await screen.findByText('first report')
    view.rerender(<SuggestionDetail adapters={t.adapters} id="r-20261012120000-zzzzzz" />)
    await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
    expect(screen.queryByText('first report')).toBeNull()
    expect((await screen.findByRole('alert')).textContent).toBe('This suggestion could not be opened.')
  })
})

describe('the cache is kept tidy (fix round 1)', () => {
  it('after a list, cached reports the app no longer lists are dropped', async () => {
    const t = await setup({ one: async (id) => ({ id, status: 'received', words: 'w' }) as Report, mine: async () => [{ id: 'keep', status: 'received', at: 1, words: 'kept' }] })
    const rt = await getRuntime(t.adapters, SAM)
    await rt.store.put('kv', `sac:${t.app}:sam#view:one:gone`, { id: 'gone' })
    await rt.store.put('kv', `sac:${t.app}:sam#view:one:keep`, { id: 'keep' })
    render(<MySuggestions adapters={t.adapters} />)
    await screen.findByText('kept')
    await waitFor(async () => expect((await keysOf(t)).sort()).toEqual([`sac:${t.app}:sam#view:mine`, `sac:${t.app}:sam#view:one:keep`]))
  })

  it('signing out clears the account\'s cached views', async () => {
    const t = await setup({ mine: async () => [{ id: 'a', status: 'received', at: 1, words: 'row' }] })
    let current: Identity | null = SAM
    const adapters: Adapters = { ...t.adapters, identity: async () => current }
    render(<MySuggestions adapters={adapters} />)
    await screen.findByText('row')
    await waitFor(async () => expect((await keysOf(t)).length).toBe(1))
    current = null
    await act(async () => { refreshIdentity() })
    await waitFor(async () => expect(await keysOf(t)).toEqual([]))
  })

  it('"Updating" ends with the first answer; a later periodic reload does not bring it back', async () => {
    let calls = 0
    const t = await setup({ mine: () => (++calls === 1 ? Promise.resolve([{ id: 'a', status: 'received', at: 1, words: 'row' }]) : never<Summary[]>()) })
    const first = render(<MySuggestions adapters={t.adapters} />)
    await screen.findByText('row')
    await waitFor(async () => expect((await keysOf(t)).length).toBe(1))
    first.unmount()
    calls = 1
    // Second open: cache first, then the first answer arrives.
    let release: (r: Summary[]) => void = () => {}
    const again = await setup({ mine: () => (++calls === 2 ? new Promise<Summary[]>((r) => { release = r }) : never<Summary[]>()) }, SAM, t)
    render(<MySuggestions adapters={again.adapters} />)
    await screen.findByText('Updating')
    await act(async () => { release([{ id: 'a', status: 'received', at: 1, words: 'row' }]) })
    await waitFor(() => expect(screen.queryByText('Updating')).toBeNull())
    const rt = await getRuntime(again.adapters, SAM)
    await act(async () => { await rt.outbox.enqueue({ id: 'noise', kind: 'other', body: {}, at: 1 }); await rt.outbox.refresh(); await new Promise((r) => setTimeout(r, 60)) })
    await waitFor(() => expect(calls).toBeGreaterThan(2))
    expect(screen.queryByText('Updating')).toBeNull()
  })
})

describe('My suggestions after it is gone', () => {
  // 2026-10-29: the Helm's suite under load caught `window is not defined` from mine.js: a report marked seen started a
  // recount, the screen unmounted (and the test page with it) while the seen record was being read, and the late answer
  // still set state. A recount that lands after the screen is gone must not touch it.
  it('a recount that answers after unmount sets nothing', async () => {
    const t = await setup({ mine: async () => [{ id: 'a', status: 'received', at: 1, words: 'row' }] })
    const view = render(<MySuggestions adapters={t.adapters} />)
    await screen.findByText('row')
    const rt = await getRuntime(t.adapters, SAM)
    // The first answer records what it saw; let that write land before holding anything.
    await waitFor(async () => expect(await t.phone.get('kv', `sac:${t.app}:sam#view:seen`)).toBeTruthy())
    // Hold the recount's read of the seen record once markSeen's own write is done.
    let armed = false
    let held = false
    let release = () => {}
    const get = rt.store.get.bind(rt.store)
    const put = rt.store.put.bind(rt.store)
    rt.store.put = async (s, k, v) => { await put(s, k, v); if (armed && k.endsWith('#view:seen')) { armed = false; held = true } }
    rt.store.get = (async (s: Parameters<typeof get>[0], k: string) => {
      if (held && k.endsWith('#view:seen')) { held = false; await new Promise<void>((r) => { release = r }) }
      return get(s, k)
    }) as typeof rt.store.get
    const late: unknown[] = []
    const catchLate = (e: unknown) => { late.push(e) }
    process.prependListener('unhandledRejection', catchLate)
    try {
      armed = true
      await markSeen(rt.store, { app: t.app, account: 'sam' }, 'a', 'shipped')
      await waitFor(() => expect(held).toBe(false)) // the recount is reading, and waits
      view.unmount()
      // What a torn-down page looks like to React: no window to read the update priority from.
      vi.stubGlobal('window', undefined)
      release()
      await new Promise((r) => setTimeout(r, 30))
    } finally {
      vi.unstubAllGlobals()
      process.off('unhandledRejection', catchLate)
    }
    expect(late).toEqual([])
  })
})
