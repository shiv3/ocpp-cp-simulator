import { type Seq } from "../blockTree";

/** Whether a sequence holds a branch point, at any depth. */
export function hasFork(seq: Seq): boolean {
  return seq.blocks.some(
    (b) => b.kind === "fork" || (b.kind === "loop" ? hasFork(b.body) : false),
  );
}

/** `pts` without repeated points and the middle of straight runs. */
export function dedupe(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    const prev = out[out.length - 2];
    if (
      prev &&
      last &&
      ((prev.x === last.x && last.x === p.x) ||
        (prev.y === last.y && last.y === p.y))
    ) {
      out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

/** An SVG path through `pts` with its corners rounded. */
export function roundedPath(pts: Point[], radius = 8): string {
  const parts = [`M ${pts[0].x} ${pts[0].y}`];
  const toward = (from: Point, to: Point, d: number): Point => {
    const len = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
    return len === 0
      ? from
      : {
          x: from.x + ((to.x - from.x) * d) / len,
          y: from.y + ((to.y - from.y) * d) / len,
        };
  };
  for (let k = 1; k < pts.length - 1; k++) {
    const p = pts[k - 1];
    const c = pts[k];
    const n = pts[k + 1];
    const r = Math.min(
      radius,
      (Math.abs(c.x - p.x) + Math.abs(c.y - p.y)) / 2,
      (Math.abs(n.x - c.x) + Math.abs(n.y - c.y)) / 2,
    );
    const a = toward(c, p, r);
    const b = toward(c, n, r);
    parts.push(`L ${a.x} ${a.y}`, `Q ${c.x} ${c.y} ${b.x} ${b.y}`);
  }
  const last = pts[pts.length - 1];
  parts.push(`L ${last.x} ${last.y}`);
  return parts.join(" ");
}
