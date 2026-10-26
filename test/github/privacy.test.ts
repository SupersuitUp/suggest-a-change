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
