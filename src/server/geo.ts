// ROUGHLY WHERE THE SENDER WAS, from the request the receiver got, never from a browser prompt. The receiver (the
// server handlers, or a suggestion relay) adds it as one context item; a place the phone claims is dropped. Hosts put
// it in headers already, so a geo hook is one line:
//
//   Vercel:     (req) => ({ city: decodeURIComponent(req.headers.get("x-vercel-ip-city") ?? ""), region: req.headers.get("x-vercel-ip-country-region") ?? "", country: req.headers.get("x-vercel-ip-country") ?? "" })
//   Cloudflare: (req) => ({ city: req.headers.get("cf-ipcity") ?? "", region: req.headers.get("cf-region") ?? "", country: req.headers.get("cf-ipcountry") ?? "" })
//               (cf-ipcity and cf-region need Cloudflare's "Add visitor location headers" managed transform; cf-ipcountry is always there)

export type Geo = { city?: string; region?: string; country?: string }
export type GeoHook = (req: Request) => Geo | null | undefined | Promise<Geo | null | undefined>
export const PLACE_LABEL = 'Roughly where they were'
export const PLACE_WHY = 'from their internet connection, never their exact location; some problems only happen in one region'

/** The context item for a place from the request, or null when there is nothing to say. */
export function placeItem(g: Geo | null | undefined): { key: string; label: string; value: string; why: string } | null {
  if (!g) return null
  const value = [g.city, g.region, g.country].map((x) => (typeof x === 'string' ? x.trim().slice(0, 100) : '')).filter(Boolean).join(', ')
  return value ? { key: 'place', label: PLACE_LABEL, value, why: PLACE_WHY } : null
}

/** The context with the phone's own `place` dropped and the receiver's added; unchanged when there is neither. */
export async function withPlace(ctx: unknown, req: Request, geo: GeoHook | undefined): Promise<unknown> {
  const has = Boolean(ctx && typeof ctx === 'object' && !Array.isArray(ctx))
  const base: Record<string, unknown> = has ? { ...(ctx as Record<string, unknown>) } : {}
  const items = Array.isArray(base.items) ? (base.items as { key?: unknown }[]).filter((i) => i?.key !== 'place') : undefined
  let place: ReturnType<typeof placeItem> = null
  try { place = geo ? placeItem(await geo(req)) : null } catch { place = null }
  if (!has && !place) return ctx
  const next = [...(items ?? []), ...(place ? [place] : [])].slice(0, 40)
  if (next.length || items) base.items = next
  return base
}
