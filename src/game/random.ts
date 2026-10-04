/** A source of floats in [0, 1). Every game-rule random decision takes one. */
export type RandomSource = () => number;

const UINT32 = 4294967296;

/** mulberry32: small, fast and identical on every JS engine. */
export function createSeededRandom(seed: number): RandomSource {
  let state = normalizeSeed(seed);

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / UINT32;
  };
}

export function normalizeSeed(seed: number): number {
  return Number.isFinite(seed) ? Math.floor(seed) >>> 0 : 0;
}

/**
 * Derives an independent seed from a parent seed and labelled parts, so each
 * round's generation does not depend on how many numbers earlier rounds drew.
 */
export function deriveSeed(seed: number, ...parts: Array<string | number>): number {
  let hash = normalizeSeed(seed) ^ 2166136261;

  for (const char of parts.join("|")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0x5bd1e995);
  hash ^= hash >>> 15;

  return hash >>> 0;
}

/** Fisher-Yates shuffle returning a new array. */
export function shuffle<T>(items: readonly T[], random: RandomSource): T[] {
  const shuffled = items.slice();

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = shuffled[index];
    shuffled[index] = shuffled[swapIndex];
    shuffled[swapIndex] = current;
  }

  return shuffled;
}

/**
 * The single place a new match seed comes from entropy. Everything after this
 * is derived from the returned seed.
 */
export function createMatchSeed(): number {
  const cryptoSource = globalThis.crypto;

  if (cryptoSource?.getRandomValues) {
    return cryptoSource.getRandomValues(new Uint32Array(1))[0];
  }

  return Math.floor(Math.random() * UINT32);
}
