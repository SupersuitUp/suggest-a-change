// The receiving side's answer to GET /api/reports/:id is read by the client's detail view. This feeds the
// server's real answer through the view's step reader, so the two cannot drift.
import { describe, expect, it } from 'vitest'
import { stepOf, statusOf } from '../../src/client/detail.tsx'
import { createReportHandlers } from '../../src/server/index.ts'
import { makeMemoryStore } from '../server/memory-store.ts'

describe('client and server agree on a report\'s step', () => {
  it('the step the Mac set is the step the detail view reads from the server\'s own answer', async () => {
    const mem = makeMemoryStore()
    const h = createReportHandlers({ store: mem.store, identity: async (r) => (r.headers.get('x-user') ? { account: r.headers.get('x-user')! } : null), agent: async (r) => r.headers.get('x-agent'), maintainers: ['mo'], now: () => mem.now(), tellSubmitter: { none: 'this test tells nobody' } })
    const req = (method: string, who: Record<string, string>, body?: unknown) => new Request('https://app.test/x', { method, headers: who, ...(body ? { body: JSON.stringify(body) } : {}) })
    const id = 'r-20261012090000-abcdef'
    expect((await h.submit(req('POST', { 'x-user': 'amy' }, { id, kind: 'change', words: 'w', media: [], voice: [], where: {}, diagnostics: {} }))).status).toBe(200)
    for (const status of ['with-freeda', 'planned', 'waiting-on-owner']) await h.agentStatus(req('POST', { 'x-agent': 'mo' }, { status }), id)
    expect((await h.agentStatus(req('POST', { 'x-agent': 'mo' }, { status: 'being-made', step: 'Testing the change' }), id)).status).toBe(200)
    const answer = (await (await h.one(req('GET', { 'x-user': 'amy' }), id)).json()) as Record<string, unknown>
    expect(statusOf(answer)).toBe('being-made')
    expect(stepOf(answer)).toBe('Testing the change')
    // a later status without a step shows no stale step
    await h.agentStatus(req('POST', { 'x-agent': 'mo' }, { status: 'live' }), id)
    expect(stepOf((await (await h.one(req('GET', { 'x-user': 'amy' }), id)).json()) as Record<string, unknown>)).toBeUndefined()
  })
})
