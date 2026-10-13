// AN OP ID THE MAC ALWAYS TAKES. The receiving side answers a write or a take exactly once by its op id,
// and refuses any id outside ^[\w-]{2,80}$ . An id built from data (a project
// slug with a dot in it, a long judgment id) can fall outside that, and then every retry is refused
// and the write never lands. opId builds the id from its parts deterministically, so the same write
// made twice (a remount, a replay) still gets the same id: the plain joined parts when they already
// fit, else a sanitized, truncated form with a stable hash of the original on the end.
const OP = /^[\w-]{2,80}$/

/** FNV-1a, 32 bits, from a seed: two of these make a stable 64-bit fingerprint with no dependencies. */
function fnv(s: string, seed: number): number {
  let h = seed >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}
export const stableHash = (s: string) => fnv(s, 0x811c9dc5).toString(36) + fnv(s, 0x9747b28c).toString(36)

export function opId(...parts: string[]): string {
  const plain = parts.join('-')
  if (OP.test(plain)) return plain
  const clean = plain.replace(/[^\w-]+/g, '_').slice(0, 60)
  return `${clean}-${stableHash(plain)}`
}

/** One take's own id inside a write: the write's id plus the take's key, so two takes into one note
 *  are two receipts, and a replay of one take (its reply was lost) is still answered once. */
export const takeOpId = (writeId: string, takeKey: string) => opId(writeId, takeKey)
