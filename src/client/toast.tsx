'use client'
// TOASTS: the one place the module says what is happening without moving anything on the page. At most
// two at once, each goes by itself after a few seconds or on a tap. `<Toasts />` is an aria-live region.
import { useEffect, useState } from 'react'

export type Tone = 'info' | 'warn'
export interface ToastInput { text: string; tone?: Tone; ms?: number; id?: string }
export interface Toast { id: string; text: string; tone: Tone; ms: number }

export const MAX_TOASTS = 2
export const TOAST_MS = 4000
let seq = 0
let shown: Toast[] = []
const listeners = new Set<(t: Toast[]) => void>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const tell = () => { for (const l of listeners) l(shown) }

export function dismiss(id: string) {
  const t = timers.get(id)
  if (t) clearTimeout(t)
  timers.delete(id)
  if (!shown.some((x) => x.id === id)) return
  shown = shown.filter((x) => x.id !== id)
  tell()
}

/** Shows one toast. The same `id` replaces the one showing. */
export function toast(input: ToastInput | string): string {
  const i = typeof input === 'string' ? { text: input } : input
  const t: Toast = { id: i.id ?? `t${++seq}`, text: i.text, tone: i.tone ?? 'info', ms: i.ms ?? TOAST_MS }
  const old = timers.get(t.id)
  if (old) clearTimeout(old)
  shown = [...shown.filter((x) => x.id !== t.id), t]
  while (shown.length > MAX_TOASTS) { const gone = shown.shift()!; const g = timers.get(gone.id); if (g) clearTimeout(g); timers.delete(gone.id) }
  timers.set(t.id, setTimeout(() => dismiss(t.id), t.ms))
  tell()
  return t.id
}

export function clearToasts() { for (const t of timers.values()) clearTimeout(t); timers.clear(); shown = []; tell() }

// Several screens may mount a host at once (the sheet over the list); only the first mounted draws, so a
// toast is announced once.
const hosts: number[] = []
const hostListeners = new Set<() => void>()
let hostSeq = 0

export function Toasts() {
  const [list, setList] = useState<Toast[]>(shown)
  const [id] = useState(() => ++hostSeq)
  const [primary, setPrimary] = useState(false)
  useEffect(() => {
    hosts.push(id)
    const sync = () => setPrimary(hosts[0] === id)
    hostListeners.add(sync)
    for (const l of hostListeners) l()
    listeners.add(setList); setList(shown)
    return () => {
      listeners.delete(setList); hostListeners.delete(sync)
      hosts.splice(hosts.indexOf(id), 1)
      for (const l of hostListeners) l()
    }
  }, [id])
  if (!primary) return null
  return (
    <div className="sac-toasts" data-sac-toasts="" role="status" aria-live="polite" aria-atomic="false">
      {list.map((t) => (
        <button key={t.id} type="button" className="sac-toast" data-tone={t.tone} onClick={() => dismiss(t.id)}>{t.text}</button>
      ))}
    </div>
  )
}
