// Which charge point a virtual user slot drives, and under which id.
//
// k6's `vu.idInTest` is unique across the whole test and is allocated
// consistently by `--execution-segment`, so two k6 instances that run
// complementary segments of one test never see the same value. The charger
// index derived from it is therefore global, and so are the ids: running the
// same script on N k6-operator pods creates N disjoint sets of chargers.

export interface FleetShape {
  /** Chargers in the whole test (all segments together). */
  readonly chargers: number;
  /** Chargers one virtual user drives. */
  readonly chargersPerVu: number;
}

/** Virtual users needed for the fleet (the executor's `vus`). */
export function vusFor(shape: FleetShape): number {
  return Math.ceil(shape.chargers / shape.chargersPerVu);
}

/**
 * Global zero-based charger index of slot `slot` of the VU with k6 id
 * `vuIdInTest` (1-based), or `null` when the slot is beyond the fleet (the
 * last VU of an uneven split).
 */
export function chargerIndex(
  shape: FleetShape,
  vuIdInTest: number,
  slot: number,
): number | null {
  const index = (vuIdInTest - 1) * shape.chargersPerVu + slot;
  return index >= 0 && index < shape.chargers ? index : null;
}

export interface IdScheme {
  readonly prefix: string;
  /** Zero-pad the number to this width. */
  readonly pad: number;
  /** Added to the index, to keep two tests against one CSMS apart. */
  readonly offset: number;
}

/** `CP-00001` for index 0 with the defaults (prefix `CP-`, pad 5, offset 0). */
export function chargerId(scheme: IdScheme, index: number): string {
  return `${scheme.prefix}${String(index + 1 + scheme.offset).padStart(scheme.pad, "0")}`;
}

/** Start delay that spreads connects evenly over the ramp, per global index. */
export function startDelayMs(
  index: number,
  chargers: number,
  rampMs: number,
): number {
  if (rampMs <= 0 || chargers <= 1) return 0;
  return Math.floor((index / chargers) * rampMs);
}

/** `30s`, `5m`, `1h`, `1h30m`, `500ms` or bare seconds, as seconds. */
export function parseDurationSeconds(text: string): number {
  const trimmed = text.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let total = 0;
  let consumed = 0;
  for (let m = re.exec(trimmed); m; m = re.exec(trimmed)) {
    const n = Number(m[1]);
    total +=
      m[2] === "ms"
        ? n / 1000
        : m[2] === "s"
          ? n
          : m[2] === "m"
            ? n * 60
            : n * 3600;
    consumed += m[0].length;
  }
  if (consumed === 0 || consumed !== trimmed.length) {
    throw new Error(`invalid duration "${text}" (use e.g. 30s, 5m, 1h30m)`);
  }
  return total;
}
