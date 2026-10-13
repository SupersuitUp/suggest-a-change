// @vitest-environment jsdom
// The screens, driven the way a person drives them. The adapters are fakes: nothing here sends anything.
import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STATUSES } from '../../src/contract.mjs'
import type { Adapters, FieldProps, Identity } from '../../src/client/adapters.ts'
import { DefaultField } from '../../src/client/default-field.tsx'
import { MySuggestions } from '../../src/client/mine.tsx'
import { ReportProblem, SuggestEntry } from '../../src/client/entry.tsx'
import { SuggestionDetail } from '../../src/client/detail.tsx'
import { SuggestSheet } from '../../src/client/sheet.tsx'
import { openStore } from '../../src/client/idb.ts'
import type { Report, StoreAdapter, Summary } from '../../src/client/reports.ts'
import { effectiveCeilings, receiptWords } from '../../src/client/words.ts'
import { textFieldsWithoutVoice } from './voice-rule.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

let n = 0
const GARY = { account: 'member-1', role: 'member' } as const

function fakeStore(over: Partial<StoreAdapter> = {}) {
  const submitted: Report[] = []
  const parts: { id: string; file: string }[] = []
  const store: StoreAdapter = {
    async submit(r) { submitted.push(r); return 'done' },
    async uploadPart(id, file) { parts.push({ id, file }); return 'done' },
    async mine() { return [] },
    async one(id) { return { id } },
    async append() { return 'done' },
    ...over,
  }
  return { store, submitted, parts }
}

// A stand-in for the host's golden field: one container, one control, one text field. The "voice" button
// hands the sheet a finished take the way the real field does, through `upload`.
function FakeField(p: FieldProps) {
  return (
    <div data-voice-field="">
      <button type="button" data-voice-control="" onClick={() => void p.upload!(`take-${p.id}`, new Blob(['sound'], { type: 'audio/webm' }), 4000)}>{`Say it: ${p.label}`}</button>
      <label>{p.label}<textarea value={p.value} onChange={(e) => p.onChange(e.target.value)} /></label>
    </div>
  )
}

async function setup(over: Partial<Adapters> = {}, who: Identity | null = GARY, storeOver: Partial<StoreAdapter> = {}) {
  const fake = fakeStore(storeOver)
  const adapters: Adapters = {
    identity: async () => who,
    store: fake.store,
    words: { app: `app${++n}`, owner: 'Gary' },
    Field: FakeField,
    about: { app: 'us', version: '1.2.3' },
    device: () => 'iPhone',
    phone: { store: await openStore(`screens-${n}`), now: () => Date.UTC(2026, 9, 12, 12, 0, 0) },
    ...over,
  }
  return { adapters, ...fake }
}

const where = { screen: 'Photos', route: '/photos?x=1' }
const sendButton = () => screen.getByRole('button', { name: 'Send' })
const sheet = async (adapters: Adapters) => {
  const r = render(<SuggestSheet adapters={adapters} where={where} onClose={() => {}} />)
  await screen.findByRole('radiogroup')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Say it: Your suggestion' })).toBeTruthy())
  return r
}

describe('the sheet', () => {
  it('a voice note alone is a whole report', async () => {
    const { adapters, submitted, parts } = await setup()
    await sheet(adapters)
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Say it: Your suggestion' }))
    await waitFor(() => expect((sendButton() as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(sendButton())
    await waitFor(() => expect(submitted).toHaveLength(1))
    expect(submitted[0].words).toBe('')
    expect(submitted[0].voice).toEqual([{ file: 'voice-1.webm', ms: 4000, field: 'words' }])
    expect(submitted[0].kind).toBe('change')
    await waitFor(() => expect(parts).toEqual([{ id: submitted[0].id, file: 'voice-1.webm' }]))
  })

  it('the receipt never says received while the report is only on the phone', async () => {
    let release: (v: 'done') => void = () => {}
    const gate = new Promise<'done'>((res) => { release = res })
    const { adapters, submitted } = await setup({}, GARY, { submit: async (r) => { submitted.push(r); return gate } })
    const submittedRef = submitted
    void submittedRef
    await sheet(adapters)
    fireEvent.change(screen.getByLabelText('Your suggestion'), { target: { value: 'bigger photos please' } })
    fireEvent.click(sendButton())
    expect(await screen.findByText('On this phone, waiting to send.')).toBeTruthy()
    await waitFor(() => expect(submitted).toHaveLength(1))
    expect(screen.queryByText(/Got it/)).toBeNull()
    await act(async () => { release('done'); await gate })
    expect(await screen.findByText("Got it. Freeda picks it up next time Gary's Mac is on.")).toBeTruthy()
  })

  it('a Helm that posts straight to the Mac says so', async () => {
    const { adapters } = await setup({ lands: 'mac' })
    await sheet(adapters)
    fireEvent.change(screen.getByLabelText('Your suggestion'), { target: { value: 'x' } })
    fireEvent.click(sendButton())
    expect(await screen.findByText('On your Mac.')).toBeTruthy()
  })

  it('the receipt words are the design\'s three lines', () => {
    expect(receiptWords('on-phone', { owner: 'Gary' })).toBe('On this phone, waiting to send.')
    expect(receiptWords('received', { owner: 'Wilson' })).toBe("Got it. Freeda picks it up next time Wilson's Mac is on.")
    expect(receiptWords('on-mac', { owner: 'Gary' })).toBe('On your Mac.')
  })

  it('the sheet names what is sent and each diagnostic has a switch that removes it from the report', async () => {
    const { adapters, submitted } = await setup()
    await sheet(adapters)
    const line = () => document.querySelector('[data-sac-summary]')!.textContent
    expect(line()).toBe("Goes to Gary and Freeda. Includes the app's version, the time, this screen's name and your phone type.")
    fireEvent.click(screen.getByRole('switch', { name: 'Include the time' }))
    expect(line()).toBe("Goes to Gary and Freeda. Includes the app's version, this screen's name and your phone type.")
    fireEvent.click(screen.getByRole('switch', { name: 'Include your phone type' }))
    expect(line()).toBe("Goes to Gary and Freeda. Includes the app's version and this screen's name.")
    expect(screen.getAllByRole('switch')).toHaveLength(4)
    fireEvent.change(screen.getByLabelText('Your suggestion'), { target: { value: 'hi' } })
    fireEvent.click(sendButton())
    await waitFor(() => expect(submitted).toHaveLength(1))
    expect(submitted[0].diagnostics).toEqual({ appVersion: '1.2.3', screen: 'Photos' })
    expect((submitted[0].where as { route: string }).route).toBe('/photos')
    expect(JSON.stringify(submitted[0])).not.toMatch(/@/)
  })

  it('the kind choice is a radio group of the design\'s three choices, and broken asks three optional questions', async () => {
    const { adapters, submitted } = await setup()
    await sheet(adapters)
    const group = screen.getByRole('radiogroup')
    expect(within(group).getAllByRole('radio').map((r) => r.parentElement!.textContent)).toEqual(['Change something', 'Something is broken', 'Just feedback'])
    fireEvent.click(screen.getByRole('radio', { name: 'Something is broken' }))
    for (const q of ['What happened?', 'What did you expect?', 'How can it be made to happen again?']) expect(screen.getByLabelText(q)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'it froze' } })
    fireEvent.click(sendButton())
    await waitFor(() => expect(submitted).toHaveLength(1))
    expect(submitted[0].kind).toBe('broken')
    expect(submitted[0].answers).toEqual({ happened: 'it froze', expected: '', steps: '' })
  })

  it('is a labelled dialog that holds focus and gives it back', async () => {
    const { adapters } = await setup()
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const { unmount } = render(<SuggestSheet adapters={adapters} where={where} onClose={() => {}} />)
    const dialog = await screen.findByRole('dialog', { name: 'Suggest a change' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    await screen.findByRole('radiogroup')
    const focusables = dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea')
    const last = focusables[focusables.length - 1]
    last.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(focusables[0])
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('Escape closes it', async () => {
    const { adapters } = await setup()
    const onClose = vi.fn()
    render(<SuggestSheet adapters={adapters} where={where} onClose={onClose} />)
    const dialog = await screen.findByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('shows sizes and a remove control, stops at six pictures, and an app may lower the limit but never raise it', async () => {
    const { adapters } = await setup({ limits: { images: 2, imageBytes: 99 * 2 ** 20 } })
    await sheet(adapters)
    const input = document.querySelector<HTMLInputElement>('[data-sac-images]')!
    const png = (name: string, size = 2048) => new File([new Uint8Array(size)], name, { type: 'image/png' })
    fireEvent.change(input, { target: { files: [png('a.png'), png('b.png'), png('c.png')] } })
    await screen.findByText('b.png, 2.0 KB')
    expect(screen.queryByText(/c\.png/)).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe('Up to 2 pictures.')
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }))
    await waitFor(() => expect(screen.queryByText(/a\.png/)).toBeNull())
    expect(effectiveCeilings({ images: 50, imageBytes: 1 }).images).toBe(6)
    expect(effectiveCeilings({ images: 50, imageBytes: 1 }).imageBytes).toBe(1)
  })

  it('shows progress for each attachment while sending, and a retry when one fails', async () => {
    let fail = true
    const { adapters, submitted } = await setup({}, GARY, { uploadPart: async () => (fail ? { refused: 'storage is full' } : 'done') })
    await sheet(adapters)
    fireEvent.change(document.querySelector('[data-sac-images]')!, { target: { files: [new File([new Uint8Array(10)], 'shot.png', { type: 'image/png' })] } })
    await screen.findByText('shot.png, 10 B')
    fireEvent.click(sendButton())
    await screen.findByText(/Did not send: storage is full/)
    expect(submitted).toHaveLength(1)
    fail = false
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0])
    await screen.findByText('Sent')
    expect(await screen.findByText(/Got it/)).toBeTruthy()
  })

  it('keeps the words as they are typed and puts them back on the next open', async () => {
    const { adapters } = await setup()
    const first = await sheet(adapters)
    fireEvent.change(screen.getByLabelText('Your suggestion'), { target: { value: 'half a thought' } })
    await new Promise((r) => setTimeout(r, 50))
    first.unmount()
    await sheet(adapters)
    await waitFor(() => expect((screen.getByLabelText('Your suggestion') as HTMLTextAreaElement).value).toBe('half a thought'))
  })

  it('signed out, the sheet says why instead of showing the form', async () => {
    const { adapters } = await setup({}, null)
    render(<SuggestSheet adapters={adapters} where={where} />)
    expect((await screen.findByRole('alert')).textContent).toBe('Sign in to suggest a change.')
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })
})

describe('the entry', () => {
  it('signed out, the entry opens nothing and says why', async () => {
    const { adapters } = await setup({}, null)
    const onOpen = vi.fn()
    const { container } = render(<SuggestEntry adapters={adapters} onOpen={onOpen} />)
    const entry = container.querySelector('[data-suggest-entry]') as HTMLButtonElement
    expect(entry.textContent).toBe('Suggest a change')
    fireEvent.click(entry)
    expect((await screen.findByRole('status')).textContent).toBe('Sign in to suggest a change.')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('signed in, it opens', async () => {
    const { adapters } = await setup()
    const onOpen = vi.fn()
    const { container } = render(<SuggestEntry adapters={adapters} onOpen={onOpen} />)
    fireEvent.click(container.querySelector('[data-suggest-entry]')!)
    await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1))
  })

  it('Report a problem opens the sheet as broken, with the screen and what went wrong filled in', async () => {
    const { adapters, submitted } = await setup()
    render(<ReportProblem adapters={adapters} screen="Photos" error={new Error('boom at line 3')} />)
    fireEvent.click(screen.getByRole('button', { name: 'Report a problem' }))
    await screen.findByRole('dialog')
    await waitFor(() => expect((screen.getByLabelText('What happened?') as HTMLTextAreaElement).value).toBe('boom at line 3'))
    expect((screen.getByRole('radio', { name: 'Something is broken' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(sendButton())
    await waitFor(() => expect(submitted).toHaveLength(1))
    expect((submitted[0].where as { screen: string }).screen).toBe('Photos')
  })
})

const DESIGN_TABLE: [string, string, string][] = [
  ['on-phone', 'On this phone', 'Not sent yet; it will send when there is a connection'],
  ['received', 'Received', 'The app has it, safely stored'],
  ['with-freeda', 'With Freeda', "Gary's Mac has picked it up"],
  ['waiting-on-owner', 'Waiting on Gary', 'Freeda has a plan and is asking Gary'],
  ['being-made', 'Being made', 'A session is working on it; the current step shows underneath'],
  ['live', 'Done', 'Shipped in the app, with the date it went live'],
  ['sent-to-template', 'Sent to the template', 'It became a change to the template every copy of this app uses; it reaches this app once merged'],
  ['filed', 'Filed', 'It was passed to whoever owns the problem'],
  ['not-now', 'Not now', 'Gary decided against it, with the one-line reason if given'],
]

describe('My suggestions and the detail view', () => {
  it('the status words are the design\'s table', async () => {
    const rows: Summary[] = STATUSES.map((status, i) => ({ id: `r-${i}`, status, at: i }))
    const { adapters } = await setup({}, GARY, { mine: async () => rows })
    render(<MySuggestions adapters={adapters} />)
    await screen.findAllByRole('button')
    for (const [status, word, meaning] of DESIGN_TABLE) {
      const row = document.querySelector(`[data-status="${status}"]`) as HTMLElement
      expect(row, status).toBeTruthy()
      expect(within(row).getByText(word)).toBeTruthy()
      expect(within(row).getByText(meaning)).toBeTruthy()
    }
    const planned = document.querySelector('[data-status="planned"]') as HTMLElement
    expect(within(planned).getByText('With Freeda')).toBeTruthy()
  })

  it('lists newest first, and a report still on the phone shows as on this phone', async () => {
    const { adapters } = await setup({}, GARY, { mine: async () => [{ id: 'old', status: 'received', at: 1 }, { id: 'new', status: 'being-made', at: 9 }], submit: async () => new Promise(() => {}) })
    const { container } = render(<><SuggestSheet adapters={adapters} where={where} /><MySuggestions adapters={adapters} /></>)
    await screen.findByRole('radiogroup')
    fireEvent.change(screen.getByLabelText('Your suggestion'), { target: { value: 'x' } })
    fireEvent.click(sendButton())
    await waitFor(() => expect(container.querySelectorAll('.sac-row').length).toBe(3))
    const order = [...container.querySelectorAll('.sac-row')].map((r) => r.getAttribute('data-status'))
    expect(order[0]).toBe('on-phone')
    expect(order.slice(1)).toEqual(['being-made', 'received'])
  })

  it('the detail shows words, attachments and the strip, lets the person add to it, and stops at an end status', async () => {
    const appended: Record<string, unknown>[] = []
    const one = vi.fn(async (id: string) => ({ id, status: 'being-made', step: 'Freeda is testing the change', words: 'bigger photos <b>please</b>', media: [{ file: 'image-1.png', type: 'image/png', bytes: 2048 }], voice: [{ file: 'voice-1.webm', ms: 12000 }] }))
    const { adapters } = await setup({}, GARY, { one, append: async (_id, more) => { appended.push(more); return 'done' } })
    render(<SuggestionDetail adapters={adapters} id="r-20261012120000-abcdef" />)
    expect(await screen.findByText('bigger photos <b>please</b>')).toBeTruthy()
    expect(screen.getByText('image-1.png, 2.0 KB')).toBeTruthy()
    expect(screen.getByText('Voice note 1, 0:12')).toBeTruthy()
    expect(screen.getByText('Freeda is testing the change')).toBeTruthy()
    const now = document.querySelector('[aria-current="step"]')!
    expect(now.textContent).toContain('Being made')
    fireEvent.change(screen.getByLabelText('Add to it'), { target: { value: 'also the button is too small' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await screen.findByText('Added.')
    expect(appended[0].words).toBe('also the button is too small')
  })

  it('offers no way to add once the suggestion has an end status', async () => {
    const { adapters } = await setup({}, GARY, { one: async (id) => ({ id, status: 'live', words: 'done' }) })
    render(<SuggestionDetail adapters={adapters} id="r-20261012120000-abcdef" />)
    await screen.findAllByText('Done')
    expect(screen.queryByLabelText('Add to it')).toBeNull()
  })
})

describe('every text field sits in a voice field container', () => {
  it('in the sheet (every kind), the detail view and the list, with the module\'s own field', async () => {
    const { adapters } = await setup({ Field: undefined }, GARY, { one: async (id) => ({ id, status: 'received', words: 'w' }), mine: async () => [{ id: 'r-1', status: 'received', at: 1 }] })
    const r = render(<SuggestSheet adapters={adapters} where={where} onClose={() => {}} />)
    await screen.findByRole('radiogroup')
    await waitFor(() => expect(r.container.querySelectorAll('textarea').length).toBe(1))
    expect(textFieldsWithoutVoice(document.body)).toEqual([])
    fireEvent.click(screen.getByRole('radio', { name: 'Something is broken' }))
    await waitFor(() => expect(document.querySelectorAll('textarea').length).toBe(4))
    expect(textFieldsWithoutVoice(document.body)).toEqual([])
    r.unmount()
    const d = render(<SuggestionDetail adapters={adapters} id="r-20261012120000-abcdef" />)
    await screen.findByLabelText('Add to it')
    expect(textFieldsWithoutVoice(document.body)).toEqual([])
    d.unmount()
    render(<MySuggestions adapters={adapters} />)
    fireEvent.click(await screen.findByRole('button', { name: /Received/ }))
    await screen.findByLabelText('Add to it')
    expect(textFieldsWithoutVoice(document.body)).toEqual([])
  })

  it('the rule itself catches a bare field, and one beside a voice field', () => {
    document.body.innerHTML = '<textarea id="bare"></textarea><div data-voice-field><button data-voice-control></button><input type="text"><input type="text"></div>'
    expect(textFieldsWithoutVoice(document.body)).toHaveLength(3)
    document.body.innerHTML = ''
  })
})

describe('the default field', () => {
  function fakeTake(ms = 1500) {
    const blob = new Blob(['audio'], { type: 'audio/mp4' })
    const started: string[] = []
    const startTake = vi.fn(async (_s: unknown, key: string) => { started.push(key); return { started: 0, level: () => null, stop: async () => ({ key, blob, ms }), cancel: async () => {} } })
    return { startTake: startTake as unknown as FieldProps['startTake'], started }
  }
  it('records while the button is held and hands the take to upload; transcription is not its job', async () => {
    const store = await openStore(`field-${++n}`)
    const { startTake } = fakeTake()
    const upload = vi.fn(async (_k: string, _b: Blob, _ms: number) => ({ audio: 'k', text: '' }))
    const onChange = vi.fn()
    render(<DefaultField rt={{ store }} id="words" label="Your suggestion" value="" onChange={onChange} upload={upload} startTake={startTake} />)
    const hold = screen.getByRole('button', { name: /Hold to talk/ })
    fireEvent.pointerDown(hold)
    await waitFor(() => expect(screen.getByRole('button', { name: /Stop and keep/ }).getAttribute('aria-pressed')).toBe('true'))
    fireEvent.pointerUp(screen.getByRole('button', { name: /Stop and keep/ }))
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
    expect(upload.mock.calls[0][2]).toBe(1500)
    expect(onChange).not.toHaveBeenCalled()
  })
  it('can be used from the keyboard: Space starts a take and Space stops it', async () => {
    const store = await openStore(`field-${++n}`)
    const { startTake } = fakeTake()
    const upload = vi.fn(async (_k: string, _b: Blob, _ms: number) => ({ audio: 'k', text: 'transcribed words' }))
    const onChange = vi.fn()
    render(<DefaultField rt={{ store }} id="words" label="Say" value="before" onChange={onChange} upload={upload} startTake={startTake} />)
    fireEvent.keyDown(screen.getByRole('button'), { key: ' ' })
    await waitFor(() => expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true'))
    fireEvent.keyDown(screen.getByRole('button'), { key: ' ' })
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('before transcribed words'))
  })
})
