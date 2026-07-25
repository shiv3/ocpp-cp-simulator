// Public-domain reference implementation by bryc.
export function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703,
    h2 = 3144134277,
    h3 = 1013904242,
    h4 = 2773480762;
  for (let i = 0, k; i < str.length; i++) {
    k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

// Public-domain xoshiro128** reference implementation by David Blackman and Sebastiano Vigna.
export function xoshiro128ss(
  state: [number, number, number, number],
): () => number {
  let [a, b, c, d] = state;

  return function () {
    const t = b << 9;
    let r = b * 5;
    r = ((r << 7) | (r >>> 25)) * 9;
    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= t;
    d = (d << 11) | (d >>> 21);
    return r >>> 0;
  };
}

export function deriveSeed32(seed: number, salt: string): number {
  return cyrb128(`${seed}:${salt}`)[0];
}

export function draw(next: () => number, bound: number): number {
  return Math.floor(((next() >>> 0) / 4_294_967_296) * bound);
}

export function makeRuleRng(
  effectiveChargerSeed: number,
  ruleId: string,
): () => number {
  const state = cyrb128(`${effectiveChargerSeed}:${ruleId}`);

  // xoshiro's all-zero state is absorbing, so retain a fixed non-zero fallback.
  if (state.every((word) => word === 0)) {
    state[0] = 0x9e3779b9;
  }

  return xoshiro128ss(state);
}
