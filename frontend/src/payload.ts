// Seeded payload generation. Both hosts receive the same bytes because the
// frontend, not the host, generates every payload from a fixed seed.

export interface Row {
  id: number;
  x: number;
  y: number;
  z: number;
  s: string;
  nested: { a: number; b: boolean; c: string };
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function word(rand: () => number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

export function rows(seed: number, count: number): Row[] {
  const rand = mulberry32(seed);
  const out: Row[] = new Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = {
      id: i,
      x: Math.round(rand() * 1e6) / 1e3,
      y: Math.round(rand() * 1e6) / 1e3,
      z: Math.round(rand() * 1e6) / 1e3,
      s: word(rand, 32),
      nested: { a: Math.floor(rand() * 1e6), b: rand() < 0.5, c: word(rand, 8) },
    };
  }
  return out;
}

export function bytes(seed: number, count: number): Uint8Array {
  const rand = mulberry32(seed);
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = Math.floor(rand() * 256);
  return out;
}

/** Rows needed for a JSON payload of roughly `targetBytes`, measured not guessed. */
export function rowsForBytes(seed: number, targetBytes: number): number {
  const probe = JSON.stringify(rows(seed, 256)).length;
  return Math.max(1, Math.round((targetBytes / probe) * 256));
}

/** FNV-1a 64 over a byte array as 16 hex digits. Used by the conformance gate. */
export function fnv1a64(data: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < data.length; i++) {
    h ^= BigInt(data[i]);
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
