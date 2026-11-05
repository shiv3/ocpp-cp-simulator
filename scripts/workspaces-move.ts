// scripts/workspaces-move.ts
//
// Produces the mechanical part of the Bun-workspace move from #578: it
// `git mv`s every file under src/, vendor/ocpp-schemas/ and schema/ to its
// package (as assigned by PACKAGE_MAP in scripts/check-package-boundaries.ts)
// and rewrites every module specifier and every path reference that names a
// moved file. It changes no logic.
//
// The point of a script instead of a hand-made diff: other pull requests keep
// landing on src/, so the move has to be regenerable on a newer `main` right
// before it merges. Everything a human has to write (package manifests,
// tsconfigs, build wiring, docs prose) lives in separate commits on top.
//
//   bun run scripts/workspaces-move.ts             # move + rewrite, staged
//   bun run scripts/workspaces-move.ts --dry-run   # print the move table and counts
//   bun run scripts/workspaces-move.ts --check     # exit 1 unless the tree is in the pre-move layout
//
// Re-running it on the same pre-move tree gives the same result. On a tree
// that is already in the workspace layout it prints a message and changes
// nothing (exit 0; `--check` exits 1 there, since it asks "is this still the
// old layout?"). A run refuses to start while tracked files have uncommitted
// changes, so the resulting diff is exactly the script's output.
//
// Rewrite rules (resolved against the OLD location, written for the NEW one):
//
//   * the file stays in the same workspace package      -> relative specifier
//     (inside apps/web an existing `@/…` import stays `@/…`)
//   * the file is in one workspace package and the target in another
//     packages/<x>                                      -> `@ocpp-cp-sim/<x>/<path under src/>`,
//     without extension; a directory import (`../cp`) becomes an explicit
//     `/index`, because the `exports` map is a file pattern
//   * the importer is not a workspace member (scripts/, e2e/, vite.config.ts,
//     examples/, …) or the target is not in a package   -> relative specifier
//   * `new URL("./x", import.meta.url)`, `resolve(import.meta.dir, "./x")`,
//     `/// <reference path>` and markdown links          -> relative path
//   * prose and config that name a repo path (`src/cp/…`) -> the new path,
//     longest match first
//
// Whatever it cannot map is printed at the end and has to be fixed by hand.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// ---------------------------------------------------------------------------
// Destination rules
// ---------------------------------------------------------------------------

/** Workspace directory of each PACKAGE_MAP package name. */
export const PACKAGE_DIRS: Readonly<Record<string, string>> = {
  ocpp: "packages/ocpp",
  contracts: "packages/contracts",
  trace: "packages/trace",
  "k6-runtime": "packages/k6-runtime",
  core: "packages/core",
  client: "packages/client",
  "apps/cli": "apps/cli",
  "apps/web": "apps/web",
};

/**
 * Old directory that is dropped when a file moves into its package's src/.
 * Packages absent here keep the whole path below the old `src/`.
 */
const STRIPPED_PREFIX: Readonly<Record<string, string>> = {
  ocpp: "src/ocpp/",
  contracts: "src/protocol/",
  trace: "src/trace/",
  "k6-runtime": "src/cli/exportK6/runtime/",
  client: "src/data/",
};

/** The three roots whose tracked files all have to move. */
export const OLD_ROOTS = ["src/", "vendor/ocpp-schemas/", "schema/"] as const;

export function isUnderOldRoot(file: string): boolean {
  return OLD_ROOTS.some((r) => file.startsWith(r));
}

/**
 * Files whose place inside the package is not "the old path minus a prefix":
 * the k6 type declarations are kept out of src/ because the runtime
 * directory next to them is emitted verbatim into every export.
 */
const FILE_DESTINATIONS: Readonly<Record<string, string>> = {
  "src/cli/exportK6/k6-types.d.ts": "packages/k6-runtime/k6-types.d.ts",
};

/** New path of `file` once PACKAGE_MAP has assigned it to `pkg`, or null. */
export function destinationFor(file: string, pkg: string): string | null {
  const dir = PACKAGE_DIRS[pkg];
  if (!dir) return null;
  const fixed = FILE_DESTINATIONS[file];
  if (fixed) return fixed.startsWith(`${dir}/`) ? fixed : null;
  if (file.startsWith("vendor/ocpp-schemas/"))
    return pkg === "ocpp" ? `${dir}/${file}` : null;
  if (file.startsWith("schema/"))
    return pkg === "core" ? `${dir}/${file}` : null;
  if (!file.startsWith("src/")) return null;
  const strip =
    pkg === "apps/cli" && file.startsWith("src/cli/")
      ? "src/cli/"
      : STRIPPED_PREFIX[pkg];
  if (strip) {
    return file.startsWith(strip)
      ? `${dir}/src/${file.slice(strip.length)}`
      : null;
  }
  return `${dir}/src/${file.slice("src/".length)}`;
}

export interface MapLike {
  readonly match: string;
  readonly pkg: string;
}

export interface MovePlan {
  /** old file -> new file, for every file under an old root. */
  readonly moves: ReadonlyMap<string, string>;
  /**
   * old directory -> new directory, for directories whose files all land in
   * one place, or (flagged in `ambiguousDirs`) where one destination wins.
   */
  readonly dirMap: ReadonlyMap<string, string>;
  readonly ambiguousDirs: ReadonlySet<string>;
  /** Files under an old root that PACKAGE_MAP does not place. */
  readonly unplaced: readonly string[];
  /** Two files that would land on one path. */
  readonly collisions: readonly string[];
  readonly perPackage: ReadonlyMap<string, number>;
}

export function planMoves(
  files: readonly string[],
  pkgOf: (file: string) => string | null,
  map: readonly MapLike[],
): MovePlan {
  const moves = new Map<string, string>();
  const unplaced: string[] = [];
  const collisions: string[] = [];
  const perPackage = new Map<string, number>();
  const taken = new Map<string, string>();
  for (const file of [...files].sort()) {
    if (!isUnderOldRoot(file)) continue;
    const pkg = pkgOf(file);
    const dest = pkg ? destinationFor(file, pkg) : null;
    if (!pkg || !dest) {
      unplaced.push(file);
      continue;
    }
    const prev = taken.get(dest);
    if (prev) collisions.push(`${prev} and ${file} -> ${dest}`);
    taken.set(dest, file);
    moves.set(file, dest);
    perPackage.set(pkg, (perPackage.get(pkg) ?? 0) + 1);
  }

  // Directory map: a directory maps when every file below it keeps its
  // sub-path and lands under one new directory.
  const candidates = new Map<string, Map<string, number>>();
  for (const [oldFile, newFile] of moves) {
    const parts = oldFile.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      const tail = oldFile.slice(dir.length + 1);
      const newDir = newFile.endsWith("/" + tail)
        ? newFile.slice(0, newFile.length - tail.length - 1)
        : "\0";
      const counts = candidates.get(dir) ?? new Map<string, number>();
      counts.set(newDir, (counts.get(newDir) ?? 0) + 1);
      candidates.set(dir, counts);
    }
  }
  // The PACKAGE_MAP entry for exactly this directory says where the directory
  // "is", for the directories that are split between packages.
  const primary = new Map<string, string>();
  for (const e of map) {
    if (!e.match.endsWith("/")) continue;
    const dest = destinationFor(e.match, e.pkg);
    if (dest) primary.set(e.match.slice(0, -1), dest.replace(/\/$/, ""));
  }
  const dirMap = new Map<string, string>();
  const ambiguousDirs = new Set<string>();
  for (const [dir, counts] of candidates) {
    const valid = [...counts].filter(([d]) => d !== "\0");
    if (valid.length === 1 && counts.size === 1) {
      dirMap.set(dir, valid[0]![0]);
    } else if (dir.includes("/")) {
      // Split directory (src/cli, src/utils, src/data, src/test, …). Not the
      // top-level roots: "src/" alone never maps.
      const chosen =
        primary.get(dir) ??
        valid.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
      if (chosen) {
        dirMap.set(dir, chosen);
        ambiguousDirs.add(dir);
      }
    }
  }
  return {
    moves,
    dirMap,
    ambiguousDirs,
    unplaced,
    collisions,
    perPackage,
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** `packages/core` / `apps/web` for a path inside a workspace member. */
export function workspaceOf(path: string): string | null {
  const m = /^((?:packages|apps)\/[^/]+)\//.exec(path);
  return m ? m[1]! : null;
}

export function packageSpecifierName(workspaceDir: string): string {
  return `@ocpp-cp-sim/${workspaceDir.split("/")[1]}`;
}

/** posix.relative that does not depend on the process cwd; "" is the repo root. */
export function relativeTo(fromDir: string, to: string): string {
  return posix.relative(`/${fromDir}`, `/${to}`);
}

function relativeSpecifier(fromDir: string, toBase: string, slash: boolean) {
  let r = relativeTo(fromDir, toBase);
  if (r === "") r = ".";
  if (!r.startsWith(".")) r = "./" + r;
  if (slash && !r.endsWith("/")) r += "/";
  return r;
}

export interface Ctx {
  /** Every tracked file before the move. */
  readonly files: ReadonlySet<string>;
  /** Every directory that holds a tracked file ("" is the root). */
  readonly dirs: ReadonlySet<string>;
  readonly plan: MovePlan;
  /** Alias prefix -> old directory, e.g. "@/" -> "src/". */
  readonly aliases: Readonly<Record<string, string>>;
}

export function makeCtx(
  files: readonly string[],
  plan: MovePlan,
  aliases: Readonly<Record<string, string>> = { "@/": "src/" },
): Ctx {
  const dirs = new Set<string>([""]);
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++)
      dirs.add(parts.slice(0, i).join("/"));
  }
  return { files: new Set(files), dirs, plan, aliases };
}

/** New location of an old path (file or directory); null when it stays. */
export function mapPath(
  ctx: Ctx,
  p: string,
): { path: string; ambiguous: boolean } | null {
  const exact = ctx.plan.moves.get(p);
  if (exact) return { path: exact, ambiguous: false };
  let dir = p;
  for (;;) {
    const hit = ctx.plan.dirMap.get(dir);
    if (hit !== undefined)
      return {
        path: hit + p.slice(dir.length),
        ambiguous: ctx.plan.ambiguousDirs.has(dir),
      };
    if (!dir.includes("/")) return null;
    dir = dir.slice(0, dir.lastIndexOf("/"));
  }
}

function newLocation(ctx: Ctx, p: string): string {
  return ctx.plan.moves.get(p) ?? p;
}

// ---------------------------------------------------------------------------
// Module specifiers
// ---------------------------------------------------------------------------

const SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".d.ts",
  ".json",
  "/index.ts",
  "/index.tsx",
] as const;

export interface Resolved {
  /** Normalized path the specifier names, before suffix probing. */
  readonly base: string;
  /** The tracked file it resolved to. */
  readonly file: string;
  /** What was appended to `base` to reach `file` ("" | ".ts" | "/index.ts" …). */
  readonly suffix: string;
  /** `./x.js` standing for `./x.ts`: the extension to put back. */
  readonly swappedExt: string | null;
}

export function resolveModule(
  ctx: Ctx,
  fromFile: string,
  specifier: string,
): Resolved | { unresolved: true } | null {
  const clean = specifier.replace(/\?.*$/, "");
  let base: string | null = null;
  if (clean.startsWith(".")) {
    base = posix.normalize(posix.join(posix.dirname(fromFile), clean));
  } else {
    for (const [prefix, dir] of Object.entries(ctx.aliases)) {
      if (clean.startsWith(prefix)) {
        base = posix.normalize(dir + clean.slice(prefix.length));
        break;
      }
    }
  }
  if (base === null) return null;
  const trimmed = base.replace(/\/$/, "");
  for (const s of SUFFIXES) {
    if (ctx.files.has(trimmed + s))
      return { base: trimmed, file: trimmed + s, suffix: s, swappedExt: null };
  }
  const js = /\.(jsx?)$/.exec(trimmed);
  if (js) {
    const swapped = trimmed.replace(/\.js$/, ".ts").replace(/\.jsx$/, ".tsx");
    if (swapped !== trimmed && ctx.files.has(swapped))
      return {
        base: trimmed,
        file: swapped,
        suffix: "",
        swappedExt: "." + js[1],
      };
  }
  return { unresolved: true };
}

export type SpecifierKind = "relative" | "package" | "alias";

/**
 * The specifier to write in `fromFile`'s new location, or null when the
 * specifier is not ours to touch (bare package, unresolved).
 */
export function newSpecifier(
  ctx: Ctx,
  fromFile: string,
  specifier: string,
): { text: string; kind: SpecifierKind } | null {
  const res = resolveModule(ctx, fromFile, specifier);
  if (res === null || "unresolved" in res) return null;
  const query = /\?.*$/.exec(specifier)?.[0] ?? "";
  const clean = specifier.replace(/\?.*$/, "");
  const wasAlias = !clean.startsWith(".");
  const slash = clean.endsWith("/");

  const newFrom = newLocation(ctx, fromFile);
  const newFile = newLocation(ctx, res.file);
  // The new "base": the new file minus whatever suffix probing added.
  let newBase = newFile;
  if (res.swappedExt) {
    newBase = newFile.replace(/\.tsx?$/, "") + res.swappedExt;
  } else if (res.suffix) {
    newBase = newFile.slice(0, newFile.length - res.suffix.length);
  }
  const viaIndex = res.suffix.startsWith("/index");
  const wsFrom = workspaceOf(newFrom);
  const wsTo = workspaceOf(newFile);

  if (wasAlias && wsFrom === "apps/web" && wsTo === "apps/web") {
    const rel = newBase.slice("apps/web/src/".length);
    if (newBase.startsWith("apps/web/src/"))
      return { text: "@/" + rel + (slash ? "/" : "") + query, kind: "alias" };
  }
  const crossPackage =
    wsFrom !== null &&
    wsTo !== null &&
    wsFrom !== wsTo &&
    wsTo.startsWith("packages/");
  if (crossPackage) {
    const pkgDir = wsTo!;
    let sub: string;
    if (newBase === `${pkgDir}/src`) {
      sub = "";
    } else if (newBase.startsWith(`${pkgDir}/src/`)) {
      sub = newBase.slice(`${pkgDir}/src/`.length);
    } else {
      sub = newBase.slice(pkgDir.length + 1);
    }
    // `import "x.ts"` / `"x.js"`: the exports map appends the extension.
    sub = sub.replace(/\.(tsx?|jsx?)$/, "");
    // Extensionless JSON import: keep the real file name.
    if (res.suffix === ".json") sub += ".json";
    if (viaIndex)
      sub = sub === "" ? "index" : sub.replace(/\/$/, "") + "/index";
    return {
      text: `${packageSpecifierName(pkgDir)}/${sub}${query}`,
      kind: "package",
    };
  }
  return {
    text: relativeSpecifier(posix.dirname(newFrom), newBase, slash) + query,
    kind: "relative",
  };
}

// ---------------------------------------------------------------------------
// Locating specifiers and path strings in source files
// ---------------------------------------------------------------------------

export interface SourceRef {
  /** Offsets of the string's content, without the quotes. */
  readonly start: number;
  readonly end: number;
  readonly value: string;
  /**
   * "segments": consecutive string arguments of path.join / path.resolve that
   * start at an old root (`join(repoRoot, "src", "cli", "main.ts")`). `start`
   * and `end` then include the quotes, and `value` is the joined path.
   */
  readonly kind: "module" | "path" | "segments";
}

const MODULE_CALLEES = new Set([
  "vi.mock",
  "vi.doMock",
  "vi.unmock",
  "vi.doUnmock",
  "vi.importActual",
  "vi.importMock",
  "jest.mock",
  "mock.module",
  "require",
  "require.resolve",
  "import.meta.resolve",
  "Bun.resolveSync",
]);
const PATH_CALLEES = new Set(["resolve", "join", "path.resolve", "path.join"]);
const OLD_ROOT_SEGMENTS = new Set(["src", "schema", "vendor"]);
const DIR_EXPRESSIONS = new Set([
  "import.meta.dir",
  "import.meta.dirname",
  "__dirname",
  "dirname(fileURLToPath(import.meta.url))",
  "path.dirname(fileURLToPath(import.meta.url))",
]);

export function isRewritableSource(file: string): boolean {
  return /\.(ts|tsx|mts|js|mjs)$/.test(file) && !file.endsWith(".d.ts");
}

export function collectSourceRefs(file: string, text: string): SourceRef[] {
  const kind = file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : /\.m?js$/.test(file)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const out: SourceRef[] = [];
  const lit = (n: ts.Node | undefined, k: SourceRef["kind"]): void => {
    if (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)))
      out.push({
        start: n.getStart(sf) + 1,
        end: n.end - 1,
        value: n.text,
        kind: k,
      });
  };
  const collectSegments = (call: ts.CallExpression): void => {
    const args = call.arguments;
    for (let i = 1; i < args.length; i++) {
      const first = args[i]!;
      if (!ts.isStringLiteral(first) || !OLD_ROOT_SEGMENTS.has(first.text))
        continue;
      const run: ts.StringLiteral[] = [];
      for (let j = i; j < args.length && ts.isStringLiteral(args[j]!); j++)
        run.push(args[j] as ts.StringLiteral);
      out.push({
        start: run[0]!.getStart(sf),
        end: run[run.length - 1]!.end,
        value: run.map((l) => l.text).join("/"),
        kind: "segments",
      });
      return;
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) lit(node.moduleSpecifier, "module");
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier)
      lit(node.moduleSpecifier, "module");
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      lit(node.moduleReference.expression, "module");
    else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument))
        lit(node.argument.literal, "module");
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        lit(node.arguments[0], "module");
      } else if (MODULE_CALLEES.has(callee.getText(sf))) {
        lit(node.arguments[0], "module");
      } else if (
        PATH_CALLEES.has(callee.getText(sf)) &&
        node.arguments.length === 2 &&
        DIR_EXPRESSIONS.has(node.arguments[0]!.getText(sf))
      ) {
        lit(node.arguments[1], "path");
      } else if (PATH_CALLEES.has(callee.getText(sf))) {
        collectSegments(node);
      }
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      node.arguments?.length === 2 &&
      node.arguments[1]!.getText(sf) === "import.meta.url"
    ) {
      lit(node.arguments[0], "path");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const m of text.matchAll(/^(\/\/\/\s*<reference\s+path=")([^"]+)"/gm)) {
    const start = m.index! + m[1]!.length;
    out.push({ start, end: start + m[2]!.length, value: m[2]!, kind: "path" });
  }
  return out;
}

/**
 * A relative path string (URL / dirname join / markdown link / reference
 * path) from `oldFile`, rewritten for the new location. Only paths that name
 * something tracked (a file, a directory holding files, the repo root) are
 * touched; `../dist` and the like are left for a human.
 */
export function newPathString(
  ctx: Ctx,
  oldFile: string,
  value: string,
): string | null {
  if (value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  const hash = value.search(/[#?]/);
  const pathPart = hash === -1 ? value : value.slice(0, hash);
  const tailPart = hash === -1 ? "" : value.slice(hash);
  if (pathPart === "") return null;
  const target = posix.normalize(posix.join(posix.dirname(oldFile), pathPart));
  const t = target === "." ? "" : target.replace(/\/$/, "");
  if (!(t === "" || ctx.files.has(t) || ctx.dirs.has(t))) return null;
  const mapped = mapPath(ctx, t)?.path ?? t;
  const newFrom = newLocation(ctx, oldFile);
  let rel = relativeTo(posix.dirname(newFrom), mapped);
  if (rel === "") rel = ".";
  if (!rel.startsWith(".") && pathPart.startsWith("./")) rel = "./" + rel;
  if (pathPart.endsWith("/") && !rel.endsWith("/")) rel += "/";
  return rel + tailPart;
}

// ---------------------------------------------------------------------------
// Text references
// ---------------------------------------------------------------------------

// A repo path that starts at one of the old roots, optionally behind `./`,
// `../`, a leading `/` right after a quote (index.html, vite; not a regex
// literal such as /schema/i) or a github.com blob URL of this
// repository. The lookbehind keeps `src-tauri/src/…`, `node_modules/x/src/…`
// and `packages/core/src/…` out.
const PATH_CHARS = String.raw`(?:[\w.\-@*/]|\{[^}\s"'\x60]*\})*`;
const ROOT_REF = new RegExp(
  String.raw`(?<![\w@.\/\\-])` +
    String.raw`((?:https?:\/\/github\.com\/shiv3\/ocpp-cp-simulator\/(?:blob|tree)\/[\w.\-]+\/)|(?:\.{1,2}\/)+|(?<=["'])\/)?` +
    String.raw`((?:src|schema)\/${PATH_CHARS}|vendor\/ocpp-schemas${PATH_CHARS})`,
  "g",
);
const REL_REF = new RegExp(
  String.raw`(?<![\w@.\/\\-])((?:\.{1,2}\/)+)([\w@.\-\/]*[\w@\-\/])`,
  "g",
);

/**
 * The sweep for leftovers: repo-rooted mentions of an old root in text that
 * has already been rewritten. `file` is where that text now lives, so a
 * relative `../../vendor/ocpp-schemas` that now points into a package is not
 * mistaken for the old top-level directory.
 */
export function findOldRootRefs(
  file: string,
  text: string,
): { line: number; token: string }[] {
  const out: { line: number; token: string }[] = [];
  for (const m of text.matchAll(ROOT_REF)) {
    const prefix = m[1] ?? "";
    const tok = m[2]!.replace(/[.,:;]+$/, "");
    if (/^\.{1,2}\//.test(prefix)) {
      const target = posix.normalize(
        posix.join(posix.dirname(file), prefix, tok),
      );
      if (!/^(src|schema)\/|^vendor\/ocpp-schemas/.test(target)) continue;
    }
    out.push({ line: text.slice(0, m.index).split("\n").length, token: tok });
  }
  return out;
}

export interface Edit {
  start: number;
  end: number;
  text: string;
}

export interface RewriteStats {
  relativeToRelative: number;
  toPackage: number;
  aliasKept: number;
  pathStrings: number;
  textRefs: number;
}

export interface RewriteResult {
  text: string;
  stats: RewriteStats;
  /** Relative / aliased specifiers that resolve to no tracked file. */
  unresolved: string[];
  /** Old-root references that could not be mapped (file:line token). */
  unmapped: string[];
  /** Directory references mapped by "one destination wins". */
  ambiguous: string[];
}

function overlaps(edits: readonly Edit[], start: number, end: number): boolean {
  return edits.some((e) => start < e.end && e.start < end);
}

export interface RewriteOptions {
  /** Only markdown links are rewritten; prose is history (docs/log.md). */
  readonly linksOnly?: boolean;
}

export function rewriteFile(
  ctx: Ctx,
  oldFile: string,
  text: string,
  options: RewriteOptions = {},
): RewriteResult {
  const stats: RewriteStats = {
    relativeToRelative: 0,
    toPackage: 0,
    aliasKept: 0,
    pathStrings: 0,
    textRefs: 0,
  };
  const unresolved: string[] = [];
  const unmapped: string[] = [];
  const ambiguous: string[] = [];
  const edits: Edit[] = [];
  const moved = ctx.plan.moves.has(oldFile);
  const lineOf = (offset: number) => text.slice(0, offset).split("\n").length;

  // 1. Code: specifiers and path strings located with the TypeScript parser.
  if (isRewritableSource(oldFile) && !options.linksOnly) {
    for (const ref of collectSourceRefs(oldFile, text)) {
      if (ref.kind === "module") {
        const res = resolveModule(ctx, oldFile, ref.value);
        if (res && "unresolved" in res) {
          unresolved.push(`${oldFile}:${lineOf(ref.start)} "${ref.value}"`);
          continue;
        }
        const next = newSpecifier(ctx, oldFile, ref.value);
        if (!next) continue;
        if (next.text !== ref.value)
          edits.push({ start: ref.start, end: ref.end, text: next.text });
        if (next.kind === "package") stats.toPackage++;
        else if (next.kind === "alias") stats.aliasKept++;
        else stats.relativeToRelative++;
      } else if (ref.kind === "segments") {
        const mapped = mapTextToken(ctx, ref.value);
        if (!mapped) {
          unmapped.push(
            `${oldFile}:${lineOf(ref.start)} ${ref.value} (path segments)`,
          );
          continue;
        }
        if (mapped.text === ref.value) continue;
        const quote = text[ref.start]!;
        edits.push({
          start: ref.start,
          end: ref.end,
          text: mapped.text
            .split("/")
            .map((seg) => `${quote}${seg}${quote}`)
            .join(", "),
        });
        stats.pathStrings++;
      } else {
        const next = newPathString(ctx, oldFile, ref.value);
        if (next !== null && next !== ref.value) {
          edits.push({ start: ref.start, end: ref.end, text: next });
          stats.pathStrings++;
        }
      }
    }
  }

  // 2. Markdown links, resolved from the file's own directory.
  if (oldFile.endsWith(".md")) {
    const link = /(\]\(<?|^\s*\[[^\]]+\]:\s*<?)([^)>\s]+)/gm;
    for (const m of text.matchAll(link)) {
      const start = m.index! + m[1]!.length;
      const value = m[2]!;
      if (/^(#|[a-z][a-z0-9+.-]*:)/i.test(value)) continue;
      const next = newPathString(ctx, oldFile, value);
      if (next !== null && next !== value) {
        edits.push({ start, end: start + value.length, text: next });
        stats.pathStrings++;
      }
    }
  }

  // 3. Prose and config: repo paths that name a moved file or directory.
  if (!options.linksOnly) {
    for (const m of text.matchAll(ROOT_REF)) {
      const prefix = m[1] ?? "";
      let token = m[2]!;
      const trimmed = token.replace(/[.,:;]+$/, "");
      token = trimmed;
      const start = m.index! + prefix.length;
      const end = start + token.length;
      if (overlaps(edits, start, end)) continue;
      let repoPath = token;
      let relativePrefix = /^\.{1,2}\//.test(prefix);
      if (relativePrefix) {
        // Relative prefix: it must lead to the root path from this file. A
        // lone `./` that does not is relative to the working directory
        // instead (`bun --eval 'import "./src/cli/main.ts"'` run from the
        // repository root): treat it as a repo-rooted path and keep the `./`.
        const dir = posix.dirname(oldFile);
        const target = posix.normalize(posix.join(dir, prefix, token));
        const leadsToRoot =
          isUnderOldRoot(target) ||
          /^(src|schema)\/|^vendor\/ocpp-schemas/.test(target);
        const exists = ctx.files.has(target) || ctx.dirs.has(target);
        if (prefix === "./" ? !exists : !leadsToRoot) {
          if (prefix !== "./") continue;
          relativePrefix = false;
        } else {
          repoPath = target;
        }
      }
      const mapped = mapTextToken(ctx, repoPath);
      if (!mapped) {
        if (!namesSomethingHere(ctx, repoPath)) continue;
        unmapped.push(`${oldFile}:${lineOf(m.index!)} ${repoPath}`);
        continue;
      }
      if (mapped.ambiguous)
        ambiguous.push(
          `${oldFile}:${lineOf(m.index!)} ${repoPath} -> ${mapped.text}`,
        );
      let replacement = mapped.text;
      let editStart = start;
      if (relativePrefix) {
        // Rewrite prefix and path together as one relative path.
        const newFrom = posix.dirname(newLocation(ctx, oldFile));
        let rel = relativeTo(newFrom, mapped.text.replace(/\/$/, ""));
        if (rel === "") rel = ".";
        if (prefix.startsWith("./") && !rel.startsWith(".")) rel = "./" + rel;
        if (mapped.text.endsWith("/") && !rel.endsWith("/")) rel += "/";
        replacement = rel;
        editStart = m.index!;
      }
      if (replacement !== text.slice(editStart, end)) {
        edits.push({ start: editStart, end, text: replacement });
        stats.textRefs++;
      }
    }

    // 4. Relative paths inside a moved file that name something that did not
    //    move with it (docs, package.json, …): `../../docs/x.md` in a comment.
    if (moved) {
      for (const m of text.matchAll(REL_REF)) {
        const start = m.index!;
        const full = m[1]! + m[2]!;
        const end = start + full.length;
        if (overlaps(edits, start, end)) continue;
        const next = newPathString(ctx, oldFile, full);
        if (next !== null && next !== full) {
          edits.push({ start, end, text: next });
          stats.pathStrings++;
        }
      }
    }
  }

  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start))
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { text: out, stats, unresolved, unmapped, ambiguous };
}

/**
 * Whether a repo-rooted token that did not map still names our tree: the bare
 * root (`src/`) or a path whose second segment exists. `src/main/java/…` in a
 * SteVe note or a made-up `src/newdir/a.ts` in a test is somebody else's.
 */
function namesSomethingHere(ctx: Ctx, token: string): boolean {
  const parts = token.split("/").filter(Boolean);
  if (parts.length <= 1) return true;
  const second = parts.slice(0, 2).join("/");
  const head = parts[1]!;
  if (/[*{[?]/.test(head)) return true;
  return ctx.files.has(second) || ctx.dirs.has(second);
}

/** Map one repo-rooted token (possibly with globs / a trailing slash). */
export function mapTextToken(
  ctx: Ctx,
  token: string,
): { text: string; ambiguous: boolean } | null {
  const glob = token.search(/[*{[?]/);
  if (glob === -1) {
    const trailing = token.endsWith("/") ? "/" : "";
    const m = mapPath(ctx, token.replace(/\/+$/, ""));
    return m ? { text: m.path + trailing, ambiguous: m.ambiguous } : null;
  }
  const head = token.slice(0, glob);
  const slash = head.lastIndexOf("/");
  if (slash <= 0) return null;
  const m = mapPath(ctx, head.slice(0, slash));
  if (!m) return null;
  return { text: m.path + token.slice(slash), ambiguous: m.ambiguous };
}

// ---------------------------------------------------------------------------
// Running against the repository
// ---------------------------------------------------------------------------

const BINARY_OR_OPAQUE =
  /\.(png|jpe?g|gif|ico|icns|webp|woff2?|ttf|otf|pdf|zip|gz|tgz|wasm|lock|lockb)$/i;

/** Files whose text is never rewritten. */
export function isOpaqueFile(file: string): boolean {
  return (
    // This script and its test quote old paths on purpose, as test data.
    file === "scripts/workspaces-move.ts" ||
    file === "scripts/__tests__/workspacesMove.bun.test.ts" ||
    BINARY_OR_OPAQUE.test(file) ||
    file === "bun.lock" ||
    file.startsWith("vendor/ocpp-schemas/") ||
    file.startsWith("docs/images/") ||
    file.startsWith("public/")
  );
}

/** docs/log.md is an append-only history: only its links are kept working. */
export function isHistoryFile(file: string): boolean {
  return file === "docs/log.md";
}

export type Layout = "pre-move" | "moved" | "unknown";

export function detectLayout(files: readonly string[]): Layout {
  if (files.some(isUnderOldRoot)) return "pre-move";
  if (files.some((f) => f.startsWith("packages/") || f.startsWith("apps/")))
    return "moved";
  return "unknown";
}

function git(root: string, args: string[], input?: string): string {
  const r = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    input,
    maxBuffer: 1 << 28,
  });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

async function main(argv: string[]): Promise<number> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dryRun = argv.includes("--dry-run");
  const check = argv.includes("--check");
  const files = git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
  const layout = detectLayout(files);

  if (check) {
    if (layout === "pre-move") {
      console.log(
        "workspaces-move --check: pre-move layout (src/ is still tracked)",
      );
      return 0;
    }
    console.error(
      `workspaces-move --check: not the pre-move layout (${layout}); nothing to move`,
    );
    return 1;
  }
  if (layout === "moved") {
    console.log(
      "workspaces-move: the tree is already in the workspace layout (no tracked files under src/, vendor/ocpp-schemas/ or schema/). Nothing changed.",
    );
    return 0;
  }
  if (layout === "unknown") {
    console.error("workspaces-move: neither the old nor the new layout found");
    return 1;
  }
  if (!dryRun) {
    const dirty = git(root, ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty.trim() !== "") {
      console.error(
        "workspaces-move: tracked files have uncommitted changes; commit or stash first so the output is exactly the script's:\n" +
          dirty,
      );
      return 1;
    }
  }

  return await execute(root, files, dryRun);
}

async function execute(
  root: string,
  files: string[],
  dryRun: boolean,
): Promise<number> {
  // Loaded here, not at the top: after the move the checker no longer exports
  // the old map and this file must still run far enough to say so.
  const loaded = (await import("./check-package-boundaries.ts")) as unknown as {
    PACKAGE_MAP: readonly MapLike[];
    packageOf: (file: string, map?: readonly MapLike[]) => string | null;
  };
  const { PACKAGE_MAP, packageOf } = loaded;
  const plan = planMoves(
    files,
    (f) => packageOf(f, PACKAGE_MAP as never),
    PACKAGE_MAP,
  );
  if (plan.unplaced.length || plan.collisions.length) {
    for (const f of plan.unplaced)
      console.error(`no destination for tracked file: ${f}`);
    for (const c of plan.collisions)
      console.error(`destination collision: ${c}`);
    return 1;
  }
  const ctx = makeCtx(files, plan);

  // Compute every new content from the OLD tree before touching anything.
  const total: RewriteStats = {
    relativeToRelative: 0,
    toPackage: 0,
    aliasKept: 0,
    pathStrings: 0,
    textRefs: 0,
  };
  const results = new Map<string, string>();
  const unresolved: string[] = [];
  const unmapped: string[] = [];
  const ambiguous: string[] = [];
  let historyCount = 0;
  for (const file of [...files].sort()) {
    if (isOpaqueFile(file)) continue;
    const abs = join(root, file);
    let text: string;
    try {
      const buf = readFileSync(abs);
      if (buf.includes(0)) continue;
      text = buf.toString("utf8");
    } catch {
      continue;
    }
    const r = rewriteFile(ctx, file, text, { linksOnly: isHistoryFile(file) });
    if (isHistoryFile(file))
      historyCount = findOldRootRefs(file, r.text).length;
    for (const k of Object.keys(total) as (keyof RewriteStats)[])
      total[k] += r.stats[k];
    unresolved.push(...r.unresolved);
    unmapped.push(...r.unmapped);
    ambiguous.push(...r.ambiguous);
    if (r.text !== text) results.set(file, r.text);
  }

  const lines: string[] = [];
  for (const [from, to] of plan.moves) lines.push(`${from} -> ${to}`);
  if (dryRun) console.log(lines.join("\n"));

  if (!dryRun) {
    for (const [from, to] of plan.moves) {
      mkdirSync(join(root, dirname(to)), { recursive: true });
      git(root, ["mv", from, to]);
    }
    const touched: string[] = [];
    for (const [file, text] of results) {
      const dest = plan.moves.get(file) ?? file;
      writeFileSync(join(root, dest), text);
      touched.push(dest);
    }
    if (touched.length) {
      git(
        root,
        ["add", "--pathspec-from-file=-", "--pathspec-file-nul"],
        touched.join("\0"),
      );
    }
  }

  console.log(`\n${dryRun ? "would move" : "moved"} ${plan.moves.size} files:`);
  for (const [pkg, n] of [...plan.perPackage].sort())
    console.log(`  ${(PACKAGE_DIRS[pkg] ?? pkg).padEnd(22)} ${n}`);
  console.log(`rewrote content of ${results.size} files:`);
  console.log(
    `  specifiers  relative -> relative : ${total.relativeToRelative}`,
  );
  console.log(`              -> package specifier : ${total.toPackage}`);
  console.log(`              alias (@/) kept      : ${total.aliasKept}`);
  console.log(
    `  path strings (URL / join / md links / reference): ${total.pathStrings}`,
  );
  console.log(
    `  text references (prose, config, comments)       : ${total.textRefs}`,
  );
  if (historyCount)
    console.log(
      `left ${historyCount} old-path mentions in docs/log.md untouched (append-only history)`,
    );
  if (ambiguous.length) {
    console.log(
      `\ndirectory references split between packages (best guess applied, review):`,
    );
    for (const a of ambiguous) console.log(`  ${a}`);
  }
  if (unresolved.length) {
    console.log(
      `\nrelative specifiers that resolve to no tracked file (left as is):`,
    );
    for (const u of unresolved) console.log(`  ${u}`);
  }
  if (unmapped.length) {
    console.log(`\nUNMAPPED old-root references (fix by hand):`);
    for (const u of unmapped) console.log(`  ${u}`);
  }
  // Second look at the rewritten text: anything that still names an old root.
  const leftovers: string[] = [];
  for (const [file, text] of results) {
    if (isHistoryFile(file)) continue;
    const dest = plan.moves.get(file) ?? file;
    for (const r of findOldRootRefs(dest, text)) {
      if (!namesSomethingHere(ctx, r.token)) continue;
      const entry = `${dest}:${r.line} ${r.token}`;
      if (
        !unmapped.some(
          (u) => u.endsWith(` ${r.token}`) && u.startsWith(file + ":"),
        )
      )
        leftovers.push(entry);
    }
  }
  if (leftovers.length) {
    console.log(`\nold-root references still present after the rewrite:`);
    for (const l of leftovers) console.log(`  ${l}`);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
