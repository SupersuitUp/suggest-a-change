// The suite has teeth: each deliberately unsafe adapter must fail it, on the rule it breaks.
import { describe, expect, it } from 'vitest'
import { conformanceChecks } from '../../src/server/index.ts'
import { makeMemoryStore, type Flaw } from './memory-store.ts'

const failures = async (flaw?: Flaw): Promise<string[]> => {
  const out: string[] = []
  for (const c of conformanceChecks) { try { await c.run(makeMemoryStore(undefined, flaw)) } catch { out.push(c.name) } }
  return out
}

const CASES: [Flaw, RegExp][] = [
  ['reusable-links', /one-time/],
  ['unconditioned-links', /one-time/],
  ['drops-files', /survive a round trip/],
  ['drops-followups', /survive a round trip/],
  ['counts-every-put', /counts reports, not puts/],
  ['stale-write', /stale write/],
  ['stale-claim', /stale write|first-wins/],
  ['non-atomic-create', /atomic/],
  ['long-read-link', /read link stops/],
  ['discard-leaves-object', /discard removes/],
  ['finalize-throws-when-missing', /says null/],
]

describe('the conformance suite fails unsafe adapters', () => {
  it('passes the safe one', async () => expect(await failures()).toEqual([]))
  for (const [flaw, rule] of CASES) {
    it(`fails an adapter with ${flaw}`, async () => {
      const failed = await failures(flaw)
      expect(failed.length, `${flaw} passed the whole suite`).toBeGreaterThan(0)
      expect(failed.some((n) => rule.test(n)), `${flaw} failed ${JSON.stringify(failed)}, not on ${rule}`).toBe(true)
    })
  }
})
