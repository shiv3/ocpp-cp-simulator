// packages/k6-runtime/src/behaviorRandom.ts
// Seeded random streams for behaviors. The same algorithm and key as
// packages/core/src/cp/shared/rng.ts (cyrb128 + sfc32 over
// JSON.stringify([seed, chargerId, name])), so a stream draws the same numbers
// here as on the simulator for the same seed, charge point id and stream name.
import type { RandomStream } from "./behaviorTypes.ts";

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

/** The stream `name` of charge point `chargerId` under `seed`. */
export function seededStream(
  seed: string,
  chargerId: string,
  name: string,
): RandomStream {
  const [a, b, c, d] = cyrb128(JSON.stringify([seed, chargerId, name]));
  const gen = sfc32(a, b, c, d);
  for (let i = 0; i < 12; i++) gen();
  // RandomStream.int is inclusive at both ends (the core host adapts its
  // [min, max) stream the same way: ChargerEngine, ctx.random).
  const rng = {
    next: () => gen(),
    int: (minInclusive: number, maxInclusive: number): number =>
      minInclusive + Math.floor(gen() * (maxInclusive + 1 - minInclusive)),
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error("pick: empty list");
      return items[Math.floor(gen() * items.length)] as T;
    },
    uuid: (): string => {
      const hex = (n: number): string => Math.floor(gen() * n).toString(16);
      let out = "";
      for (let i = 0; i < 36; i++) {
        if (i === 8 || i === 13 || i === 18 || i === 23) out += "-";
        else if (i === 14) out += "4";
        else if (i === 19) out += (8 + Math.floor(gen() * 4)).toString(16);
        else out += hex(16);
      }
      return out;
    },
  };
  return rng;
}
