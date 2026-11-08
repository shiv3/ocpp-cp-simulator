/**
 * Seeded random streams (docs/concepts/charger-engine.md).
 *
 * `RngStreams(seed)` hands out one stream per (charger id, stream name),
 * derived from `hash(seed, chargerId, streamName)`. A stream depends on those
 * three alone, so adding a charger or a stream to a run does not change the
 * numbers another one draws. {@link systemRngStreams} is the unseeded variant:
 * every stream is backed by `Math.random` / `crypto.randomUUID`, which is what
 * the code did before streams existed.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max). Throws a `RangeError` unless `max > min`. */
  int(min: number, max: number): number;
  /** An element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** A version-4 UUID drawn from this stream. */
  uuid(): string;
}

export interface RngSource {
  /** The stream `name` of charger `chargerId`; the same stream on every call. */
  stream(chargerId: string, name: string): Rng;
}

function checkRange(min: number, max: number): void {
  if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) {
    throw new RangeError(
      `Rng.int: the range [${String(min)}, ${String(max)}) is empty or not finite`,
    );
  }
}

// cyrb128: a small string hash with 128 bits of state.
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [
    (h1 ^ h2 ^ h3 ^ h4) >>> 0,
    (h2 ^ h1) >>> 0,
    (h3 ^ h1) >>> 0,
    (h4 ^ h1) >>> 0,
  ];
}

// sfc32: a fast 128-bit generator.
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

class SeededRng implements Rng {
  private readonly gen: () => number;

  constructor(key: string) {
    const [a, b, c, d] = cyrb128(key);
    this.gen = sfc32(a, b, c, d);
    // The first outputs of a freshly seeded generator are weakly mixed.
    for (let i = 0; i < 12; i++) this.gen();
  }

  next(): number {
    return this.gen();
  }

  int(min: number, max: number): number {
    checkRange(min, max);
    return min + Math.floor(this.next() * (max - min));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick: empty list");
    return items[this.int(0, items.length)]!;
  }

  uuid(): string {
    const hex = (n: number) => this.int(0, n).toString(16);
    let out = "";
    for (let i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) out += "-";
      else if (i === 14) out += "4";
      else if (i === 19) out += (8 + this.int(0, 4)).toString(16);
      else out += hex(16);
    }
    return out;
  }
}

class SystemRng implements Rng {
  next(): number {
    return Math.random();
  }

  int(min: number, max: number): number {
    checkRange(min, max);
    return min + Math.floor(Math.random() * (max - min));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick: empty list");
    return items[this.int(0, items.length)]!;
  }

  uuid(): string {
    return crypto.randomUUID();
  }
}

export class RngStreams implements RngSource {
  private readonly streams = new Map<string, Rng>();

  constructor(readonly seed: string | number) {}

  stream(chargerId: string, name: string): Rng {
    const key = JSON.stringify([String(this.seed), chargerId, name]);
    let rng = this.streams.get(key);
    if (!rng) {
      rng = new SeededRng(key);
      this.streams.set(key, rng);
    }
    return rng;
  }
}

const systemRng: Rng = new SystemRng();

/** Unseeded streams: `Math.random` and `crypto.randomUUID`, as before. */
export const systemRngStreams: RngSource = {
  stream: () => systemRng,
};

/**
 * The stream `name` of something that hands out streams (a charge point), or
 * the system stream for a stand-in that has none.
 */
export function rngOf(
  owner: { readonly rng?: (name: string) => Rng },
  name: string,
): Rng {
  return owner.rng?.(name) ?? systemRngStreams.stream("", name);
}
