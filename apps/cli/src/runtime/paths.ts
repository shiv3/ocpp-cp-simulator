/**
 * Runtime-neutral forms of Bun's `import.meta.dir` / `import.meta.main`
 * (#916). Pass the caller's own `import.meta`.
 *
 * On Bun both read Bun's own values, unchanged — including in the
 * `bun build --compile` sidecar, where the module lives in the binary's
 * virtual filesystem (`/$bunfs/root`, `B:\~BUN\root`) and the entry check must
 * not compare against an on-disk argv path.
 */
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

interface MetaLike {
  readonly url: string;
  /** Bun. */
  readonly dir?: string;
  /** Bun; Node >= 24.2. */
  readonly main?: boolean;
}

/** Directory of the module whose `import.meta` is passed. */
export function moduleDir(meta: ImportMeta): string {
  const m = meta as unknown as MetaLike;
  if (typeof m.dir === "string") return m.dir;
  return path.dirname(fileURLToPath(m.url));
}

/** Whether the module whose `import.meta` is passed is the program's entry. */
export function isMainModule(
  meta: ImportMeta,
  argv1: string | undefined = process.argv[1],
): boolean {
  const m = meta as unknown as MetaLike;
  if (typeof m.main === "boolean") return m.main;
  if (!argv1) return false;
  let self: string;
  try {
    self = fileURLToPath(m.url);
  } catch {
    return false;
  }
  // npm installs bins as symlinks (node_modules/.bin/x -> ../pkg/dist-cli/main.js).
  return realpathOrSelf(path.resolve(argv1)) === realpathOrSelf(self);
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
