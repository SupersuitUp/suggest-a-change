// WHAT A FILE REALLY IS. A name and a declared type are the sender's words; the first bytes are the file's.
// `sniffType` reads them and answers one canonical type, or null for anything the module does not accept.
// The canonical answers (and nothing else) are the types an upload may be declared as; `sameType` is the
// one place that says which declared types a sniffed type satisfies.
import { canonicalType } from '../contract.mjs'

const at = (b: Uint8Array, i: number, s: string): boolean => {
  if (b.length < i + s.length) return false
  for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) return false
  return true
}
const ascii = (b: Uint8Array, from: number, to: number): string => String.fromCharCode(...b.subarray(from, to))

export { ACCEPTED_TYPES, canonicalType } from '../contract.mjs'

function brandType(brand: string): string | null {
  if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'image/heic'
  if (['mif1', 'msf1', 'heim', 'heis'].includes(brand)) return 'image/heif'
  if (brand === 'qt  ') return 'video/quicktime'
  if (brand === 'M4A ' || brand === 'M4B ') return 'audio/mp4'
  if (brand === 'M4V ' || /^(isom|iso[2-9]|mp4[12]|avc1|dash|MSNV|mmp4|f4v |XAVC|3gp.|3g2.)$/.test(brand)) return 'video/mp4'
  return null
}

export function sniffType(firstBytes: Uint8Array): string | null {
  const b = firstBytes
  if (b.length < 3) return null
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b[0] === 0x89 && at(b, 1, 'PNG') && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png'
  if (at(b, 0, 'GIF87a') || at(b, 0, 'GIF89a')) return 'image/gif'
  if (at(b, 0, 'RIFF') && at(b, 8, 'WEBP')) return 'image/webp'
  if (at(b, 0, 'RIFF') && at(b, 8, 'WAVE')) return 'audio/wav'
  if (at(b, 0, 'OggS')) return 'audio/ogg'
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm'
  if (at(b, 4, 'ftyp') && b.length >= 12) {
    // The major brand decides; when it is one we do not know, a compatible brand listed after it may.
    const size = Math.min(b.length, ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0 || b.length)
    for (let at8 = 8; at8 + 4 <= size; at8 += at8 === 8 ? 8 : 4) if (['avif', 'avis'].includes(ascii(b, at8, at8 + 4))) return null // AVIF shares HEIF's brands and is not accepted
    for (let at8 = 8; at8 + 4 <= size; at8 += at8 === 8 ? 8 : 4) {
      const t = brandType(ascii(b, at8, at8 + 4))
      if (t) return t
    }
    return null
  }
  // An ID3 tag is only a tag if its version, flags and syncsafe size are sane; the bare letters are not enough.
  if (at(b, 0, 'ID3') && b.length >= 10 && b[3] >= 2 && b[3] <= 4 && b[4] !== 0xff && b[6] < 0x80 && b[7] < 0x80 && b[8] < 0x80 && b[9] < 0x80) return 'audio/mpeg'
  if (b.length >= 4 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) {
    if ((b[1] & 0xf6) === 0xf0) return 'audio/aac' // ADTS: layer bits 00
    const version = (b[1] >> 3) & 3
    const layer = (b[1] >> 1) & 3
    const bitrate = b[2] >> 4
    const rate = (b[2] >> 2) & 3
    if (version !== 1 && layer !== 0 && bitrate !== 0 && bitrate !== 15 && rate !== 3) return 'audio/mpeg'
  }
  return null
}

/** True when what the bytes are satisfies what was declared. A recorder's audio often lives in a video
 *  container (webm, mp4), which bytes alone cannot tell apart, so those pairs agree. */
export function sameType(declared: unknown, sniffed: string | null): boolean {
  if (!sniffed) return false
  const d = canonicalType(declared)
  if (d === sniffed) return true
  if (d === 'audio/webm' && sniffed === 'video/webm') return true
  if (d === 'audio/mp4' && sniffed === 'video/mp4') return true
  if ((d === 'image/heic' && sniffed === 'image/heif') || (d === 'image/heif' && sniffed === 'image/heic')) return true
  return false
}
