import type { WireFrame } from "./FakeCsms";

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
// The fake CSMS puts a per-instance token in its URL path (see FakeCsms).
const LOOPBACK_PORT =
  /127\.0\.0\.1:\d+(?:\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})?/g;
const UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface NormalizeOptions {
  /**
   * Keep more of what the default mode hides, for cases that opt in:
   * a timestamp in a CP> frame becomes its distance in whole seconds from the
   * first CP> timestamp plus its digit-masked shape (`<ts+2s 9999-99-99T99:99:99.999Z>`),
   * so a wrong value or a lost millisecond part shows; a message id keeps a
   * mark when it is not UUID-shaped. CSMS> timestamps stay `<ts>`.
   */
  readonly strict?: boolean;
}

const JS_ERROR = /^(?:Type|Range|Reference|Syntax)Error: /;
const DAY_MS = 86_400_000;

/**
 * Turns the recorded frames into the text the fixtures hold: message ids and
 * UUIDs become `id-N` / `uuid-N` by first appearance (so which frame answers
 * which survives), and every ISO timestamp becomes `<ts>`. Nothing else is
 * touched: numbers, key order and the order of frames are the contract.
 */
export function normalizeFrames(
  frames: readonly WireFrame[],
  options: NormalizeOptions = {},
): string[] {
  const strict = options.strict === true;
  let origin: number | null = null;
  let inCpFrame = false;
  const ids = new Map<string, string>();
  const uuids = new Map<string, string>();
  const idOf = (id: string) => {
    let out = ids.get(id);
    if (!out) {
      out = `id-${ids.size + 1}`;
      if (strict && !UUID.test(id)) out += "(raw)";
      ids.set(id, out);
    }
    return out;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (ISO_TIMESTAMP.test(value)) {
        if (!strict || !inCpFrame) return "<ts>";
        const at = Date.parse(value);
        origin ??= at;
        const delta = at - origin;
        const shape = value.replace(/\d/g, "9");
        if (Math.abs(delta) >= DAY_MS) return `<ts far ${shape}>`;
        return `<ts${delta < 0 ? "-" : "+"}${Math.round(Math.abs(delta) / 1000)}s ${shape}>`;
      }
      if (value.startsWith("-----BEGIN CERTIFICATE REQUEST-----")) {
        return "<csr>";
      }
      if (value.includes("127.0.0.1:")) {
        return value.replace(LOOPBACK_PORT, "127.0.0.1:<port>");
      }
      if (UUID.test(value)) {
        let out = uuids.get(value);
        if (!out) {
          out = `<uuid-${uuids.size + 1}>`;
          uuids.set(value, out);
        }
        return out;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v);
      return out;
    }
    return value;
  };
  return frames.map((frame) => {
    let f = frame;
    if (f.kind === "error") {
      const p = f.payload as { description?: unknown };
      // The text of an uncaught JavaScript error names local variables of the
      // implementation; the error code is the contract, the wording is not.
      if (typeof p.description === "string" && JS_ERROR.test(p.description)) {
        f = { ...f, payload: { ...p, description: "<javascript error>" } };
      }
    }
    if (f.kind === "raw") {
      return JSON.stringify({ d: f.dir, k: f.kind, p: f.payload });
    }
    inCpFrame = f.dir === "CP>";
    return JSON.stringify({
      d: f.dir,
      k: f.kind,
      id: idOf(f.id),
      ...(f.action === undefined ? {} : { a: f.action }),
      p: walk(f.payload),
    });
  });
}
