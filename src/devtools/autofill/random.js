// Tiny injectable random source for the autofill generators. Production passes Math.random (every click gives a
// different result); tests pass a seeded generator so their output is deterministic.

// mulberry32: small, fast, seedable
export function seededRandom(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// `random` is any () => number in [0, 1)
export function createRng(random = Math.random) {
  const int = (min, max) => min + Math.floor(random() * (max - min + 1)) // inclusive
  const pick = (list) => list[Math.floor(random() * list.length)]
  const chance = (p) => random() < p
  // n distinct items, in random order (never more than the list has)
  const sample = (list, n) => {
    const pool = [...list]
    const out = []
    while (out.length < n && pool.length > 0) out.push(pool.splice(Math.floor(random() * pool.length), 1)[0])
    return out
  }
  return { int, pick, chance, sample }
}
