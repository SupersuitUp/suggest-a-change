// @vitest-environment jsdom
// EVERY PIECE OF CONTEXT THAT HELPS FIX IT, collected by the module with no app code, each saying why it is shared.
// Never an input's value, a cookie, storage or a query string.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectContext, contextTrail, installContextListeners, parseUserAgent, resetContext } from '../../src/client/context.ts'

beforeEach(() => { resetContext(); document.body.innerHTML = ''; installContextListeners() })
afterEach(() => { resetContext(); vi.restoreAllMocks() })

describe('the trail, kept in memory from the moment the module mounts', () => {
  it('keeps the last 10 routes visited, with times, never their query or hash', () => {
    for (let i = 0; i < 12; i++) history.pushState({}, '', `/page-${i}?token=secret${i}#frag`)
    history.replaceState({}, '', '/last?x=1')
    const routes = contextTrail().routes
    expect(routes).toHaveLength(10)
    expect(routes.at(-1)!.route).toBe('/last')
    expect(JSON.stringify(routes)).not.toMatch(/token|secret|frag|\?/)
    expect(routes.every((r) => !Number.isNaN(Date.parse(r.at)))).toBe(true)
  })

  it('keeps the last 20 taps as what the person tapped is called, and never what they typed', () => {
    document.body.innerHTML = `
      <button id="save"><span id="inner">Save note</span></button>
      <button id="icon" aria-label="Delete this note">x</button>
      <input id="field" type="text" value="my secret password" />
      <input id="named" type="email" aria-label="Your email" value="me@example.com" />
      <textarea id="area">private words</textarea>
      <a id="long" href="/x">${'word '.repeat(40)}</a>`
    const click = (id: string) => document.getElementById(id)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    for (const id of ['inner', 'icon', 'field', 'named', 'area', 'long']) click(id)
    const labels = contextTrail().taps.map((t) => t.label)
    expect(labels.slice(0, 2)).toEqual(['Save note', 'Delete this note'])
    expect(labels[2]).toBe('a text field')
    expect(labels[3]).toBe('Your email')
    expect(labels[4]).toBe('a text box')
    expect(labels[5].length).toBeLessThanOrEqual(60)
    expect(JSON.stringify(contextTrail())).not.toMatch(/secret password|me@example|private words/)
    for (let i = 0; i < 25; i++) click('icon')
    expect(contextTrail().taps).toHaveLength(20)
  })

  it('keeps the last 10 errors and unhandled rejections: the message and first frame, with no query strings', () => {
    const err = Object.assign(new Error('boom'), { stack: 'Error: boom\n    at save (https://app.test/app.js?v=2:10:4)\n    at other (https://app.test/b.js:1:1)' })
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom loading https://app.test/api?token=abc123', error: err }))
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('the save request failed') }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    console.error('could not load', new Error('nope'))
    const errors = contextTrail().errors
    expect(errors[0]).toMatchObject({ message: 'boom loading https://app.test/api', frame: 'at save (https://app.test/app.js:10:4)' })
    expect(errors[1].message).toBe('Unhandled rejection: the save request failed')
    expect(errors[2].message).toMatch(/^could not load nope/)
    expect(JSON.stringify(errors)).not.toMatch(/token|abc123|v=2/)
    for (let i = 0; i < 12; i++) window.dispatchEvent(new ErrorEvent('error', { message: `e${i}` }))
    expect(contextTrail().errors).toHaveLength(10)
  })

  it('never takes text from anything someone types into: contenteditable, text roles, or inside a form field', () => {
    document.body.innerHTML = `
      <div id="ce" contenteditable="true"><p id="ce-inner">my private draft</p></div>
      <div id="tb" role="textbox">typed words</div>
      <div id="sb" role="searchbox">search terms</div>
      <div id="cb" role="combobox">chosen thing</div>
      <select id="sel"><option id="opt">secret choice</option></select>`
    for (const id of ['ce-inner', 'tb', 'sb', 'cb', 'opt']) document.getElementById(id)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(contextTrail().taps.map((t) => t.label)).toEqual(['a text field', 'a text field', 'a text field', 'a text field', 'a menu'])
    expect(JSON.stringify(contextTrail())).not.toMatch(/private draft|typed words|search terms|chosen thing|secret choice/)
  })

  it('a route\'s id-like segments become :id, so no id, token or address travels in the trail', () => {
    for (const path of ['/notes/3f2a9c1e-8b7d-4c6e-9f1a-2b3c4d5e6f70/edit', '/share/aB3dE5fG7hJ9kL1mN3pQ', '/users/12345', '/doc/0123456789abcdef0123', '/settings/notifications', '/page-2']) history.pushState({}, '', path)
    expect(contextTrail().routes.map((r) => r.route).slice(-6)).toEqual(['/notes/:id/edit', '/share/:id', '/users/:id', '/doc/:id', '/settings/notifications', '/page-2'])
  })

  it('resetting never undoes a wrapper the host put on history after ours', () => {
    let hostCalls = 0
    const ours = history.pushState
    history.pushState = function (...a: Parameters<History['pushState']>) { hostCalls++; return ours.apply(this, a) }
    const host = history.pushState
    resetContext()
    expect(history.pushState).toBe(host)
    history.pushState({}, '', '/after-reset')
    expect(hostCalls).toBe(1)
    history.pushState = ours // leave the page as it was
  })

  it('installs once across two bundled copies of the module', async () => {
    vi.resetModules()
    const other = await import('../../src/client/context.ts')
    const before = { push: history.pushState, error: console.error }
    other.installContextListeners()
    expect(history.pushState).toBe(before.push) // the second copy wraps nothing again
    expect(console.error).toBe(before.error)
    document.body.innerHTML = '<button id="b2">Twice?</button>'
    document.getElementById('b2')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(other.contextTrail().taps.filter((t) => t.label === 'Twice?')).toHaveLength(1)
    expect(contextTrail().taps.filter((t) => t.label === 'Twice?')).toHaveLength(1) // and both copies see the one trail
  })

  it('installs once, however many screens mount it', () => {
    installContextListeners(); installContextListeners()
    document.body.innerHTML = '<button id="b">Once</button>'
    document.getElementById('b')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(contextTrail().taps.filter((t) => t.label === 'Once')).toHaveLength(1)
  })
})

describe('collectContext', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
  const base = () => ({
    identity: { account: 'mk_7Hq2xP9vL3sT8wK1', role: 'member' as const, name: 'Pat Okafor' },
    where: { screen: 'Notes', route: '/notes?draft=secret' },
    about: { app: 'notes', version: '1.2.3' },
    userAgent: iphone,
  })

  it('collects every built-in item, each with a why, and never the account id or a query', async () => {
    const ctx = await collectContext(base())
    const keys = ctx.items.map((i) => i.key)
    // The page and the app are already first-class pieces of the report (Where, and the app's version), so they are not repeated here.
    expect(keys).toEqual(['account', 'time', 'language', 'device', 'screen', 'appearance', 'connection', 'age'])
    for (const i of ctx.items) expect(i.why.trim().length, i.key).toBeGreaterThan(10)
    const v = (k: string) => ctx.items.find((i) => i.key === k)!.value
    expect(v('account')).toBe('Pat Okafor')
    expect(v('time')).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(v('time')).toMatch(/UTC[+-]\d\d:\d\d/)
    expect(v('device')).toBe('iPhone, iOS 18.1, Safari 18.1')
    expect(v('screen')).toMatch(/screen, \d+x\d+ window, [\d.]+x pixels/)
    expect(v('connection')).toMatch(/^(online|offline)/)
    expect(JSON.stringify(ctx)).not.toMatch(/mk_7Hq2|secret/)
  })

  it('appends what the app adds with its own why, and drops an app item that does not say why', async () => {
    const ctx = await collectContext({ ...base(), extra: async () => [{ label: 'Plan', value: 'Pro, yearly', why: 'some features only exist on Pro' }, { label: 'No reason', value: 'x', why: '' }] })
    const added = ctx.items.filter((i) => i.key.startsWith('app:'))
    expect(added).toEqual([{ key: 'app:0', label: 'Plan', value: 'Pro, yearly', why: 'some features only exist on Pro' }])
  })

  it('never asks for precise location unless the app opts in, and then only rounded', async () => {
    const getCurrentPosition = vi.fn((ok: PositionCallback) => ok({ coords: { latitude: 41.878113, longitude: -87.629799, accuracy: 20 } } as GeolocationPosition))
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition } })
    const plain = await collectContext(base())
    expect(getCurrentPosition).not.toHaveBeenCalled()
    expect(plain.items.find((i) => i.key === 'place')).toBeUndefined()
    const precise = await collectContext({ ...base(), precise: true })
    expect(getCurrentPosition).toHaveBeenCalledTimes(1)
    expect(precise.items.find((i) => i.key === 'place')!.value).toBe('41.878, -87.630')
  })

  it('carries the trail with it', async () => {
    history.pushState({}, '', '/before')
    const ctx = await collectContext(base())
    expect(ctx.routes.at(-1)!.route).toBe('/before')
  })
})

describe('parseUserAgent', () => {
  it('names the device, system and browser in plain words', () => {
    expect(parseUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.100 Mobile Safari/537.36')).toBe('Android phone, Android 14, Chrome 129')
    expect(parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36')).toBe('Mac, macOS, Chrome 130')
    expect(parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.56')).toBe('Windows PC, Windows, Edge 130')
    expect(parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe('Mac, macOS, Firefox 131')
    expect(parseUserAgent('Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')).toBe('iPad, iPadOS 17.5, Safari 17.5')
  })
})
