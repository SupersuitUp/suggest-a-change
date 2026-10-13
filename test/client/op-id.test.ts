// An op id built from data must always be one the receiving side takes (^[\w-]{2,80}$), or every retry
// of that write is refused and it never lands; and it must be the same every time it is built, or a
// remount's re-tap becomes a second write. 
import { expect, it } from 'vitest'
import { opId, takeOpId } from '../../src/client/op-id.ts'

const OP = /^[\w-]{2,80}$/
const dotted = ('v2.launch.' + 'x'.repeat(200)).slice(0, 120)
const longJudgment = '20261010-120000-' + 'a-very-long-judgment-slug-'.repeat(6) + 'ab12'

it('an id that already fits is left exactly as it was, so writes queued by an older build keep their id', () => {
  expect(opId('press', 'p-one', '2026-10-10')).toBe('press-p-one-2026-10-10')
  expect(opId('answer', '20261010-120000-recommendation-ab12')).toBe('answer-20261010-120000-recommendation-ab12')
  expect(takeOpId('n-abc-123', 'take-xyz-456')).toBe('n-abc-123-take-xyz-456')
})

it('a dotted 120-character slug and a long judgment id still make ids the receiver takes, the same every time', () => {
  for (const id of [opId('press', dotted, '2026-10-10'), opId('answer', longJudgment), takeOpId('n-1', 'k.'.repeat(60))]) expect(id).toMatch(OP)
  expect(opId('press', dotted, '2026-10-10')).toBe(opId('press', dotted, '2026-10-10'))
  expect(opId('answer', longJudgment)).toBe(opId('answer', longJudgment))
})

it('different data never shares an id: another day, another slug, or a slug differing only past the cut', () => {
  const ids = [opId('press', dotted, '2026-10-10'), opId('press', dotted, '2026-10-11'), opId('press', dotted.slice(0, 119) + 'y', '2026-10-10'), opId('press', dotted.replaceAll('.', '_'), '2026-10-10')]
  expect(new Set(ids).size).toBe(ids.length)
})
