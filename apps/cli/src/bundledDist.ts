import * as path from "path";
import * as fs from "fs";
import { moduleDir } from "./runtime";

/** Result of a `dist/` lookup: where it was found (if at all) and every
 *  directory that was tried, so a failure can name the paths instead of
 *  guessing at the caller's setup. */
export interface BundledDistLookup {
  /** Directory containing `index.html`, or null when nothing matched. */
  readonly dir: string | null;
  /** Absolute candidates tried, in order — verbatim material for the error. */
  readonly searched: readonly string[];
}

function hasIndexHtml(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, "index.html")).isFile();
  } catch {
    // not built / not present
    return false;
  }
}

/**
 * Locate the bundled web console (Vite-built `dist/`).
 *
 * Three shapes ship this CLI and each puts `dist/` somewhere different:
 *
 * 1. **Source checkout** — `bun apps/cli/src/main.ts`. `dist/` is `<repo>/dist`
 *    once `bun run build` has run. Three levels up from `apps/cli/src/`.
 * 2. **Installed package** — the release tarball ships the CLI as one
 *    `bun build` bundle, `<pkg>/dist-cli/main.js`, beside `<pkg>/dist`
 *    (#578). One level up.
 * 3. **`bun build --compile` binary** — the Tauri sidecar. Here the module
 *    lives in the binary's virtual filesystem, so the module directory
 *    (`moduleDir(import.meta)`, Bun's `import.meta.dir`) is
 *    `/$bunfs/root` (POSIX) or `B:\~BUN\root` (Windows) and walking up
 *    from it yields `/dist`, which never exists. That was issue #319:
 *    `src-tauri/src/lib.rs` spawns the sidecar with `--web-console`, so
 *    every desktop release from v0.3.2 through v0.7.8 — about 30 of them —
 *    exited 1 the moment it started. `process.execPath` is the real
 *    on-disk path of a compiled binary, so the sidecar's neighbours are
 *    searched from there instead.
 *
 * For the desktop bundle even that is a guess (Tauri puts resources in a
 * different place on each platform), so the shell passes the directory
 * outright via `--web-console-dist` — see `src-tauri/src/lib.rs`. An
 * explicit path is authoritative: if it has no `index.html` the lookup
 * fails rather than silently falling back to some other directory.
 */
export function resolveBundledDist(
  explicit?: string | null,
): BundledDistLookup {
  if (explicit) {
    const dir = path.resolve(explicit);
    return { dir: hasIndexHtml(dir) ? dir : null, searched: [dir] };
  }

  const execDir = path.dirname(process.execPath);
  const candidates = [
    // Shape 2 (installed bundle): <pkg>/dist-cli -> <pkg>/dist. First: from
    // the bundle, two levels up is the directory holding the package
    // (node_modules/), and a stray dist/ there must not win over the
    // package's own. From a source checkout this is <repo>/apps/cli/dist, which
    // does not exist, so shape 1 is reached unchanged.
    path.resolve(moduleDir(import.meta), "../dist"),
    // Shape 1 (source checkout): <repo>/apps/cli/src -> <repo>/dist.
    path.resolve(moduleDir(import.meta), "../../../dist"),
    // Shape 3 (compiled): a `dist/` shipped beside or one level above the
    // binary, and the macOS .app layout where the sidecar sits in
    // Contents/MacOS/ and Tauri resources in Contents/Resources/.
    path.join(execDir, "dist"),
    path.resolve(execDir, "../dist"),
    path.resolve(execDir, "../Resources/web-console"),
  ];

  const searched: string[] = [];
  for (const candidate of candidates) {
    if (searched.includes(candidate)) continue;
    searched.push(candidate);
    if (hasIndexHtml(candidate)) return { dir: candidate, searched };
  }
  return { dir: null, searched };
}

/** This directory as `resolveBundledDist()` sees it, for the `--web-console`
 *  diagnostic in `cli/parseArgs.ts`: evaluated here so the printed
 *  `import.meta.dir` stays the directory the lookup walks from. */
export function cliModuleDir(): string {
  return moduleDir(import.meta);
}
