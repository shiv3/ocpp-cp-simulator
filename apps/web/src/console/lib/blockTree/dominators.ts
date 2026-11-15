// ---------------------------------------------------------------------------
// Dominators and post-dominators (Cooper, Harvey, Kennedy)

/** Immediate dominators over `succ` from a virtual root `entry`. Every
 *  vertex must be reachable from `entry`. */
export function immediateDominators(
  entry: string,
  succ: (v: string) => readonly string[],
): Map<string, string> {
  const order: string[] = [];
  const seen = new Set<string>([entry]);
  // Iterative DFS post-order.
  const stack: Array<{ v: string; i: number }> = [{ v: entry, i: 0 }];
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    const next = succ(top.v);
    if (top.i < next.length) {
      const w = next[top.i++];
      if (!seen.has(w)) {
        seen.add(w);
        stack.push({ v: w, i: 0 });
      }
    } else {
      order.push(top.v);
      stack.pop();
    }
  }
  const rpo = order.reverse();
  const index = new Map(rpo.map((v, i) => [v, i]));
  const preds = new Map<string, string[]>();
  for (const v of rpo) {
    for (const w of succ(v)) {
      const list = preds.get(w);
      if (list) list.push(v);
      else preds.set(w, [v]);
    }
  }
  const idom = new Map<string, string>([[entry, entry]]);
  const intersect = (a: string, b: string): string => {
    while (a !== b) {
      while (index.get(a)! > index.get(b)!) a = idom.get(a)!;
      while (index.get(b)! > index.get(a)!) b = idom.get(b)!;
    }
    return a;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const v of rpo) {
      if (v === entry) continue;
      let candidate: string | undefined;
      for (const p of preds.get(v) ?? []) {
        if (!idom.has(p)) continue;
        candidate = candidate === undefined ? p : intersect(p, candidate);
      }
      if (candidate !== undefined && idom.get(v) !== candidate) {
        idom.set(v, candidate);
        changed = true;
      }
    }
  }
  return idom;
}
