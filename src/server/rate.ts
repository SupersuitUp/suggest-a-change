import { CEILINGS } from '../contract.mjs'

export type Limits = Partial<typeof CEILINGS>

/** The ceilings in force: the module's, lowered by the app's. An app that tries to raise one is refused
 *  when the handlers are made, not on the first request that would have exceeded it. */
export function effectiveLimits(limits: Limits | undefined): typeof CEILINGS {
  const out = { ...CEILINGS }
  for (const [k, v] of Object.entries(limits ?? {})) {
    const key = k as keyof typeof CEILINGS
    if (!(key in CEILINGS)) throw new Error(`limits.${k} is not a ceiling the module has`)
    if (typeof v !== 'number' || !(v > 0)) throw new Error(`limits.${k} must be a positive number`)
    if (v > CEILINGS[key]) throw new Error(`limits.${k} ${v} is above the module's ${CEILINGS[key]}; an app may lower a ceiling, never raise it`)
    out[key] = v
  }
  return out
}
