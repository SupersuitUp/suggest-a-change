// @vitest-environment jsdom
// The last answer is kept on the phone: My suggestions and the detail view draw it at once and refresh behind.
import 'fake-indexeddb/auto'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Adapters, Identity } from '../../src/client/adapters.ts'
import { SuggestionDetail } from '../../src/client/detail.tsx'
import { SuggestEntry } from '../../src/client/entry.tsx'
import { openStore } from '../../src/client/idb.ts'
import { MySuggestions } from '../../src/client/mine.tsx'
import type { Report, StoreAdapter, Summary } from '../../src/client/reports.ts'
import { refreshIdentity } from '../../src/client/runtime.ts'

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
