// The door helpers an app's own route wrappers share with the handlers: the module's answers for "who are you"
// and "no such report", a body read that stops at a cap, and a peek at one field. A wrapper that answered these
// in its own words, or read a body past the cap, would be a second door with different rules.
import { describe, expect, it } from 'vitest'
import { json, signIn, notFound, cappedText, peek } from '../../src/server/index.ts'

const stream = (parts: string[], declared?: number) => new Request('https://app.test/x', {
  method: 'POST',
  headers: declared === undefined ? {} : { 'content-length': String(declared) },
  body: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close() } }),
  duplex: 'half',
} as RequestInit)

describe('the door helpers', () => {
  it('json answers JSON that is never cached', async () => {
    const r = json(418, { a: 1 })
    expect(r.status).toBe(418)
    expect(r.headers.get('content-type')).toBe('application/json')
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(await r.json()).toEqual({ a: 1 })
  })

  it('signIn and notFound are the handlers\' own answers', async () => {
    expect(signIn().status).toBe(401)
    expect(await signIn().json()).toEqual({ error: 'sign in first' })
    expect(notFound().status).toBe(404)
    expect(await notFound().json()).toEqual({ error: 'not found' })
  })

  it('cappedText reads a body under the cap, and a request with no body as empty', async () => {
    expect(await cappedText(stream(['{"a":', '1}']), 100)).toBe('{"a":1}')
    expect(await cappedText(new Request('https://app.test/x'), 100)).toBe('')
  })

  it('cappedText refuses past the cap by the declared length, before reading anything', async () => {
    const big = await cappedText(new Request('https://app.test/x', { method: 'POST', headers: { 'content-length': '11' }, body: 'x' }), 10)
    expect(big).toBeInstanceOf(Response)
    expect((big as Response).status).toBe(413)
    expect(await (big as Response).json()).toEqual({ error: 'too large' })
  })

  it('cappedText refuses past the cap by counting what arrives, whatever the header said', async () => {
    const r = await cappedText(stream(['12345', '67890', 'X']), 10)
    expect(r).toBeInstanceOf(Response)
    expect((r as Response).status).toBe(413)
    expect(await cappedText(stream(['12345', '67890']), 10)).toBe('1234567890')
  })

  it('peek gives a JSON object, or an empty one for anything else', () => {
    expect(peek('{"kind":"bug"}')).toEqual({ kind: 'bug' })
    for (const t of ['', 'nope', '[1]', '3', 'null', '"s"']) expect(peek(t)).toEqual({})
  })
})
