// A labelled dialog's behaviour: focus goes in when it opens, Tab stays inside it, Escape closes it,
// and focus goes back to what had it when it closes.
import { useEffect, type RefObject } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function useDialog(ref: RefObject<HTMLElement | null>, onClose?: () => void) {
  useEffect(() => {
    const box = ref.current
    if (!box) return
    const before = document.activeElement as HTMLElement | null
    const items = () => [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute('hidden'))
    ;(items()[0] ?? box).focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && onClose) { e.stopPropagation(); onClose(); return }
      if (e.key !== 'Tab') return
      const list = items()
      if (!list.length) { e.preventDefault(); box!.focus(); return }
      const first = list[0]
      const last = list[list.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || !box!.contains(active))) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && (active === last || !box!.contains(active))) { e.preventDefault(); first.focus() }
    }
    box.addEventListener('keydown', onKey)
    return () => { box.removeEventListener('keydown', onKey); if (before && document.contains(before)) before.focus() }
    // The dialog opens once per mount; onClose is read through the closure it was given.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
