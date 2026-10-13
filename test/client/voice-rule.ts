// The Helm's rule `textFieldsWithoutVoice` (helm2 src/golden/check.ts), re-implemented for this module's
// tests: every text field sits in a [data-voice-field] container that holds a [data-voice-control] and
// exactly that one field, so a bare input placed beside a voice field is still reported.
const TEXT = 'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"]'
export function textFieldsWithoutVoice(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TEXT)].filter((el) => {
    const box = el.closest('[data-voice-field]')
    return !(box && box.querySelector('[data-voice-control]') && box.querySelectorAll(TEXT).length === 1)
  })
}
