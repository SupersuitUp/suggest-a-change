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
import { StatusStrip, SuggestionDetail } from '../../src/client/detail.tsx'
import { SuggestSheet } from '../../src/client/sheet.tsx'
import { draftKey, loadDraft } from '../../src/client/drafts.ts'
import { openStore } from '../../src/client/idb.ts'
import type { Report, StoreAdapter, Summary } from '../../src/client/reports.ts'
import { effectiveCeilings, receiptWords } from '../../src/client/words.ts'
import { Receipt } from '../../src/client/receipt.tsx'
import { getRuntime, refreshIdentity } from '../../src/client/runtime.ts'
import { Toasts } from '../../src/client/toast.tsx'
import { clearToasts } from '../../src/client/toast.tsx'
import { textFieldsWithoutVoice } from './voice-rule.ts'

afterEach(() => { cleanup(); clearToasts(); vi.restoreAllMocks() })

let n = 0
const SAM: Identity = { account: 'sam', role: 'member' }
const JO: Identity = { account: 'jo', role: 'member' }

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
      <button type="button" data-voice-control="" onClick={() => void (async () => {
        await p.rt.store.put('blobs', `take-${p.id}`, new Blob(['sound'], { type: 'audio/webm' }))
        await p.upload!(`take-${p.id}`, new Blob(['sound'], { type: 'audio/webm' }), 4000)
      })()}>{`Say it: ${p.label}`}</button>
      <label>{p.label}<textarea value={p.value} onChange={(e) => p.onChange(e.target.value)} /></label>
    </div>
  )
}

async function setup(over: Partial<Adapters> = {}, who: Identity | null = SAM, storeOver: Partial<StoreAdapter> = {}) {
  const fake = fakeStore(storeOver)
  const name = `app${++n}`
  const db = await openStore(`screens-${n}`)
  const adapters: Adapters = {
    identity: async () => who,
    store: fake.store,
    words: { app: name, owner: 'Alex' },
    Field: FakeField,
    about: { app: 'notes', version: '1.2.3' },
    device: () => 'iPhone',
    phone: { store: db, now: () => Date.UTC(2026, 9, 12, 12, 0, 0) },
    ...over,
  }
  return { adapters, db, ...fake }
}

const where = { screen: 'Photos', route: '/photos?x=1' }
const sendButton = () => screen.getByRole('button', { name: 'Send' })
const sheet = async (adapters: Adapters, props: { initial?: { kind?: 'broken' | 'change' | 'feedback'; happened?: string } } = {}) => {
  const r = render(<SuggestSheet adapters={adapters} where={where} onClose={() => {}} {...props} />)
  await screen.findByRole('radiogroup')
  return r
}
const record = () => fireEvent.click(screen.getByRole('button', { name: 'Say it: Your suggestion' }))
const png = (name: string, size = 2048) => new File([new Uint8Array(size)], name, { type: 'image/png' })
const images = () => document.querySelector<HTMLInputElement>('[data-sac-images]')!
const video = () => document.querySelector<HTMLInputElement>('[data-sac-video]')!

describe('the sheet', () => {
  it('a voice note alone is a whole report', async () => {
    const { adapters, submitted, parts } = await setup()
    await sheet(adapters)
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true)
    record()
    await waitFor(() => expect((sendButton() as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(sendButton())
    await waitFor(() => expect(submitted).toHaveLength(1))
    expect(submitted[0].words).toBe('')
    expect(submitted[0].voice).toEqual([{ file: 'voice-1.webm', ms: 4000, field: 'words' }])
    expect(submitted[0].kind).toBe('change')
    await waitFor(() => expect(parts).toEqual([{ id: submitted[0].id, file: 'voice-1.webm' }]))
  })

  it('keeps one copy of a note: the recorder\'s own blob is deleted once the report holds its copy', async () => {
    const { adapters, db } = await setup()
    await sheet(adapters)
    record()
    await screen.findByText('Voice note 1, 0:04')
    expect(await db.get('blobs', 'take-words')).toBeUndefined()
  })

  it('the receipt never says received while the report is only on the phone', async () => {
    let release: (v: 'done') => void = () => {}
    const gate = new Promise<'done'>((res) => { release = res })
    const submitted: Report[] = []
    const { adapters } = await setup({}, SAM, { submit: async (r) => { submitted.push(r); return gate } })
    await sheet(adapters)
    fireEvent.change(screen.getByLabelText('Your suggestion'), { target: { value: 'bigger photos please' } })
    fireEvent.click(sendButton())
    expect((await screen.findAllByText('On this phone, waiting to send.')).length).toBeGreaterThan(0)
    await waitFor(() => expect(submitted).toHaveLength(1))
    expect(screen.queryByText(/Got it/)).toBeNull()
    await act(async () => { release('done'); await gate })
    expect((await screen.findAllByText("Got it. Freeda picks it up next time Alex's Mac is on.")).length).toBeGreaterThan(0)
  })

  it('a rebuilt adapters object (a parent re-render) does not start a second outbox, and the receipt still lands', async () => {
    let release: (v: 'done') => void = () => {}
    const gate = new Promise<'done'>((res) => { release = res })
    const submitted: Report[] = []
    const { adapters } = await setup({}, SAM, { submit: async (r) => { submitted.push(r); return gate } })
    const r = await sheet(adapters)
    fireEvent.change(screen.getByLabelText('Your suggestion'), { target: { value: 'x' } })
    fireEvent.click(sendButton())
    await waitFor(() => expect(submitted).toHaveLength(1))
    r.rerender(<SuggestSheet adapters={{ ...adapters }} where={where} onClose={() => {}} />)
    r.rerender(<SuggestSheet adapters={{ ...adapters }} where={where} onClose={() => {}} />)
    await act(async () => { await new Promise((res) => setTimeout(res, 30)) })
    expect(submitted).toHaveLength(1)
    await act(async () => { release('done'); await gate })
    expect((await screen.findAllByText(/Got it/)).length).toBeGreaterThan(0)
  })

  it('a Helm that posts straight to the Mac says so', async () => {
    const { adapters } = await setup({ lands: 'mac' })
    await sheet(adapters)
    fireEvent.change(screen.getByLabelText('Your suggestion'), { target: { value: 'x' } })
    fireEvent.click(sendButton())
    expect((await screen.findAllByText('On your Mac.')).length).toBeGreaterThan(0)
  })

  it('the receipt words are the design\'s three lines', () => {
    expect(receiptWords('on-phone', { owner: 'Alex' })).toBe('On this phone, waiting to send.')
    expect(receiptWords('received', { owner: 'Sam' })).toBe("Got it. Freeda picks it up next time Sam's Mac is on.")
    expect(receiptWords('on-mac', { owner: 'Alex' })).toBe('On your Mac.')
  })

  it('after Send, focus moves to the receipt, the live region carries its line, and Tab stays in the dialog', async () => {
    const { adapters } = await setup({}, SAM, { submit: () => new Promise(() => {}) })
    await sheet(adapters)
    fireEvent.change(screen.getByLabelText('Your suggestion'), { target: { value: 'x' } })
    fireEvent.click(sendButton())
    await waitFor(() => expect(document.activeElement?.hasAttribute('data-receipt')).toBe(true))
    expect(document.querySelector('[data-sac-live]')!.textContent).toBe('On this phone, waiting to send.')
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.keyDown(document.body, { key: 'Tab' })
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  })

  it('the default line is the design\'s sentence; the time and the screen size are opt-in', async () => {
    const { adapters } = await setup()
    await sheet(adapters)
    const line = () => document.querySelector('[data-sac-summary]')!.textContent
    expect(line()).toBe("Goes to Alex and Freeda. Includes the app's version, this screen's name and your phone type.")
    fireEvent.click(screen.getByRole('switch', { name: 'Include the time' }))
    expect(line()).toBe("Goes to Alex and Freeda. Includes the app's version, this screen's name, the time and your phone type.")
    fireEvent.click(screen.getByRole('switch', { name: 'Include your screen size' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Include your phone type' }))
    fireEvent.click(screen.getByRole('switch', { name: "Include the app's version" }))
    expect(line()).toBe("Goes to Alex and Freeda. Includes this screen's name, the time and your screen size.")
    expect(screen.getAllByRole('switch')).toHaveLength(4)
    const where_ = document.querySelector('[data-sac-where]')!.textContent!
    expect(where_).toContain('Photos')
    expect(where_).toContain('/photos')
    expect(where_).not.toContain('x=1')
  })

  it.each([['appVersion', "the app's version"], ['at', 'the time'], ['screen', 'your screen size'], ['device', 'your phone type']])('switching off %s removes exactly that field from the queued report', async (name, label) => {
    const { adapters, submitted } = await setup()
    await sheet(adapters)
    // the time and the screen size are opt-in; turn them on so all four are in play, then turn one off
    for (const l of ['the time', 'your screen size']) fireEvent.click(screen.getByRole('switch', { name: `Include ${l}` }))
    fireEvent.click(screen.getByRole('switch', { name: `Include ${label}` }))
    fireEvent.change(screen.getByLabelText('Your suggestion'), { target: { value: 'hi' } })
    fireEvent.click(sendButton())
    await waitFor(() => expect(submitted).toHaveLength(1))
    expect(Object.keys(submitted[0].diagnostics as object).sort()).toEqual(['appVersion', 'at', 'device', 'screen'].filter((k) => k !== name))
    expect(submitted[0].where).toEqual({ screen: 'Photos', route: '/photos' })
  })

  it('diagnostics are the contract\'s four with their real meanings: the screen is its size, the phone type is short', async () => {
    const { adapters, submitted } = await setup({ device: undefined })
    await sheet(adapters)
    for (const l of ['the time', 'your screen size']) fireEvent.click(screen.getByRole('switch', { name: `Include ${l}` }))
    fireEvent.change(screen.getByLabelText('Your suggestion'), { target: { value: 'hi' } })
    fireEvent.click(sendButton())
    await waitFor(() => expect(submitted).toHaveLength(1))
    const d = submitted[0].diagnostics as Record<string, string>
    expect(d.screen).toMatch(/^\d+x\d+$/)
    expect(d.device.length).toBeLessThan(25)
    expect(d.at).toBe('2026-10-12T12:00:00.000Z')
    expect(d.appVersion).toBe('1.2.3')
    expect(JSON.stringify(submitted[0])).not.toMatch(/@/)
  })

  it('the kind choice is a radio group of the design\'s three choices, and broken asks the design\'s three optional questions', async () => {
    const { adapters, submitted } = await setup()
    await sheet(adapters)
    const group = screen.getByRole('radiogroup')
    expect(within(group).getAllByRole('radio').map((r) => r.parentElement!.textContent)).toEqual(['Change something', 'Something is broken', 'Just feedback'])
    fireEvent.click(screen.getByRole('radio', { name: 'Something is broken' }))
    for (const q of ['What happened', 'What you expected', 'How to make it happen again']) expect(screen.getByLabelText(q)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'it froze' } })
    fireEvent.click(sendButton())
    await waitFor(() => expect(submitted).toHaveLength(1))
    expect(submitted[0].kind).toBe('broken')
    expect(submitted[0].answers).toEqual({ happened: 'it froze', expected: '', steps: '' })
  })

  it('answers typed under "broken" do not enable Send once another kind is chosen', async () => {
    const { adapters } = await setup()
    await sheet(adapters)
    fireEvent.click(screen.getByRole('radio', { name: 'Something is broken' }))
    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'it froze' } })
    expect((sendButton() as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('radio', { name: 'Just feedback' }))
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true)
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
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(focusables[0])
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('Escape closes it', async () => {
    const { adapters } = await setup()
    const onClose = vi.fn()
    render(<SuggestSheet adapters={adapters} where={where} onClose={onClose} />)
    await screen.findByRole('dialog')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('adds six pictures, refuses the seventh, shows sizes and a remove control', async () => {
    const { adapters } = await setup()
    await sheet(adapters)
    fireEvent.change(images(), { target: { files: [1, 2, 3, 4, 5, 6, 7].map((i) => png(`p${i}.png`)) } })
    await screen.findByText('p6.png, 2.0 KB')
    expect(screen.queryByText(/p7\.png/)).toBeNull()
    expect(screen.getAllByRole('button', { name: /^Remove p/ })).toHaveLength(6)
    expect(screen.getByRole('alert').textContent).toBe('Up to 6 pictures.')
    fireEvent.click(screen.getByRole('button', { name: 'Remove p1.png' }))
    await waitFor(() => expect(screen.queryByText(/p1\.png/)).toBeNull())
  })

  it('an app may lower the limit but never raise it, and a size error is said in megabytes', async () => {
    const { adapters } = await setup({ limits: { images: 2, imageBytes: 99 * 2 ** 20 } })
    await sheet(adapters)
    fireEvent.change(images(), { target: { files: [png('a.png'), png('b.png'), png('c.png')] } })
    await screen.findByText('b.png, 2.0 KB')
    expect(screen.queryByText(/c\.png/)).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe('Up to 2 pictures.')
    expect(effectiveCeilings({ images: 50, imageBytes: 1 }).images).toBe(6)
    expect(effectiveCeilings({ images: 50, imageBytes: 1 }).imageBytes).toBe(1)
  })

  it('a size error is said in megabytes, never as a raw byte count', async () => {
    const { adapters } = await setup()
    await sheet(adapters)
    fireEvent.change(images(), { target: { files: [new File([new Uint8Array(11 * 2 ** 20)], 'huge.png', { type: 'image/png' })] } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('huge.png is over 10 MB.'))
  })

  it('a picture or video format the app cannot take is refused in words on the phone, and a HEIC with no type is taken by its extension', async () => {
    const { adapters } = await setup()
    await sheet(adapters)
    fireEvent.change(images(), { target: { files: [new File([new Uint8Array(100)], 'photo.avif', { type: 'image/avif' })] } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/photo\.avif is a kind of file this app cannot take/))
    expect(screen.queryByText(/photo\.avif,/)).toBeNull() // not listed as an attachment
    fireEvent.change(images(), { target: { files: [new File([new Uint8Array(100)], 'IMG_1.HEIC', { type: '' })] } })
    expect(await screen.findByText(/IMG_1\.HEIC/)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a video: one at most, within the length ceiling, and one whose length cannot be read is refused in words', async () => {
    let ms: number | undefined = 61_000
    const { adapters } = await setup({}, SAM)
    adapters.phone = { ...adapters.phone, videoLength: async () => ms }
    await sheet(adapters)
    const mp4 = (name: string) => new File([new Uint8Array(100)], name, { type: 'video/mp4' })
    fireEvent.change(video(), { target: { files: [mp4('long.mp4')] } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('long.mp4 is longer than 60 seconds.'))
    ms = undefined
    fireEvent.change(video(), { target: { files: [mp4('odd.mp4')] } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('We could not check how long odd.mp4 is. Try a shorter video.'))
    ms = 5_000
    fireEvent.change(video(), { target: { files: [mp4('ok.mp4')] } })
    await screen.findByText('ok.mp4, 100 B')
    fireEvent.change(video(), { target: { files: [mp4('two.mp4')] } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('One video at most.'))
  })

  it('the browser\'s own player is tried with a short wait, and a video it cannot read in time is refused', async () => {
    const { adapters } = await setup({ phone: { store: await openStore(`probe-${++n}`), probeMs: 30 } })
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL() {} }))
    await sheet(adapters)
    fireEvent.change(video(), { target: { files: [new File([new Uint8Array(10)], 'slow.mp4', { type: 'video/mp4' })] } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/could not check how long slow\.mp4 is/))
    vi.unstubAllGlobals()
  })

  it('voice limits: a note over the limit and notes past the total are not kept', async () => {
    const { adapters } = await setup({ limits: { voiceMs: 3000 } })
    await sheet(adapters)
    record()
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText(/Voice note 1/)).toBeNull()
    cleanup()
    const t = await setup({ limits: { voiceTotalMs: 5000 } })
    await sheet(t.adapters)
    record()
    await screen.findByText('Voice note 1, 0:04')
    record()
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText(/Voice note 2/)).toBeNull()
  })

  it('a note recorded with the module\'s own field is kept in the sheet, and one that runs to the limit is kept at the limit', async () => {
    const blob = new Blob(['audio'], { type: 'audio/mp4' })
    const startTake = vi.fn(async (_s: unknown, key: string) => ({ started: 0, level: () => null, stop: async () => ({ key, blob, ms: 400 }), cancel: async () => {} }))
    const { adapters, submitted } = await setup({ Field: undefined, limits: { voiceMs: 100 }, startTake: startTake as unknown as Adapters['startTake'] })
    await sheet(adapters)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Hold to talk: Your suggestion' }))
    await screen.findByText('Voice note 1, 0:00', undefined, { timeout: 2000 })
    fireEvent.click(sendButton())
    await waitFor(() => expect(submitted).toHaveLength(1))
    expect((submitted[0].voice as { ms: number }[])[0].ms).toBe(100)
  })

  it('a take cut off by a closed app rejoins the draft', async () => {
    const { adapters, db } = await setup()
    const scope = draftKey({ app: adapters.words.app, account: 'sam' })
    await db.put('kv', 'rec:take:words:1', { questionId: `${scope}|field:words`, mime: 'audio/webm', startedAt: 1 })
    await db.put('blobs', 'take:words:1#00000', new Blob(['a'], { type: 'audio/webm' }))
    await db.put('blobs', 'take:words:1#00001', new Blob(['b'], { type: 'audio/webm' }))
    await sheet(adapters)
    await screen.findByText('Voice note 1, 0:02')
    expect((sendButton() as HTMLButtonElement).disabled).toBe(false)
    expect(await db.get('blobs', 'take:words:1')).toBeUndefined()
  })

  it('a take cut off beside a note already kept does not overwrite it', async () => {
    const { adapters, db, submitted } = await setup()
    const first = await sheet(adapters)
    record()
    await screen.findByText('Voice note 1, 0:04')
    const key = draftKey({ app: adapters.words.app, account: 'sam' })
    await waitFor(async () => expect((await loadDraft(db, key))?.attachments).toHaveLength(1))
    first.unmount()
    await db.put('kv', 'rec:take:words:7', { questionId: `${key}|field:words`, mime: 'audio/webm', startedAt: 1 })
    await db.put('blobs', 'take:words:7#00000', new Blob(['cut'], { type: 'audio/webm' }))
    await sheet(adapters)
    await screen.findByText('Voice note 2, 0:01')
    expect((await db.all('blobs')).filter((b) => b.key.startsWith('voice:'))).toHaveLength(2)
    fireEvent.click(sendButton())
    await waitFor(() => expect(submitted).toHaveLength(1))
    const files = (submitted[0].voice as { file: string }[]).map((v) => v.file)
    expect(new Set(files).size).toBe(2)
  })

  it('numbers continue from the highest take after a restore, so removing one never overwrites another', async () => {
    const { adapters, submitted, db } = await setup()
    const first = await sheet(adapters)
    for (let i = 0; i < 3; i++) record()
    await screen.findByText('Voice note 3, 0:04')
    fireEvent.click(screen.getByRole('button', { name: 'Remove Voice note 1, 0:04' }))
    await waitFor(() => expect(screen.queryByText('Voice note 3, 0:04')).toBeNull())
    const key = draftKey({ app: adapters.words.app, account: 'sam' })
    await waitFor(async () => expect((await loadDraft(db, key))?.attachments).toHaveLength(2))
    first.unmount()
    await sheet(adapters)
    await screen.findByText('Voice note 2, 0:04')
    record()
    await screen.findByText('Voice note 3, 0:04')
    fireEvent.click(sendButton())
    await waitFor(() => expect(submitted).toHaveLength(1))
    expect((submitted[0].voice as { file: string }[]).map((v) => v.file)).toEqual(['voice-2.webm', 'voice-3.webm', 'voice-4.webm'])
  })

  it('shows progress for each attachment while sending, and a retry when one fails', async () => {
    let fail = true
    const { adapters, submitted } = await setup({}, SAM, { uploadPart: async () => (fail ? { refused: 'storage is full' } : 'done') })
    await sheet(adapters)
    fireEvent.change(images(), { target: { files: [png('shot.png', 10)] } })
    await screen.findByText('shot.png, 10 B')
    fireEvent.click(sendButton())
    await screen.findByText(/Did not send: storage is full/)
    expect(submitted).toHaveLength(1)
    fail = false
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0])
    await screen.findByText('Sent')
    expect((await screen.findAllByText(/Got it/)).length).toBeGreaterThan(0)
  })

  it('keeps the words as they are typed and puts them back on the next open', async () => {
    const { adapters, db } = await setup()
    const first = await sheet(adapters)
    fireEvent.change(screen.getByLabelText('Your suggestion'), { target: { value: 'half a thought' } })
    const key = draftKey({ app: adapters.words.app, account: 'sam' })
    await waitFor(async () => expect((await loadDraft(db, key))?.words).toBe('half a thought'))
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

  it('every person-facing line can be replaced through words.text', async () => {
    const { adapters } = await setup({ words: { app: `app${++n}`, owner: 'Alex', text: { upToImages: (k) => `Max ${k} images`, sentWord: 'Delivered', send: 'Ship it' } } })
    await sheet(adapters)
    fireEvent.change(images(), { target: { files: [1, 2, 3, 4, 5, 6, 7].map((i) => png(`p${i}.png`)) } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Max 6 images'))
    expect(screen.getByRole('button', { name: 'Ship it' })).toBeTruthy()
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
    await waitFor(() => expect((screen.getByLabelText('What happened') as HTMLTextAreaElement).value).toBe('boom at line 3'))
    expect((screen.getByRole('radio', { name: 'Something is broken' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(sendButton())
    await waitFor(() => expect(submitted).toHaveLength(1))
    expect((submitted[0].where as { screen: string }).screen).toBe('Photos')
  })

  it('Report a problem wins over the kind of a draft left behind', async () => {
    const { adapters, db } = await setup()
    const first = await sheet(adapters)
    fireEvent.click(screen.getByRole('radio', { name: 'Just feedback' }))
    fireEvent.change(screen.getByLabelText('Your suggestion'), { target: { value: 'kept words' } })
    const key = draftKey({ app: adapters.words.app, account: 'sam' })
    await waitFor(async () => expect((await loadDraft(db, key))?.kind).toBe('feedback'))
    first.unmount()
    render(<ReportProblem adapters={adapters} screen="Photos" error="boom" />)
    fireEvent.click(screen.getByRole('button', { name: 'Report a problem' }))
    await screen.findByRole('dialog')
    await waitFor(() => expect((screen.getByLabelText('Your suggestion') as HTMLTextAreaElement).value).toBe('kept words'))
    expect((screen.getByRole('radio', { name: 'Something is broken' }) as HTMLInputElement).checked).toBe(true)
  })
})

// The design's table (section 2). Where the owner is named the name is Alex; the Not now meaning keeps the
// contract's neutral wording ("the one-line reason if given"), not the design's "his", because the owner is
// a parameter and is not always a he.
const DESIGN_TABLE: [string, string, string][] = [
  ['on-phone', 'On this phone', 'Not sent yet; it will send when there is a connection'],
  ['received', 'Received', 'The app has it, safely stored'],
  ['with-freeda', 'With Freeda', "Alex's Mac has picked it up"],
  ['waiting-on-owner', 'Waiting on Alex', 'Freeda has a plan and is asking Alex'],
  ['being-made', 'Being made', 'A session is working on it; the current step shows underneath'],
  ['live', 'Done', 'Shipped in the app, with the date it went live'],
  ['sent-to-template', 'Sent to the template', 'It became a change to the template every copy of this app uses; it reaches this app once merged'],
  ['filed', 'Filed', 'It was passed to whoever owns the problem'],
  ['not-now', 'Not now', 'Alex decided against it, with the one-line reason if given'],
]

describe('My suggestions and the detail view', () => {
  it('the status words are the design\'s table (the Not now row keeps the contract\'s neutral wording)', async () => {
    const rows: Summary[] = STATUSES.map((status, i) => ({ id: `r-${i}`, status, at: i }))
    const { adapters } = await setup({}, SAM, { mine: async () => rows })
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

  it('a status the contract does not know shows as itself and does not take the list down', async () => {
    const { adapters } = await setup({}, SAM, { mine: async () => [{ id: 'r-1', status: 'received', at: 1 }, { id: 'r-2', status: 'mystery', at: 2 }] })
    render(<MySuggestions adapters={adapters} />)
    expect(await screen.findByText('mystery')).toBeTruthy()
    expect(screen.getByText('Received')).toBeTruthy()
  })

  it('lists newest first, and a report still on the phone shows as on this phone', async () => {
    const { adapters } = await setup({}, SAM, { mine: async () => [{ id: 'old', status: 'received', at: 1 }, { id: 'new', status: 'being-made', at: 9 }], submit: async () => new Promise(() => {}) })
    const { container } = render(<><SuggestSheet adapters={adapters} where={where} /><MySuggestions adapters={adapters} /></>)
    await screen.findByRole('radiogroup')
    fireEvent.change(screen.getByLabelText('Your suggestion'), { target: { value: 'x' } })
    fireEvent.click(sendButton())
    await waitFor(() => expect(container.querySelectorAll('.sac-row').length).toBe(3))
    const order = [...container.querySelectorAll('.sac-row')].map((r) => r.getAttribute('data-status'))
    expect(order[0]).toBe('on-phone')
    expect(order.slice(1)).toEqual(['being-made', 'received'])
  })

  it('a refused report shows the app\'s reason and a Try again on its row, and opens from the phone\'s own copy', async () => {
    let refuse = true
    const { adapters, submitted } = await setup({}, SAM, { submit: async (r) => { submitted.push(r); return refuse ? { refused: 'that account may not suggest' } : 'done' }, one: async () => { throw new Error('not in the app') } })
    const { container } = render(<><SuggestSheet adapters={adapters} where={where} /><MySuggestions adapters={adapters} /></>)
    await screen.findByRole('radiogroup')
    fireEvent.change(screen.getByLabelText('Your suggestion'), { target: { value: 'my words' } })
    fireEvent.click(sendButton())
    await waitFor(() => expect(container.querySelector('.sac-row .sac-error')?.textContent).toBe('that account may not suggest'))
    fireEvent.click(container.querySelector('.sac-row-button')!)
    await screen.findByText('On this phone', { selector: 'h3' })
    expect(screen.getByText('my words', { selector: '.sac-words' })).toBeTruthy()
    expect(container.querySelector('article .sac-error')?.textContent).toBe('that account may not suggest')
    refuse = false
    fireEvent.click(container.querySelector('article button')!)
    await waitFor(() => expect(submitted.length).toBeGreaterThan(1))
  })

  it('another person on the same phone sees none of a waiting report, and it is sent only while its owner is signed in', async () => {
    let online = false
    const { adapters, submitted, db } = await setup({}, SAM)
    adapters.phone = { store: db, reach: { check: async () => online, mark() {} } }
    const first = await sheet(adapters)
    fireEvent.change(screen.getByLabelText('Your suggestion'), { target: { value: 'sam only' } })
    fireEvent.click(sendButton())
    await screen.findAllByText('On this phone, waiting to send.')
    first.unmount()
    online = true
    const jo: Adapters = { ...adapters, identity: async () => JO }
    render(<MySuggestions adapters={jo} />)
    await screen.findByText('You have not sent a suggestion yet.')
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(submitted).toHaveLength(0)
    cleanup()
    render(<MySuggestions adapters={adapters} />)
    await waitFor(() => expect(submitted).toHaveLength(1))
    expect((submitted[0].who as { member: string }).member).toBe('sam')
  })

  it('My suggestions signed out says to sign in', async () => {
    const { adapters } = await setup({}, null)
    render(<MySuggestions adapters={adapters} />)
    expect((await screen.findByRole('alert')).textContent).toBe('Sign in to see your suggestions.')
  })

  it('the detail shows the step the receiving side puts on the latest timeline entry', async () => {
    const one = vi.fn(async (id: string) => ({ id, words: 'w', media: [], voice: [], timeline: [{ status: 'received', by: 'app', at: 'x' }, { status: 'being-made', by: 'freeda', at: 'y', step: 'Checking the button on a small phone' }] }))
    const { adapters } = await setup({}, SAM, { one })
    render(<SuggestionDetail adapters={adapters} id="r-20261012120000-abcdef" />)
    expect(await screen.findByText('Checking the button on a small phone')).toBeTruthy()
  })

  it('the detail shows words, attachments and the strip, lets the person add to it, and stops at an end status', async () => {
    const appended: Record<string, unknown>[] = []
    const one = vi.fn(async (id: string) => ({ id, status: 'being-made', step: 'Freeda is testing the change', words: 'bigger photos <b>please</b>', media: [{ file: 'image-1.png', type: 'image/png', bytes: 2048 }], voice: [{ file: 'voice-1.webm', ms: 12000 }] }))
    const { adapters } = await setup({}, SAM, { one, append: async (_id, more) => { appended.push(more); return 'done' } })
    render(<SuggestionDetail adapters={adapters} id="r-20261012120000-abcdef" />)
    expect(await screen.findByText('bigger photos <b>please</b>')).toBeTruthy()
    expect(screen.getByText('image-1.png, 2.0 KB')).toBeTruthy()
    expect(screen.getByText('Voice note 1, 0:12')).toBeTruthy()
    expect(screen.getByText('Freeda is testing the change')).toBeTruthy()
    expect(document.querySelector('[aria-current="step"]')!.textContent).toContain('Being made')
    fireEvent.change(screen.getByLabelText('Add to it'), { target: { value: 'also the button is too small' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await screen.findByText('Added.')
    await waitFor(() => expect(appended).toHaveLength(1))
    expect(appended[0].words).toBe('also the button is too small')
    expect(appended[0].followId).toMatch(/^f-/)
  })

  it('a follow-up the app refuses shows its reason and a Try again, and lands when retried; a thrown one just waits', async () => {
    let mode: 'refuse' | 'throw' | 'ok' = 'refuse'
    const appended: Record<string, unknown>[] = []
    const { adapters } = await setup({}, SAM, { one: async (id) => ({ id, status: 'received', words: 'w' }), append: async (_i, more) => {
      if (mode === 'throw') throw new TypeError('offline')
      if (mode === 'refuse') return { refused: 'that report is closed to changes' }
      appended.push(more); return 'done'
    } })
    render(<SuggestionDetail adapters={adapters} id="r-20261012120000-abcdef" />)
    fireEvent.change(await screen.findByLabelText('Add to it'), { target: { value: 'more words' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const row = await waitFor(() => { const r = document.querySelector('[data-followup]'); expect(r?.querySelector('[role="alert"]')?.textContent).toBe('that report is closed to changes'); return r! })
    mode = 'throw'
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(document.querySelector('[data-followup]')?.textContent).toContain('Waiting to send'))
    mode = 'ok'
    refreshIdentity()
    await act(async () => { const rt = await getRuntime(adapters, SAM); await rt.drain() })
    await waitFor(() => expect(appended).toHaveLength(1))
    await waitFor(() => expect(document.querySelector('[data-followup]')).toBeNull())
  })

  it('a voice note under "Add to it" is as durable as a report: nothing is sent before Add, it queues through the outbox, keeps its refusal and retries, and only then does its blob go', async () => {
    const blob = new Blob(['audio'], { type: 'audio/mp4' })
    const db0 = await openStore(`fu-${++n}`)
    const startTake = vi.fn(async (_s: unknown, key: string) => { await db0.put('blobs', key, blob); return { started: 0, level: () => null, stop: async () => ({ key, blob, ms: 2000 }), cancel: async () => {} } })
    let fail = true
    const appended: Record<string, unknown>[] = []
    const order: string[] = []
    const { adapters, parts } = await setup({ Field: undefined, phone: { store: db0 }, startTake: startTake as unknown as Adapters['startTake'] }, SAM, {
      one: async (id) => ({ id, status: 'received', words: 'w' }),
      uploadPart: async (id, file) => { order.push('part'); if (fail) return { refused: 'storage is full' }; parts.push({ id, file }); return 'done' },
      append: async (_i, more) => { order.push('append'); appended.push(more); return 'done' },
    })
    render(<SuggestionDetail adapters={adapters} id="r-20261012120000-abcdef" />)
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Hold to talk: Add to it' }))
    await screen.findByRole('button', { name: /Stop and keep/ })
    fireEvent.pointerUp(screen.getByRole('button', { name: /Stop and keep/ }))
    await screen.findByText('Voice note 1, 0:02')
    expect(order).toEqual([])
    expect((await db0.all('blobs')).map((b) => b.key).filter((k) => k.startsWith('take:'))).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const row = await waitFor(() => { const r = document.querySelector('[data-followup]'); expect(r?.querySelector('[role="alert"]')?.textContent).toBe('storage is full'); return r! })
    expect((await db0.all('blobs')).filter((b) => b.key.startsWith('fu:')).length).toBe(1)
    expect(order[0]).toBe('append')
    fail = false
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(parts).toHaveLength(1))
    expect(appended).toHaveLength(1)
    expect((appended[0].voice as { ms: number }[])[0].ms).toBe(2000)
    expect(parts[0].file).toMatch(/^added-f-.*\.mp4$/)
    await waitFor(async () => expect((await db0.all('blobs')).filter((b) => b.key.startsWith('fu:'))).toHaveLength(0))
    expect((await db0.all('kv')).filter((k) => k.key.includes('#fu:'))).toHaveLength(0)
  })

  it('a take cut off under "Add to it" does not overwrite a note already kept: two distinct notes, two parts sent', async () => {
    const appended: Record<string, unknown>[] = []
    const { adapters, db, parts } = await setup({ Field: undefined }, SAM, { one: async (id) => ({ id, status: 'received', words: 'w' }), append: async (_i, more) => { appended.push(more); return 'done' } })
    const rid = 'r-20261012120000-abcdef'
    const key = draftKey({ app: adapters.words.app, account: 'sam' })
    await db.put('blobs', `fu:${rid}:f-aaaaaa:1`, new Blob(['kept'], { type: 'audio/webm' }))
    await db.put('kv', `${key}#fu:${rid}`, { followId: 'f-aaaaaa', words: '', heard: [{ key: `fu:${rid}:f-aaaaaa:1`, file: 'added-f-aaaaaa-1.webm', ms: 3000 }] })
    await db.put('kv', 'rec:take:append:9', { questionId: `${key}|field:append-${rid}`, mime: 'audio/webm', startedAt: 1 })
    await db.put('blobs', 'take:append:9#00000', new Blob(['cut'], { type: 'audio/webm' }))
    render(<SuggestionDetail adapters={adapters} id={rid} />)
    await screen.findByText('Voice note 2, 0:01')
    expect(screen.getByText('Voice note 1, 0:03')).toBeTruthy()
    expect((await db.all('blobs')).map((b) => b.key).filter((k) => k.startsWith('fu:')).sort()).toEqual([`fu:${rid}:f-aaaaaa:1`, `fu:${rid}:f-aaaaaa:2`])
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(parts).toHaveLength(2))
    expect(new Set(parts.map((p) => p.file)).size).toBe(2)
    expect((appended[0].voice as unknown[]).length).toBe(2)
  })

  it('words typed before the saved follow-up has loaded are kept, not replaced by the saved words', async () => {
    const { adapters, db } = await setup({ Field: undefined }, SAM, { one: async (id) => ({ id, status: 'received', words: 'w' }) })
    const rid = 'r-20261012120000-abcdef'
    const key = draftKey({ app: adapters.words.app, account: 'sam' })
    await db.put('kv', `${key}#fu:${rid}`, { followId: 'f-aaaaaa', words: 'old saved words', heard: [] })
    const slow = { ...db, get: async (s: never, k: string) => { if (String(k).includes('#fu:')) await new Promise((r) => setTimeout(r, 80)); return db.get(s, k) } } as typeof db
    adapters.phone = { store: slow }
    render(<SuggestionDetail adapters={adapters} id={rid} />)
    fireEvent.change(await screen.findByLabelText('Add to it'), { target: { value: 'typed first' } })
    await act(async () => { await new Promise((r) => setTimeout(r, 200)) })
    expect((screen.getByLabelText('Add to it') as HTMLTextAreaElement).value).toBe('typed first')
  })

  it('a refused follow-up holds its voice part (nothing uploads), and Discard drops both without deleting anything else', async () => {
    const { adapters, db, parts } = await setup({ Field: undefined }, SAM, { one: async (id) => ({ id, status: 'received', words: 'w' }), append: async () => ({ refused: 'closed' }) })
    const rid = 'r-20261012120000-abcdef'
    const key = draftKey({ app: adapters.words.app, account: 'sam' })
    await db.put('blobs', `fu:${rid}:f-bbbbbb:1`, new Blob(['kept'], { type: 'audio/webm' }))
    await db.put('kv', `${key}#fu:${rid}`, { followId: 'f-bbbbbb', words: 'with a note', heard: [{ key: `fu:${rid}:f-bbbbbb:1`, file: 'added-f-bbbbbb-1.webm', ms: 3000 }] })
    render(<SuggestionDetail adapters={adapters} id={rid} />)
    await screen.findByText('Voice note 1, 0:03')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    const row = await waitFor(() => { const r = document.querySelector('[data-followup]'); expect(r?.querySelector('[role="alert"]')?.textContent).toBe('closed'); return r! })
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(parts).toHaveLength(0)
    expect((await db.all('blobs')).filter((b) => b.key.startsWith('fu:'))).toHaveLength(1)
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(document.querySelector('[data-followup]')).toBeNull())
    expect((await db.all('blobs')).filter((b) => b.key.startsWith('fu:'))).toHaveLength(0)
    expect((await db.all('outbox'))).toHaveLength(0)
  })

  it('a follow-up being written survives closing the detail, and a take cut off under "Add to it" rejoins it', async () => {
    const { adapters, db } = await setup({ Field: undefined }, SAM, { one: async (id) => ({ id, status: 'received', words: 'w' }) })
    const key = draftKey({ app: adapters.words.app, account: 'sam' })
    await db.put('kv', 'rec:take:append:1', { questionId: `${key}|field:append-r-20261012120000-abcdef`, mime: 'audio/webm', startedAt: 1 })
    await db.put('blobs', 'take:append:1#00000', new Blob(['a'], { type: 'audio/webm' }))
    const first = render(<SuggestionDetail adapters={adapters} id="r-20261012120000-abcdef" />)
    await screen.findByText('Voice note 1, 0:01')
    fireEvent.change(screen.getByLabelText('Add to it'), { target: { value: 'half typed' } })
    await waitFor(async () => expect((await db.get<{ words: string }>('kv', `${key}#fu:r-20261012120000-abcdef`))?.words).toBe('half typed'))
    first.unmount()
    render(<SuggestionDetail adapters={adapters} id="r-20261012120000-abcdef" />)
    await screen.findByText('Voice note 1, 0:01')
    await waitFor(() => expect((screen.getByLabelText('Add to it') as HTMLTextAreaElement).value).toBe('half typed'))
  })

  it('where the app cannot take a voice note afterwards, the record control says so instead of recording', async () => {
    const { adapters } = await setup({ Field: undefined, appVoice: undefined, appendVoice: false } as Partial<Adapters>, SAM, { one: async (id) => ({ id, status: 'received', words: 'w' }) })
    render(<SuggestionDetail adapters={adapters} id="r-20261012120000-abcdef" />)
    const control = await screen.findByRole('button', { name: 'Voice notes cannot be added here: Add to it' })
    expect((control as HTMLButtonElement).disabled).toBe(true)
  })

  it('a microphone refusal in the detail view is a visible message, not silence', async () => {
    const startTake = vi.fn(async () => { throw new Error('denied') })
    const { adapters } = await setup({ Field: undefined, startTake: startTake as unknown as Adapters['startTake'] }, SAM, { one: async (id) => ({ id, status: 'received', words: 'w' }) })
    render(<SuggestionDetail adapters={adapters} id="r-20261012120000-abcdef" />)
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Hold to talk: Add to it' }))
    expect(await screen.findByText('The microphone could not be used. You can type it instead.')).toBeTruthy()
  })

  it('offers no way to add once the suggestion has an end status', async () => {
    const { adapters } = await setup({}, SAM, { one: async (id) => ({ id, status: 'live', words: 'done' }) })
    render(<SuggestionDetail adapters={adapters} id="r-20261012120000-abcdef" />)
    await screen.findAllByText('Done')
    expect(screen.queryByLabelText('Add to it')).toBeNull()
  })

  it('the strip is the contract\'s statuses and is marked from the report\'s own timeline', () => {
    const { container, rerender } = render(<StatusStrip status="not-now" owner="Alex" timeline={['on-phone', 'received', 'with-freeda', 'waiting-on-owner', 'not-now']} />)
    const words = () => [...container.querySelectorAll('li')].map((li) => li.querySelector('span')!.textContent)
    const states = () => [...container.querySelectorAll('li')].map((li) => li.getAttribute('data-state'))
    expect(words()).toEqual(['On this phone', 'Received', 'With Freeda', 'Waiting on Alex', 'Being made', 'Not now'])
    expect(states()).toEqual(['past', 'past', 'past', 'past', 'skipped', 'now'])
    rerender(<StatusStrip status="live" owner="Alex" timeline={['received', 'with-freeda', 'planned', 'being-made', 'live']} />)
    expect(states()).toEqual(['skipped', 'past', 'past', 'skipped', 'past', 'now'])
  })
})

describe('every text field sits in a voice field container', () => {
  it('in the sheet (every kind), the detail view and the list, with the module\'s own field', async () => {
    const { adapters } = await setup({ Field: undefined }, SAM, { one: async (id) => ({ id, status: 'received', words: 'w' }), mine: async () => [{ id: 'r-1', status: 'received', at: 1 }] })
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
    const startTake = vi.fn(async (_s: unknown, key: string) => ({ started: 0, level: () => null, stop: async () => ({ key, blob, ms }), cancel: async () => {} }))
    return { startTake: startTake as unknown as FieldProps['startTake'] }
  }
  it('records while the button is held and hands the take to upload; transcription is not its job', async () => {
    const store = await openStore(`field-${++n}`)
    const { startTake } = fakeTake()
    const upload = vi.fn(async (_k: string, _b: Blob, _ms: number) => ({ audio: 'k', text: '' }))
    const onChange = vi.fn()
    render(<DefaultField rt={{ store }} id="words" label="Your suggestion" value="" onChange={onChange} upload={upload} startTake={startTake} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: /Hold to talk/ }))
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
  it('with nowhere to send a take, the control is off and says why instead of recording into nothing', async () => {
    const store = await openStore(`field-${++n}`)
    render(<DefaultField rt={{ store }} id="x" label="Say" value="" onChange={() => {}} />)
    expect((screen.getByRole('button', { name: 'Voice notes cannot be added here: Say' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('accounts on one phone', () => {
  async function waitingAsSam() {
    let online = false
    const t = await setup({}, SAM)
    t.adapters.phone = { store: t.db, reach: { check: async () => online, mark() {} } }
    const first = await sheet(t.adapters)
    fireEvent.change(screen.getByLabelText('Your suggestion'), { target: { value: 'sam only' } })
    fireEvent.click(sendButton())
    await screen.findAllByText('On this phone, waiting to send.')
    first.unmount()
    return { ...t, goOnline: () => { online = true } }
  }

  it('an account switch while My suggestions stays mounted removes the old rows and drains nothing of the old account', async () => {
    const t = await waitingAsSam()
    let current: Identity | null = SAM
    const adapters: Adapters = { ...t.adapters, identity: async () => current }
    render(<MySuggestions adapters={adapters} />)
    await screen.findByText('sam only')
    t.goOnline()
    current = JO
    await act(async () => { refreshIdentity(); await new Promise((r) => setTimeout(r, 30)) })
    await screen.findByText('You have not sent a suggestion yet.')
    expect(screen.queryByText('sam only')).toBeNull()
    expect(t.submitted).toHaveLength(0)
    current = null
    await act(async () => { refreshIdentity() })
    expect((await screen.findByRole('alert')).textContent).toBe('Sign in to see your suggestions.')
  })

  it('a rebuilt adapters object asks who is signed in again', async () => {
    const t = await waitingAsSam()
    const { rerender } = render(<MySuggestions adapters={t.adapters} />)
    await screen.findByText('sam only')
    rerender(<MySuggestions adapters={{ ...t.adapters, identity: async () => JO }} />)
    await screen.findByText('You have not sent a suggestion yet.')
  })

  it('every send confirms the account first: a stale runtime does not drain under another session', async () => {
    const t = await waitingAsSam()
    t.goOnline()
    const stale = await getRuntime({ ...t.adapters, identity: async () => SAM }, SAM)
    stale.adapters = { ...t.adapters, identity: async () => JO }
    await stale.drain()
    expect(t.submitted).toHaveLength(0)
    stale.adapters = { ...t.adapters, identity: async () => SAM }
    await stale.drain()
    expect(t.submitted).toHaveLength(1)
  })

  it('a take cut off under one account does not rejoin another account\'s draft, and still rejoins its own', async () => {
    const { adapters, db } = await setup()
    const joKey = draftKey({ app: adapters.words.app, account: 'jo' })
    await db.put('kv', 'rec:take:jo:1', { questionId: `${joKey}|field:words`, mime: 'audio/webm', startedAt: 1 })
    await db.put('blobs', 'take:jo:1#00000', new Blob(['a'], { type: 'audio/webm' }))
    const first = await sheet(adapters)
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(screen.queryByText(/Voice note 1/)).toBeNull()
    expect(await db.get('kv', 'rec:take:jo:1')).toBeDefined()
    first.unmount()
    await sheet({ ...adapters, identity: async () => JO })
    await screen.findByText('Voice note 1, 0:01')
  })
})

describe('smaller promises', () => {
  it('a load still running for the account just replaced never paints its rows under the next one', async () => {
    let release: (v: Summary[]) => void = () => {}
    let slow = true
    const t = await setup({}, SAM, { mine: () => (slow ? new Promise<Summary[]>((r) => { release = r }) : Promise.resolve([])) })
    let current: Identity | null = SAM
    const adapters: Adapters = { ...t.adapters, identity: async () => current }
    render(<MySuggestions adapters={adapters} />)
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    slow = false
    current = JO
    await act(async () => { refreshIdentity(); await new Promise((r) => setTimeout(r, 30)) })
    await screen.findByText('You have not sent a suggestion yet.')
    await act(async () => { release([{ id: 'r-sam', status: 'received', at: 1, words: 'sam row' }]); await new Promise((r) => setTimeout(r, 30)) })
    expect(screen.queryByText('sam row')).toBeNull()
  })

  it('with no voice time left, the field refuses before recording', async () => {
    const store = await openStore(`field-${++n}`)
    const startTake = vi.fn()
    render(<><DefaultField rt={{ store }} id="w" label="Say" value="" onChange={() => {}} upload={async () => ({ audio: 'k', text: '' })} startTake={startTake as never} maxMs={0} labels={{ holdToTalk: 'Hold', stopTalking: 'Stop', micDenied: 'no mic', voiceUnavailable: 'off', voiceTotalLimit: 'No voice time left; type the rest.' }} /><Toasts /></>)
    fireEvent.pointerDown(screen.getByRole('button'))
    expect(await screen.findByText('No voice time left; type the rest.')).toBeTruthy()
    expect(startTake).not.toHaveBeenCalled()
  })

  it('the receipt says nothing for an id this phone never queued', async () => {
    const { adapters } = await setup()
    const { container } = render(<Receipt adapters={adapters} reportId="r-20261012120000-zzzzzz" />)
    await waitFor(() => expect(container.querySelector('[data-receipt]')).toBeNull())
    expect(container.textContent).toBe('')
  })

  it('the strip\'s accessible name honors the app\'s own words', async () => {
    const { adapters } = await setup({ words: { app: `app${++n}`, owner: 'Alex', text: { stepLabel: 'Progress' } } }, SAM, { one: async (id) => ({ id, status: 'received', words: 'w' }) })
    render(<SuggestionDetail adapters={adapters} id="r-20261012120000-abcdef" />)
    expect(await screen.findByRole('list', { name: 'Progress' })).toBeTruthy()
  })
})
