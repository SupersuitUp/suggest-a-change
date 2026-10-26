// EVERY PIECE OF CONTEXT THAT HELPS FIX IT, collected by the module with no app code. Each item says, in a line written
// for the person sending, why it is shared; the sheet lists them all, on by default, and any one can be left out.
//
// The trail (the last pages, taps and errors) is kept from the moment the module first mounts, in memory only, in
// small ring buffers. NEVER captured: what anyone typed (an input's value), cookies, storage, or a query string.
import type { Identity } from './adapters.ts'

export interface ContextItem { key: string; label: string; value: string; why: string }
export interface Trail { routes: { route: string; at: string }[]; taps: { label: string; at: string }[]; errors: { message: string; frame?: string; at: string }[] }
export interface ReportContext extends Trail { items: ContextItem[] }
/** What an app adds through the `context` adapter: anything app-specific, each with why it helps. */
export interface AppContextItem { label: string; value: string; why: string }

const MAX = { routes: 10, taps: 20, errors: 10, items: 40 }
const trail: Trail = { routes: [], taps: [], errors: [] }
let installedAt = 0
let undo: (() => void) | null = null

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`)
const iso = () => new Date().toISOString()
const push = <T>(list: T[], x: T, max: number) => { list.push(x); if (list.length > max) list.splice(0, list.length - max) }
/** A URL or path with no query and no hash, wherever it appears in a piece of text. */
export const withoutQueries = (s: string) => s.replace(/([^\s?#'"()]*)[?#][^\s'"():]*/g, (_m, before: string) => before)
const routeOf = (href: string) => { try { return new URL(href, 'http://x').pathname } catch { return String(href).split(/[?#]/)[0] } }

function recordRoute() {
  if (typeof location === 'undefined') return
  const route = routeOf(location.href)
  if (trail.routes.at(-1)?.route === route) return
  push(trail.routes, { route: clip(route, 300), at: iso() }, MAX.routes)
}

/** What a tapped thing is called: its label or its text, never what was typed into it. */
function labelOf(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  const el = target.closest('button, a, summary, label, select, textarea, input, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [aria-label]') ?? target
  const aria = el.getAttribute('aria-label')?.trim()
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (aria) return clip(aria, 60)
    const byId = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() : ''
    if (byId) return clip(byId.replace(/\s+/g, ' '), 60)
    if (el instanceof HTMLTextAreaElement) return 'a text box'
    if (el instanceof HTMLSelectElement) return 'a menu'
    const type = el.type
    return type === 'checkbox' ? 'a checkbox' : type === 'radio' ? 'a choice' : type === 'button' || type === 'submit' ? clip(el.value ? 'a button' : 'a button', 60) : 'a text field'
  }
  if (aria) return clip(aria, 60)
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  if (text) return clip(text, 60)
  const title = el.getAttribute('title')?.trim()
  return title ? clip(title, 60) : el.tagName.toLowerCase()
}

const firstFrame = (stack: unknown): string | undefined => {
  if (typeof stack !== 'string') return undefined
  const line = stack.split('\n').slice(1).map((l) => l.trim()).find((l) => /^at |@/.test(l))
  return line ? clip(withoutQueries(line), 200) : undefined
}
const messageOf = (x: unknown): string => (x instanceof Error ? x.message : typeof x === 'string' ? x : x === undefined ? '' : typeof x === 'number' || typeof x === 'boolean' ? String(x) : '[object]')
function recordError(message: string, stack?: unknown) {
  push(trail.errors, { message: clip(withoutQueries(message || 'An error with no message'), 300), ...(firstFrame(stack) ? { frame: firstFrame(stack) } : {}), at: iso() }, MAX.errors)
}

/** Starts keeping the trail. Idempotent: every screen of the module calls it on mount, and it installs once. */
export function installContextListeners(): void {
  if (undo || typeof window === 'undefined' || typeof document === 'undefined') return
  installedAt = Date.now()
  recordRoute()
  const onClick = (e: Event) => { const l = labelOf(e.target); if (l) push(trail.taps, { label: l, at: iso() }, MAX.taps) }
  const onError = (e: Event) => { const ev = e as ErrorEvent; recordError(ev.message || messageOf(ev.error), (ev.error as { stack?: unknown } | undefined)?.stack) }
  const onRejection = (e: Event) => { const reason = (e as PromiseRejectionEvent).reason; recordError(`Unhandled rejection: ${messageOf(reason)}`, (reason as { stack?: unknown } | undefined)?.stack) }
  const onNav = () => recordRoute()
  document.addEventListener('click', onClick, true)
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  window.addEventListener('popstate', onNav)
  window.addEventListener('hashchange', onNav)
  const { pushState, replaceState } = history
  history.pushState = function (...a: Parameters<History['pushState']>) { const r = pushState.apply(this, a); recordRoute(); return r }
  history.replaceState = function (...a: Parameters<History['replaceState']>) { const r = replaceState.apply(this, a); recordRoute(); return r }
  const consoleError = console.error
  console.error = function (...args: unknown[]) {
    try { recordError(args.map(messageOf).filter(Boolean).join(' '), (args.find((a) => a instanceof Error) as Error | undefined)?.stack) } catch { /* the trail never breaks logging */ }
    return consoleError.apply(this, args as [])
  }
  undo = () => {
    document.removeEventListener('click', onClick, true)
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    window.removeEventListener('popstate', onNav)
    window.removeEventListener('hashchange', onNav)
    history.pushState = pushState; history.replaceState = replaceState; console.error = consoleError
  }
}

/** Stops keeping the trail and forgets it (tests, and a host that signs someone out). */
export function resetContext(): void {
  undo?.(); undo = null
  trail.routes.length = 0; trail.taps.length = 0; trail.errors.length = 0
}

/** A copy of the trail as it stands. */
export const contextTrail = (): Trail => ({ routes: trail.routes.map((r) => ({ ...r })), taps: trail.taps.map((t) => ({ ...t })), errors: trail.errors.map((e) => ({ ...e })) })

/** A user agent in plain words: "iPhone, iOS 18.1, Safari 18.1". */
export function parseUserAgent(ua: string): string {
  const v = (re: RegExp) => re.exec(ua)?.[1]?.replace(/_/g, '.')
  let device = 'Unknown device'; let os = ''
  if (/iPhone/.test(ua)) { device = 'iPhone'; os = `iOS ${v(/OS (\d+[_.]\d+)/) ?? ''}`.trim() }
  else if (/iPad/.test(ua)) { device = 'iPad'; os = `iPadOS ${v(/OS (\d+[_.]\d+)/) ?? ''}`.trim() }
  else if (/Android/.test(ua)) { device = /Mobile/.test(ua) ? 'Android phone' : 'Android tablet'; os = `Android ${v(/Android (\d+(?:\.\d+)?)/) ?? ''}`.trim() }
  else if (/Macintosh|Mac OS X/.test(ua)) { device = 'Mac'; os = 'macOS' }
  else if (/Windows/.test(ua)) { device = 'Windows PC'; os = 'Windows' }
  else if (/CrOS/.test(ua)) { device = 'Chromebook'; os = 'ChromeOS' }
  else if (/Linux/.test(ua)) { device = 'Linux computer'; os = 'Linux' }
  const browser =
    v(/Edg(?:A|iOS)?\/(\d+)/) ? `Edge ${v(/Edg(?:A|iOS)?\/(\d+)/)}`
      : v(/(?:Firefox|FxiOS)\/(\d+)/) ? `Firefox ${v(/(?:Firefox|FxiOS)\/(\d+)/)}`
      : v(/(?:Chrome|CriOS)\/(\d+)/) ? `Chrome ${v(/(?:Chrome|CriOS)\/(\d+)/)}`
      : /Safari/.test(ua) && v(/Version\/(\d+(?:\.\d+)?)/) ? `Safari ${v(/Version\/(\d+(?:\.\d+)?)/)}`
      : ''
  return [device, os, browser].filter(Boolean).join(', ')
}

/** The device in plain words from User-Agent Client Hints when the browser has them, else from the user agent. */
async function deviceWords(given?: string): Promise<string> {
  if (given) return parseUserAgent(given)
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { userAgentData?: { getHighEntropyValues?(h: string[]): Promise<Record<string, unknown>> } })
  const uad = nav?.userAgentData
  if (uad?.getHighEntropyValues) {
    try {
      const h = await Promise.race([uad.getHighEntropyValues(['platform', 'platformVersion', 'model', 'fullVersionList', 'mobile']), new Promise<null>((r) => setTimeout(() => r(null), 300))])
      if (h) {
        const brands = (h.fullVersionList as { brand: string; version: string }[] | undefined)?.filter((b) => !/Not.?A.?Brand|Chromium/i.test(b.brand)) ?? []
        const b = brands.find((x) => /Edge/.test(x.brand)) ?? brands[0]
        const platform = String(h.platform ?? '')
        const device = String(h.model ?? '') || (platform === 'macOS' ? 'Mac' : platform === 'Windows' ? 'Windows PC' : platform === 'Android' ? (h.mobile ? 'Android phone' : 'Android tablet') : platform || 'Unknown device')
        const os = [platform, String(h.platformVersion ?? '').split('.').slice(0, 2).join('.')].filter(Boolean).join(' ')
        return [device, os, b ? `${b.brand.replace('Google ', '').replace('Microsoft ', '')} ${b.version.split('.')[0]}` : ''].filter(Boolean).join(', ')
      }
    } catch { /* fall back to the user agent */ }
  }
  return parseUserAgent(nav?.userAgent ?? '')
}

const two = (n: number) => String(n).padStart(2, '0')
function timeWords(d: Date): string {
  const zone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return '' } })()
  const off = -d.getTimezoneOffset()
  const offset = `UTC${off >= 0 ? '+' : '-'}${two(Math.floor(Math.abs(off) / 60))}:${two(Math.abs(off) % 60)}`
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())} (${[zone, offset].filter(Boolean).join(', ')})`
}
const media = (q: string) => { try { return typeof matchMedia === 'function' && matchMedia(q).matches } catch { return false } }

export interface CollectOptions {
  identity?: Identity | null
  where?: { screen?: string; route?: string }
  about?: { app?: string; version?: string }
  /** The app's own items (the `context` adapter). */
  extra?: () => Promise<AppContextItem[]>
  /** Ask the browser for a precise location (shows its permission prompt). Off unless the app opts in. */
  precise?: boolean
  /** A user agent to read instead of the browser's (tests). */
  userAgent?: string
  now?: () => number
}

/** Everything the module knows that would help fix it, each item with why it is shared, and the trail. */
export async function collectContext(o: CollectOptions = {}): Promise<ReportContext> {
  const now = new Date(o.now?.() ?? Date.now())
  const items: ContextItem[] = []
  const add = (key: string, label: string, value: string | undefined | null, why: string) => { if (value) items.push({ key, label: clip(label, 80), value: clip(value, 500), why: clip(why, 200) }) }
  const who = o.identity as (Identity & { name?: string; username?: string }) | null | undefined
  add('account', 'Your name in the app', who?.name || who?.username, 'so whoever fixes it knows who to thank, and can look at your account if the problem is in it')
  add('time', 'Your local time', timeWords(now), 'so the fixer can line it up with what the app logged at that moment')
  const langs = typeof navigator === 'undefined' ? [] : (navigator.languages?.length ? [...navigator.languages] : navigator.language ? [navigator.language] : [])
  add('language', 'Your languages', langs.join(', '), 'some problems only happen in one language or date format')
  add('device', 'Your device', await deviceWords(o.userAgent), 'so the fixer can try it on the same kind of device and browser')
  if (typeof window !== 'undefined') {
    const s = typeof screen === 'undefined' ? null : screen
    add('screen', 'Screen and window', `${s ? `${s.width}x${s.height} screen, ` : ''}${window.innerWidth}x${window.innerHeight} window, ${window.devicePixelRatio || 1}x pixels`, 'how things are laid out depends on the size of the screen and window')
    const look = [media('(prefers-color-scheme: dark)') ? 'dark mode' : 'light mode', ...(media('(prefers-reduced-motion: reduce)') ? ['reduced motion'] : [])]
    add('appearance', 'Appearance', look.join(', '), 'some problems only show in dark mode or with animations turned down')
  }
  if (typeof navigator !== 'undefined') {
    const c = (navigator as Navigator & { connection?: { type?: string; effectiveType?: string } }).connection
    add('connection', 'Connection', [navigator.onLine === false ? 'offline' : 'online', c?.type, c?.effectiveType && `${c.effectiveType} speed`].filter(Boolean).join(', '), 'a slow or dropped connection explains many problems')
  }
  const since = installedAt || (typeof performance !== 'undefined' ? performance.timeOrigin : 0)
  if (since) {
    const min = Math.max(0, Math.round((now.getTime() - since) / 60_000))
    add('age', 'How long the page was open', min < 1 ? 'under a minute' : `${min} minute${min === 1 ? '' : 's'}`, 'some problems only start after a page has been open a while')
  }
  if (o.precise && typeof navigator !== 'undefined' && navigator.geolocation) {
    const pos = await new Promise<GeolocationPosition | null>((resolve) => {
      try { navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), { maximumAge: 600_000, timeout: 5000 }) } catch { resolve(null) }
    })
    if (pos) add('place', 'Where you were', `${pos.coords.latitude.toFixed(3)}, ${pos.coords.longitude.toFixed(3)}`, 'this app asked for it, because some problems only happen in one place')
  }
  if (o.extra) {
    try {
      const got = await o.extra()
      ;(Array.isArray(got) ? got : []).forEach((x) => {
        // An app item that does not say why it is shared is not shared.
        if (x && typeof x.label === 'string' && typeof x.value === 'string' && typeof x.why === 'string' && x.why.trim()) add(`app:${items.filter((i) => i.key.startsWith('app:')).length}`, x.label, x.value, x.why)
      })
    } catch { /* the app's own context failing never blocks a suggestion */ }
  }
  return { items: items.slice(0, MAX.items), ...contextTrail() }
}
