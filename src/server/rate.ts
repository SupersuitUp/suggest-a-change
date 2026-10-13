import { CEILINGS } from '../contract.mjs'

/** Ceilings the app may lower: the contract's, plus the server's own counts. Never raised. */
export const SERVER_LIMITS = {
  /** Voice notes in one report, and in one follow-up. */
  voiceNotes: 10,
  followUpVoiceNotes: 5,
  /** Follow-ups added to one report. */
  followUps: 10,
  /** Reports handed to a Mac in one pickup. */
  agentPage: 20,
}
export type Limits = Partial<typeof CEILINGS & typeof SERVER_LIMITS>
export type EffectiveLimits = typeof CEILINGS & typeof SERVER_LIMITS

const ALL: Record<string, number> = { ...CEILINGS, ...SERVER_LIMITS }

/** The limits in force: the module's, lowered by the app's. An app that tries to raise one is refused
 *  when the handlers are made, not on the first request that would have exceeded it. */
export function effectiveLimits(limits: Limits | undefined): EffectiveLimits {
  const out: Record<string, number> = { ...ALL }
  for (const [k, v] of Object.entries(limits ?? {})) {
    if (!(k in ALL)) throw new Error(`limits.${k} is not a limit the module has`)
    if (typeof v !== 'number' || !(v > 0)) throw new Error(`limits.${k} must be a positive number`)
    if (v > ALL[k]) throw new Error(`limits.${k} ${v} is above the module's ${ALL[k]}; an app may lower a limit, never raise it`)
    out[k] = v
  }
  return out as EffectiveLimits
}
