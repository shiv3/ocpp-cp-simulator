import type { WireFrame } from "./FakeCsms";

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const LOOPBACK_PORT = /127\.0\.0\.1:\d+/g;
const UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Turns the recorded frames into the text the fixtures hold: message ids and
 * UUIDs become `id-N` / `uuid-N` by first appearance (so which frame answers
 * which survives), and every ISO timestamp becomes `<ts>`. Nothing else is
 * touched: numbers, key order and the order of frames are the contract.
 */
export function normalizeFrames(frames: readonly WireFrame[]): string[] {
  const ids = new Map<string, string>();
  const uuids = new Map<string, string>();
  const idOf = (id: string) => {
    let out = ids.get(id);
    if (!out) {
      out = `id-${ids.size + 1}`;
      ids.set(id, out);
    }
    return out;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (ISO_TIMESTAMP.test(value)) return "<ts>";
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
  return frames.map((f) =>
    JSON.stringify({
      d: f.dir,
      k: f.kind,
      id: idOf(f.id),
      ...(f.action === undefined ? {} : { a: f.action }),
      p: walk(f.payload),
    }),
  );
}
