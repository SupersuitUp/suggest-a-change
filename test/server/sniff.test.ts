import { describe, expect, it } from 'vitest'
import { sameType, sniffType } from '../../src/server/index.ts'

const bytes = (...a: (number | string)[]) => Uint8Array.from(a.flatMap((x) => (typeof x === 'string' ? [...x].map((c) => c.charCodeAt(0)) : [x])))
const ftyp = (brand: string) => bytes(0, 0, 0, 24, 'ftyp', brand, 0, 0, 0, 0)

describe('sniffType', () => {
  const cases: [string, Uint8Array, string][] = [
    ['jpeg', bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16), 'image/jpeg'],
    ['png', bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0), 'image/png'],
    ['webp', bytes('RIFF', 1, 2, 3, 4, 'WEBPVP8 '), 'image/webp'],
    ['heic', ftyp('heic'), 'image/heic'],
    ['heif', ftyp('mif1'), 'image/heif'],
    ['gif', bytes('GIF89a', 1, 0, 1, 0), 'image/gif'],
    ['mp4', ftyp('isom'), 'video/mp4'],
    ['mp4 (mp42)', ftyp('mp42'), 'video/mp4'],
    ['mov', ftyp('qt  '), 'video/quicktime'],
    ['webm', bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42), 'video/webm'],
    ['m4a', ftyp('M4A '), 'audio/mp4'],
    ['aac (adts)', bytes(0xff, 0xf1, 0x50, 0x80, 0, 0), 'audio/aac'],
    ['mp3 (id3)', bytes('ID3', 4, 0, 0, 0, 0, 0, 0), 'audio/mpeg'],
    ['mp3 (frame)', bytes(0xff, 0xfb, 0x90, 0x64, 0, 0), 'audio/mpeg'],
    ['wav', bytes('RIFF', 1, 2, 3, 4, 'WAVEfmt '), 'audio/wav'],
    ['ogg/opus', bytes('OggS', 0, 2, 0, 0, 0, 0, 0, 0, 0, 0), 'audio/ogg'],
  ]
  for (const [name, b, want] of cases) it(`recognises ${name}`, () => expect(sniffType(b)).toBe(want))
  it('answers null for anything else', () => {
    for (const b of [bytes(), bytes('MZ'), bytes('<html><script>'), bytes('%PDF-1.7'), bytes('PK', 3, 4, 0, 0), ftyp('avif'), bytes(0xff, 0xff, 0xff, 0xff), new Uint8Array(64)]) expect(sniffType(b)).toBeNull()
  })
  it('sameType lets a recorder\'s audio live in a video container and nothing else cross over', () => {
    expect(sameType('audio/webm;codecs=opus', 'video/webm')).toBe(true)
    expect(sameType('audio/mp4', 'video/mp4')).toBe(true)
    expect(sameType('image/jpeg', 'image/png')).toBe(false)
    expect(sameType('video/mp4', 'audio/mp4')).toBe(false)
    expect(sameType('image/png', null)).toBe(false)
  })
})
