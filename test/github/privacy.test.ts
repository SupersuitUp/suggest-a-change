// THE PRIVACY CATCH (suggestions-as-github-issues design, section 5). Nothing is filed until it has run.
import { describe, expect, it } from 'vitest'
import { mayFileAsIs, privacyCatch, redact } from '../../src/github/index.ts'

const report = (words: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'r-20261026170412-ab12cd', kind: 'change', words, who: { member: 'amy', role: 'member' }, ...over })
const kinds = (r: ReturnType<typeof privacyCatch>) => r.hits.map((h) => h.kind)

describe('privacyCatch', () => {
  it('finds every credential shape the design names', () => {
    const shapes = [
      'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
      'gho_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2',
      'github_pat_' + '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH',
      'sk-' + 'proj-abcDEF123456ghiJKL789012mnoPQR345678',
      'sk-ant-' + 'api03-abcdefghijklmnopqrstuvwxyz0123456789-ABCDEF',
      'AKIA' + 'IOSFODNN7EXAMPLE',
      'AIza' + 'SyA-1234567890abcdefghijklmnopqrstu',
      'xoxb-' + '123456789012-1234567890123-abcdefghijklmnop',
      '-----BEGIN RSA PRIVATE KEY-----',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
    ]
    for (const s of shapes) {
      const got = privacyCatch(report(`here it is ${s} thanks`))
      expect(kinds(got), s).toContain('credential')
      expect(got.hits.find((h) => h.kind === 'credential')!.field).toBe('words')
    }
  })

  it('finds a long random value after key=, token= or secret=, and leaves ordinary words alone', () => {
    expect(kinds(privacyCatch(report('the env has token=9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a set')))).toEqual(['credential'])
    expect(kinds(privacyCatch(report('secret: Qm9vbXNoYWthbGFrYTEyMzQ1Njc4OTBhYmNkZWZn')))).toEqual(['credential'])
    expect(kinds(privacyCatch(report('the key=aaaaaaaaaaaaaaaaaaaaaaaaaaaa is fake')))).toEqual([]) // no entropy
    expect(privacyCatch(report('make the photos bigger and the key button blue')).hits).toEqual([])
  })

  it('finds a secret the app gives it (the sender\'s own key), and never a short one that is only a name', () => {
    const key = 'mk_7Hq2xP9vL3sT8wK1'
    expect(kinds(privacyCatch(report(`my key is ${key}`), { secrets: [key] }))).toEqual(['credential'])
    expect(privacyCatch(report('amy likes it'), { secrets: ['amy'] }).hits).toEqual([])
  })

  it('finds emails and phone numbers', () => {
    expect(kinds(privacyCatch(report('write to sam.jones@example.com please')))).toEqual(['email'])
    expect(kinds(privacyCatch(report('call me at (917) 679-0317 tonight')))).toEqual(['phone'])
    expect(kinds(privacyCatch(report('or +442071838750')))).toEqual(['phone'])
    expect(privacyCatch(report('version 2.14.0 on a 390x844 screen, 2026-10-26')).hits).toEqual([])
  })

  it('finds a third party by full name or a registered alias of two words or more, as whole words', () => {
    const people = [{ name: 'Dana Whitlock', aliases: ['Danny W', 'RR'] }, { name: 'Morgan Vale', aliases: [] }]
    expect(privacyCatch(report('ask dana whitlock about it'), { people }).hits).toEqual([{ kind: 'person', text: 'dana whitlock', field: 'words' }])
    expect(kinds(privacyCatch(report('Danny W said so'), { people }))).toEqual(['person'])
    expect(privacyCatch(report('RR is a single word alias'), { people }).hits).toEqual([])
    expect(privacyCatch(report('Morgan Vales is not him'), { people }).hits).toEqual([])
  })

  it('reads the transcript and the follow-ups too, naming the field', () => {
    const r = report('nothing here', { transcript: 'my email is a@b.co', followUps: [{ words: 'ok' }, { words: 'call (917) 679-0317' }] })
    expect(privacyCatch(r).hits.map((h) => [h.kind, h.field])).toEqual([['email', 'transcript'], ['phone', 'followUps.1.words']])
  })
})

describe('the sender\'s own contact, and the context', () => {
  it('never flags the sender\'s own email or phone, and still flags anyone else\'s', () => {
    const r = report('mail me at pat@example.com or call +1 917 555 0100; or ask sam@example.com', { who: { member: 'amy', role: 'member', contact: { email: 'pat@example.com', phone: '+1 917 555 0100' } } })
    expect(privacyCatch(r).hits).toEqual([{ kind: 'email', text: 'sam@example.com', field: 'words' }])
  })

  it('reads the context too: the app\'s items, the taps and the errors, and redacts there', () => {
    const key = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
    const r = report('fine', { context: { items: [{ key: 'app:0', label: 'Team', value: 'ask dana whitlock', why: 'x' }], taps: [{ label: 'Call (917) 679-0317', at: 'x' }], errors: [{ message: `401 with ${key}`, at: 'x' }] } })
    const { hits } = privacyCatch(r, { people: [{ name: 'Dana Whitlock' }] })
    expect(hits.map((h) => [h.kind, h.field])).toEqual([['person', 'context.items.0.value'], ['phone', 'context.taps.0.label'], ['credential', 'context.errors.0.message']])
    const out = redact(r, hits) as { context: { items: { value: string }[]; taps: { label: string }[]; errors: { message: string }[] } }
    expect(out.context.items[0].value).toBe('ask [removed]')
    expect(out.context.taps[0].label).toBe('Call [removed]')
    expect(out.context.errors[0].message).toBe('401 with [removed]')
  })
})

describe('every string that reaches the issue, normalized first', () => {
  it('sees through zero-width characters and look-alike letters', () => {
    const split = 'gh​p_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
    expect(kinds(privacyCatch(report(`token ${split}`)))).toEqual(['credential'])
    expect(kinds(privacyCatch(report('ｓａｍ＠ｅｘａｍｐｌｅ．ｃｏｍ')))).toEqual(['email']) // fullwidth letters
    expect(kinds(privacyCatch(report('ask Dana‍ Whitlock'), { people: [{ name: 'Dana Whitlock' }] }))).toEqual(['person'])
  })

  it('reads where, every diagnostic, every part of a context item, the names given, and the contact handle', () => {
    const key = 'AKIA' + 'IOSFODNN7EXAMPLE'
    const r = report('fine', {
      where: { screen: 'Inbox of sam@example.com', route: '/u/sam@example.com' },
      diagnostics: { device: `iPhone ${key}` },
      context: { items: [{ key: 'app:0', label: 'Owner Dana Whitlock', value: 'v', why: 'call (917) 679-0317' }] },
      filerName: 'Pat', appName: `App ${key}`,
      who: { member: 'amy', role: 'member', contact: { handle: `@pat ${key}` } },
    })
    const fields = privacyCatch(r, { people: [{ name: 'Dana Whitlock' }] }).hits.map((h) => `${h.kind}:${h.field}`)
    expect(fields).toEqual(expect.arrayContaining(['email:where.screen', 'email:where.route', 'credential:diagnostics.device', 'person:context.items.0.label', 'phone:context.items.0.why', 'credential:appName', 'credential:who.contact.handle']))
    const out = redact(r, privacyCatch(r, { people: [{ name: 'Dana Whitlock' }] }).hits) as Record<string, any>
    expect(out.where.screen).toBe('Inbox of [removed]')
    expect(out.diagnostics.device).toBe('iPhone [removed]')
    expect(out.context.items[0].label).toBe('Owner [removed]')
    expect(out.appName).toBe('App [removed]')
  })
})

describe('redact and mayFileAsIs', () => {
  it('replaces each hit with [removed], in its own field, everywhere it appears', () => {
    const r = report('mail a@b.co or a@b.co', { transcript: 'token=9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a', followUps: [{ words: 'a@b.co' }] })
    const hits = privacyCatch(r).hits
    const out = redact(r, hits)
    expect(out.words).toBe('mail [removed] or [removed]')
    expect(out.transcript).toBe('token=[removed]')
    expect((out.followUps as { words: string }[])[0].words).toBe('[removed]')
    expect(r.words).toBe('mail a@b.co or a@b.co') // the original is untouched
  })

  it('a credential can never be filed as it is; anything else may be, on the owner\'s tap', () => {
    expect(mayFileAsIs(privacyCatch(report('a@b.co')).hits)).toBe(true)
    expect(mayFileAsIs(privacyCatch(report('AKIAIOSFODNN7EXAMPLE')).hits)).toBe(false)
    expect(mayFileAsIs([])).toBe(true)
  })
})
