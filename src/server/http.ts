// The door, in the module's own words: the answers the handlers give for "who are you" and "no such report", a body
// read that stops at a cap, and a peek at one field. Exported so an app's own route wrapper (one that has to check a
// caller, or read a field, before the module sees the request) answers exactly as the module does and never reads a
// body past the cap. Web-standard APIs only.

/** A JSON response that is never cached. */
export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
/** 401, the module's answer to a caller it does not know. */
export const signIn = (): Response => json(401, { error: 'sign in first' })
/** 404, the module's answer to a report that is gone or not the caller's (the two are never told apart). */
export const notFound = (): Response => json(404, { error: 'not found' })

/** The body as text, or a 413 once it passes `cap` bytes: by its declared length, and again by counting what arrives. A request with no body reads as ''. */
export async function cappedText(req: Request, cap: number): Promise<string | Response> {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > cap) return json(413, { error: 'too large' })
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > cap) { await reader.cancel().catch(() => {}); return json(413, { error: 'too large' }) }
    chunks.push(value)
  }
  const all = new Uint8Array(n)
  let o = 0
  for (const c of chunks) { all.set(c, o); o += c.byteLength }
  return new TextDecoder().decode(all)
}

/** A JSON object out of text, or an empty one: the module judges the body itself; a wrapper only peeks at a field. */
export function peek(text: string): Record<string, unknown> {
  try { const v = JSON.parse(text) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {} } catch { return {} }
}
