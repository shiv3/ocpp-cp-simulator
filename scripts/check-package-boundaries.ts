// scripts/check-package-boundaries.ts
//
// Executable form of the package dependency rules from #578.
//
// The repository is a Bun workspace: packages/* hold the portable code and
// apps/* the two programs built from it. This script is the definition of the
// boundaries between them: PACKAGE_MAP says which package every file belongs
// to, ALLOWED_DEPENDENCIES says which package may import which,
// FORBIDDEN_SPECIFIERS keeps the portable packages free of UI frameworks and
// runtime-specific built-ins, and each package's package.json has to declare
// exactly the `workspace:*` dependencies its imports need.
//
//   bun run check:boundaries                 # exit 1 on any violation
//   bun run check:boundaries --json          # the full package x package edge matrix
//   bun run check:boundaries --list core     # files mapped to one package
//
// Across packages an import must name the package
// (`@ocpp-cp-simulator/core/cp/domain/...`, resolved through the package's
// `exports`), never a relative path into another package. TypeScript project
// references forbid cycles at the type level too, so `import type`,
// `export type ... from` and `import("x").T` count as edges exactly like
// value imports.
//
// Files must not import each other in a cycle either (#570). That rule counts
// only the imports that stay in the compiled code: a cycle of types disappears
// at compile time, and `import()` is how a cycle is legitimately deferred. It
// relies on the `consistent-type-imports` lint rule to mark an import used only
// as a type, or the cycle it closes would be reported as a real one.
//
// Inside packages/core/src/cp the layers have a direction too (#571):
// domain may import only domain and shared; application may import domain,
// application and shared (never infrastructure); infrastructure may import
// every layer; shared imports only shared. Every layer may use the other
// workspace packages the package rules above allow. LAYER_EXEMPTIONS lists
// the edges let through; it is empty since #575, and an entry that stops
// matching fails the run. Tests are not checked.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

export const PACKAGE_NAMES = [
  "ocpp",
  "contracts",
  "trace",
  "k6-runtime",
  "core",
  "client",
  "apps/cli",
  "apps/web",
] as const;
export type PackageName = (typeof PACKAGE_NAMES)[number];

export interface MapEntry {
  /**
   * Repo-relative, forward slashes. A trailing "/" is a directory prefix;
   * anything else is one exact file.
   */
  readonly match: string;
  readonly pkg: PackageName;
  /** Why the path lives in that package. Only needed where it is not obvious. */
  readonly why?: string;
}

/** Workspace directory of each package. */
export const PACKAGE_DIRS: Readonly<Record<PackageName, string>> = {
  ocpp: "packages/ocpp",
  contracts: "packages/contracts",
  trace: "packages/trace",
  "k6-runtime": "packages/k6-runtime",
  core: "packages/core",
  client: "packages/client",
  "apps/cli": "apps/cli",
  "apps/web": "apps/web",
};

/** `@ocpp-cp-simulator/<dir name>`: the name a package is imported and declared by. */
export function packageNameOf(pkg: PackageName): string {
  return `@ocpp-cp-simulator/${PACKAGE_DIRS[pkg].split("/")[1]}`;
}

/**
 * Which package each path belongs to: one entry per workspace directory. The
 * FIRST matching entry wins; `validatePackageMap` rejects an entry that a
 * broader earlier entry would swallow. Every .ts/.tsx file under packages/ or
 * apps/ must match an entry (the checker fails on a file that matches none),
 * so a new workspace directory has to be registered here on purpose.
 *
 * What lives where (the reasons the files were placed this way):
 * - packages/ocpp: generated message types, validators and the vendored OCA
 *   schemas.
 * - packages/contracts: the wire/RPC vocabulary shared by daemon and clients.
 * - packages/trace: the trace format reader/writer.
 * - packages/k6-runtime: dependency-free files copied verbatim into an
 *   export; runtimeManifest.test.ts enforces that they import nothing outside
 *   themselves.
 * - packages/core: the charge point engine, the scenario engine and what they
 *   need (scenario templates and their JSON, blueprints, the WebCrypto
 *   ambient types, the test helpers every package's tests share).
 * - packages/client: how a UI or tool talks to a daemon or to an in-process
 *   engine.
 * - apps/cli: the CLI, the daemon, the MCP endpoint, export-k6, analyze, and
 *   the tests that build the CLI bundle and the Tauri sidecar.
 * - apps/web: the browser console and everything only it uses.
 */
export const PACKAGE_MAP: readonly MapEntry[] = [
  { match: "packages/ocpp/", pkg: "ocpp" },
  { match: "packages/contracts/", pkg: "contracts" },
  { match: "packages/trace/", pkg: "trace" },
  { match: "packages/k6-runtime/", pkg: "k6-runtime" },
  { match: "packages/core/", pkg: "core" },
  { match: "packages/client/", pkg: "client" },
  { match: "apps/cli/", pkg: "apps/cli" },
  { match: "apps/web/", pkg: "apps/web" },
];

/** Repo-internal dependencies each package may have (besides itself). */
export const ALLOWED_DEPENDENCIES: Readonly<
  Record<PackageName, readonly PackageName[]>
> = {
  ocpp: [],
  contracts: [],
  trace: [],
  "k6-runtime": [],
  core: ["ocpp", "contracts", "trace", "k6-runtime"],
  client: ["core", "contracts", "ocpp", "trace"],
  "apps/cli": ["ocpp", "contracts", "trace", "k6-runtime", "core", "client"],
  "apps/web": ["ocpp", "contracts", "trace", "k6-runtime", "core", "client"],
};

// ---------------------------------------------------------------------------
// Forbidden specifiers
// ---------------------------------------------------------------------------

/** Packages that must run in both Bun and the browser. */
export const PORTABLE_PACKAGES: ReadonlySet<PackageName> = new Set([
  "ocpp",
  "contracts",
  "trace",
  "k6-runtime",
  "core",
  "client",
]);

export interface SpecifierRule {
  readonly id: string;
  readonly describe: string;
  readonly test: (specifier: string) => boolean;
}

// A fixed list rather than `module.builtinModules`: under Bun that list also
// contains npm packages Bun bundles (`ws`, `undici`) and `bun` itself.
const NODE_BUILTINS: ReadonlySet<string> = new Set(
  (
    "assert async_hooks buffer child_process cluster console constants crypto " +
    "dgram diagnostics_channel dns domain events fs http http2 https inspector " +
    "module net os path perf_hooks process punycode querystring readline repl " +
    "stream string_decoder sys timers tls trace_events tty url util v8 vm " +
    "wasi worker_threads zlib"
  ).split(" "),
);

export const FORBIDDEN_SPECIFIERS: readonly SpecifierRule[] = [
  {
    id: "react",
    describe: "React (any package whose name has a `react` part)",
    test: (s) => /(^|[-/@])react([-/]|$)/.test(s),
  },
  { id: "jotai", describe: "jotai", test: (s) => /^jotai(\/|$)/.test(s) },
  { id: "zustand", describe: "zustand", test: (s) => /^zustand(\/|$)/.test(s) },
  {
    id: "xyflow",
    describe: "@xyflow/*",
    test: (s) => s.startsWith("@xyflow/"),
  },
  {
    id: "radix",
    describe: "@radix-ui/*",
    test: (s) => s.startsWith("@radix-ui/"),
  },
  {
    id: "vite-query",
    describe: "Vite-only `?url` / `?raw` / `?worker` suffix",
    test: (s) => /\?(url|raw|worker|inline)\b/.test(s),
  },
  {
    id: "vite-virtual",
    describe: "Vite virtual module",
    test: (s) => s.startsWith("virtual:"),
  },
  { id: "bun", describe: "bun:* built-in", test: (s) => s.startsWith("bun:") },
  {
    id: "node",
    describe: "node:* / Node built-in",
    test: (s) =>
      s.startsWith("node:") || NODE_BUILTINS.has(s.split("/")[0] ?? s),
  },
];

/**
 * The only portable-package files allowed to import a forbidden specifier,
 * with the specifiers each may import and the reason. Keep this list short and
 * explain every entry: it is the inventory of runtime-specific code the
 * workspace move has to keep out of browser bundles.
 *
 * Only value imports are checked. A type-only import is erased at build time
 * and cannot break a Bun or browser run; the checker lists them under
 * `typeOnlyForbidden` in `--json` so the move can see which packages still
 * need a type dependency.
 */
export const SPECIFIER_ALLOW_LIST: Readonly<
  Record<
    string,
    { readonly specifiers: readonly string[]; readonly why: string }
  >
> = {
  "packages/core/src/cp/infrastructure/persistence/BunSqliteDatabase.ts": {
    specifiers: ["bun:sqlite", "node:path", "node:fs"],
    why: "The Bun-only Database implementation behind the daemon's state file. Never reached from the browser bundle (browserBundleNoDaemonXml.bun.test.ts guards that); the web console uses SqlJsDatabase instead.",
  },
};

// ---------------------------------------------------------------------------
// Known exceptions
// ---------------------------------------------------------------------------

/**
 * Edges that are wrong but too large to fix in the PR that introduced the
 * check. Matching violations are printed as warnings and do not fail the run.
 * Each entry needs the importing file, the imported file and a reason. Keep it
 * empty if at all possible.
 */
export interface KnownViolation {
  readonly from: string;
  readonly to: string;
  readonly why: string;
}
export const KNOWN_VIOLATIONS: readonly KnownViolation[] = [];

/**
 * Test files that may cross a boundary their package may not, for the case
 * where moving the test next to the code that owns the dependency is not
 * sensible. Same shape as KNOWN_VIOLATIONS; a separate list so production
 * debt and test debt do not mix.
 */
export const TEST_ALLOW_LIST: readonly KnownViolation[] = [
  {
    from: "packages/core/src/cp/infrastructure/transport/__tests__/OCPPMessageHandler.settlement.test.ts",
    to: "apps/cli/src/server/metrics/MetricsRecorder.ts",
    why: "One case (#302) pins the exact watchdog log line the daemon's Prometheus recorder parses: it drives the real transport watchdog with this file's fake socket and asserts the recorder's counter moves. The wording is the contract between the two packages, so the test needs both sides; moving it would mean copying the whole fake socket into apps/cli.",
  },
];

// ---------------------------------------------------------------------------
// Layers inside packages/core/src/cp (#571)
// ---------------------------------------------------------------------------

export const CP_ROOT = "packages/core/src/cp/";
export const LAYERS = [
  "domain",
  "application",
  "infrastructure",
  "shared",
] as const;
export type Layer = (typeof LAYERS)[number];

/**
 * Which layers each layer may import (itself always included). An import of a
 * file under packages/core/src outside src/cp, or of an app, is also refused
 * from domain and shared: those layers know nothing of the code around them.
 */
export const LAYER_RULES: Readonly<Record<Layer, readonly Layer[]>> = {
  domain: ["domain", "shared"],
  application: ["domain", "application", "shared"],
  infrastructure: ["domain", "application", "infrastructure", "shared"],
  shared: ["shared"],
};

/** Layers that may not import core code outside src/cp. */
const SEALED_LAYERS: ReadonlySet<Layer> = new Set<Layer>(["domain", "shared"]);

export function layerOf(file: string): Layer | null {
  if (!file.startsWith(CP_ROOT)) return null;
  const top = file.slice(CP_ROOT.length).split("/")[0];
  return (LAYERS as readonly string[]).includes(top!) ? (top as Layer) : null;
}

/**
 * Layer-breaking imports let through, one entry per importing file and
 * imported file. Matching violations are printed as warnings and do not fail
 * the run; an entry that matches nothing fails it. The list is empty since
 * #575 (#577's goal): a new entry needs a reason in `why` and the issue that
 * removes it. Tests are not covered by the rule.
 */
export const LAYER_EXEMPTIONS: readonly KnownViolation[] = [];

// ---------------------------------------------------------------------------
// Machinery
// ---------------------------------------------------------------------------

export interface Config {
  readonly map: readonly MapEntry[];
  readonly allowed: Readonly<Record<PackageName, readonly PackageName[]>>;
  readonly portable: ReadonlySet<PackageName>;
  readonly specifierRules: readonly SpecifierRule[];
  readonly specifierAllowList: typeof SPECIFIER_ALLOW_LIST;
  readonly knownViolations: readonly KnownViolation[];
  readonly testAllowList: readonly KnownViolation[];
  readonly layerExemptions: readonly KnownViolation[];
  /** Alias prefix -> repo-relative directory, e.g. "@/" -> "apps/web/src/". */
  readonly aliases: Readonly<Record<string, string>>;
}

export const DEFAULT_CONFIG: Config = {
  map: PACKAGE_MAP,
  allowed: ALLOWED_DEPENDENCIES,
  portable: PORTABLE_PACKAGES,
  specifierRules: FORBIDDEN_SPECIFIERS,
  specifierAllowList: SPECIFIER_ALLOW_LIST,
  knownViolations: KNOWN_VIOLATIONS,
  testAllowList: TEST_ALLOW_LIST,
  layerExemptions: LAYER_EXEMPTIONS,
  aliases: { "@/": "apps/web/src/" },
};

/**
 * The `@/*` alias from a tsconfig's `compilerOptions.paths`. vite.config.ts
 * and apps/web/tsconfig.json both map "@" to apps/web/src; reading it from the
 * tsconfig keeps this script from drifting if that ever changes. `paths`
 * targets are relative to the tsconfig's directory, `baseDir` (repo-relative).
 */
export function readAliases(
  tsconfigText: string,
  baseDir = "",
): Record<string, string> {
  const parsed = ts.parseConfigFileTextToJson("tsconfig.json", tsconfigText);
  const paths = (parsed.config?.compilerOptions?.paths ?? {}) as Record<
    string,
    string[]
  >;
  const out: Record<string, string> = {};
  for (const [key, targets] of Object.entries(paths)) {
    const target = targets[0];
    if (!key.endsWith("/*") || !target?.endsWith("/*")) continue;
    out[key.slice(0, -1)] = posix.normalize(
      posix.join(baseDir, target.slice(0, -1)) + "/",
    );
  }
  return out;
}

export function packageOf(
  file: string,
  map: readonly MapEntry[] = PACKAGE_MAP,
): PackageName | null {
  for (const e of map) {
    if (e.match.endsWith("/") ? file.startsWith(e.match) : file === e.match) {
      return e.pkg;
    }
  }
  return null;
}

/** Throws when an entry is unreachable because a broader earlier one wins. */
export function validatePackageMap(map: readonly MapEntry[]): void {
  map.forEach((later, j) => {
    for (let i = 0; i < j; i++) {
      const earlier = map[i]!;
      const covers = earlier.match.endsWith("/")
        ? later.match.startsWith(earlier.match)
        : later.match === earlier.match;
      if (covers) {
        throw new Error(
          `PACKAGE_MAP: "${later.match}" is shadowed by earlier "${earlier.match}"; list the most specific entry first`,
        );
      }
    }
  });
}

export function isTestFile(file: string): boolean {
  return (
    /\.test\.tsx?$/.test(file) ||
    /(^|\/)__tests__\//.test(file) ||
    /^(packages|apps)\/[^/]+\/src\/test\//.test(file) ||
    file.startsWith("apps/web/src/console/test/")
  );
}

export type ImportKind =
  | "import"
  | "import-type"
  | "side-effect"
  | "export-from"
  | "export-type-from"
  | "dynamic"
  | "import-type-node"
  | "require"
  | "new-url";

export interface RawImport {
  readonly specifier: string;
  readonly kind: ImportKind;
  readonly typeOnly: boolean;
}

/** Every module specifier a source file refers to, type-only ones included. */
export function extractImports(file: string, text: string): RawImport[] {
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: RawImport[] = [];
  const str = (n: ts.Node | undefined): string | null =>
    n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
      ? n.text
      : null;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const spec = str(node.moduleSpecifier);
      if (spec !== null) {
        const clause = node.importClause;
        let typeOnly = false;
        let kind: ImportKind = "import";
        if (!clause) kind = "side-effect";
        else if (clause.isTypeOnly) typeOnly = true;
        else if (
          !clause.name &&
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((e) => e.isTypeOnly)
        ) {
          typeOnly = true;
        }
        out.push({
          specifier: spec,
          kind: typeOnly ? "import-type" : kind,
          typeOnly,
        });
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const spec = str(node.moduleSpecifier);
      if (spec !== null) {
        const typeOnly =
          node.isTypeOnly ||
          (!!node.exportClause &&
            ts.isNamedExports(node.exportClause) &&
            node.exportClause.elements.length > 0 &&
            node.exportClause.elements.every((e) => e.isTypeOnly));
        out.push({
          specifier: spec,
          kind: typeOnly ? "export-type-from" : "export-from",
          typeOnly,
        });
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const spec = str(node.moduleReference.expression);
      if (spec !== null)
        out.push({
          specifier: spec,
          kind: "require",
          typeOnly: node.isTypeOnly,
        });
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const spec = str(node.arguments[0]);
        if (spec !== null)
          out.push({ specifier: spec, kind: "dynamic", typeOnly: false });
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      ) {
        const spec = str(node.arguments[0]);
        if (spec !== null)
          out.push({ specifier: spec, kind: "require", typeOnly: false });
      }
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) {
        const spec = str(node.argument.literal);
        if (spec !== null)
          out.push({
            specifier: spec,
            kind: "import-type-node",
            typeOnly: true,
          });
      }
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      node.arguments?.length === 2 &&
      ts.isPropertyAccessExpression(node.arguments[1]!) &&
      node.arguments[1]!.getText(sf) === "import.meta.url"
    ) {
      const spec = str(node.arguments[0]);
      if (spec !== null && spec.startsWith("."))
        out.push({ specifier: spec, kind: "new-url", typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const RESOLVE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".d.ts",
  ".json",
  "/index.ts",
  "/index.tsx",
];

export interface PackageManifest {
  /** Repo-relative workspace directory. */
  readonly dir: string;
  readonly name?: string;
  readonly private?: boolean;
  readonly exports?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
}

/** What `exports` is when a manifest is not at hand: the "./*" convention. */
const DEFAULT_EXPORTS: Readonly<Record<string, string>> = {
  "./*": "./src/*.ts",
};

/**
 * The file a package subpath (`./cp/domain/x`) maps to under `exports`: an
 * exact key first, then the pattern with the longest prefix before its `*`.
 * Returns the target relative to the package directory, or null.
 */
export function resolveExport(
  exportsMap: Readonly<Record<string, string>>,
  subpath: string,
): string | null {
  const exact = exportsMap[subpath];
  if (typeof exact === "string") return exact;
  let best: { key: string; prefix: number } | null = null;
  for (const key of Object.keys(exportsMap)) {
    const star = key.indexOf("*");
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      subpath.length >= key.length - 1 &&
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      (!best || prefix.length > best.prefix)
    )
      best = { key, prefix: prefix.length };
  }
  if (!best) return null;
  const star = best.key.indexOf("*");
  const matched = subpath.slice(
    star,
    subpath.length - (best.key.length - star - 1),
  );
  return exportsMap[best.key]!.replace("*", matched);
}

const PACKAGE_SPECIFIER = /^(@ocpp-cp-simulator\/[^/]+)(?:\/(.*))?$/;

export interface Resolution {
  readonly path: string;
  /** The specifier named a workspace package (`@ocpp-cp-simulator/x/...`). */
  readonly viaPackage: boolean;
}

/**
 * Repo-relative path a specifier points to, or null for a bare third-party
 * package. `known` is the set of every file that exists; `packages` the
 * workspace manifests by name (defaults to the "./*" convention for every
 * package in PACKAGE_DIRS). Throws-free: returns `{ unresolved }` when a
 * relative, aliased or workspace specifier hits nothing.
 */
export function resolveSpecifier(
  fromFile: string,
  specifier: string,
  known: ReadonlySet<string>,
  aliases: Readonly<Record<string, string>>,
  packages?: ReadonlyMap<string, PackageManifest>,
): Resolution | { unresolved: string } | null {
  const clean = specifier.replace(/\?.*$/, "");
  const ws = PACKAGE_SPECIFIER.exec(clean);
  if (ws) {
    const name = ws[1]!;
    const manifest: PackageManifest | undefined =
      packages?.get(name) ??
      (() => {
        const hit = (Object.keys(PACKAGE_DIRS) as PackageName[]).find(
          (p) => packageNameOf(p) === name,
        );
        return hit ? { dir: PACKAGE_DIRS[hit] } : undefined;
      })();
    if (!manifest) return { unresolved: clean };
    const target = resolveExport(
      manifest.exports ?? DEFAULT_EXPORTS,
      ws[2] ? `./${ws[2]}` : ".",
    );
    if (target === null) return { unresolved: clean };
    const path = posix.normalize(posix.join(manifest.dir, target));
    return known.has(path) ? { path, viaPackage: true } : { unresolved: clean };
  }
  let base: string | null = null;
  if (clean.startsWith(".")) {
    base = posix.normalize(posix.join(posix.dirname(fromFile), clean));
  } else {
    for (const [prefix, dir] of Object.entries(aliases)) {
      if (clean.startsWith(prefix)) {
        base = posix.normalize(dir + clean.slice(prefix.length));
        break;
      }
    }
  }
  if (base === null) return null;
  const trimmed = base.replace(/\/$/, "");
  const candidates = [
    ...RESOLVE_SUFFIXES.map((s) => trimmed + s),
    // TypeScript lets `./x.js` stand for `./x.ts`.
    ...(/\.jsx?$/.test(trimmed)
      ? [trimmed.replace(/\.js$/, ".ts"), trimmed.replace(/\.jsx$/, ".tsx")]
      : []),
  ];
  for (const c of candidates)
    if (known.has(c)) return { path: c, viaPackage: false };
  return { unresolved: base };
}

export interface Edge {
  readonly from: string;
  readonly to: string;
  readonly fromPkg: PackageName;
  readonly toPkg: PackageName;
  readonly specifier: string;
  readonly kind: ImportKind;
  readonly typeOnly: boolean;
  readonly test: boolean;
  /** Imported through `@ocpp-cp-simulator/<package>/...` rather than by path. */
  readonly viaPackage: boolean;
}

export interface Violation {
  readonly type: "edge" | "specifier" | "relative" | "layer";
  /** "client → apps/web" for an edge, "core ⊅ node" for a specifier. */
  readonly group: string;
  readonly file: string;
  readonly target: string;
  readonly specifier: string;
  readonly typeOnly: boolean;
  readonly test: boolean;
  readonly message: string;
}

export interface Report {
  readonly violations: Violation[];
  /** Violations suppressed by KNOWN_VIOLATIONS / TEST_ALLOW_LIST. */
  readonly warnings: Violation[];
  readonly unmapped: string[];
  readonly unresolved: { file: string; specifier: string }[];
  readonly matrix: Record<string, Record<string, number>>;
  readonly fileCounts: Record<string, number>;
  /** Type-only imports of a forbidden specifier from a portable package. */
  readonly typeOnlyForbidden: {
    file: string;
    specifier: string;
    rule: string;
  }[];
  /** Allow-list entries that no longer match anything. */
  readonly staleAllowances: string[];
  /** Package manifests that do not match the imports (see checkManifests). */
  readonly manifestProblems: string[];
  /** Groups of files that import each other (see findImportCycles). */
  readonly cycles: string[][];
  readonly edges: Edge[];
}

export interface Snapshot {
  /** Repo-relative path -> text, for every .ts/.tsx file to check. */
  readonly sources: ReadonlyMap<string, string>;
  /** Every other file that may be an import target (json, css, svg, ...). */
  readonly others: ReadonlySet<string>;
  /**
   * The workspace manifests (`<dir>/package.json`) by package. When present
   * they resolve `@ocpp-cp-simulator/...` specifiers through their real `exports`
   * and are checked against the imports; without them the "./*" convention
   * is assumed and no manifest is checked.
   */
  readonly manifests?: ReadonlyMap<PackageName, PackageManifest>;
  /** The root package.json text: it must not depend on a workspace package. */
  readonly rootManifestText?: string;
}

/**
 * The rule a core file breaks by importing `to`, or null. Only files under
 * packages/core/src/cp/<layer>/ are judged; `to` is the resolved target.
 */
export function layerViolationOf(
  from: string,
  to: string,
): { group: string } | null {
  const a = layerOf(from);
  if (!a) return null;
  const b = layerOf(to);
  if (b) {
    return LAYER_RULES[a].includes(b) ? null : { group: `layer ${a} ⊅ ${b}` };
  }
  if (
    SEALED_LAYERS.has(a) &&
    (to.startsWith("apps/") ||
      (to.startsWith("packages/core/") && !to.startsWith(CP_ROOT)) ||
      (to.startsWith(CP_ROOT) && !b))
  )
    return { group: `layer ${a} ⊅ code outside the layers` };
  return null;
}

export function checkBoundaries(
  snapshot: Snapshot,
  config: Config = DEFAULT_CONFIG,
): Report {
  validatePackageMap(config.map);
  const packageByName = snapshot.manifests
    ? new Map(
        [...snapshot.manifests].map(([pkg, m]) => [packageNameOf(pkg), m]),
      )
    : undefined;
  const known = new Set<string>([
    ...snapshot.sources.keys(),
    ...snapshot.others,
  ]);
  const violations: Violation[] = [];
  const warnings: Violation[] = [];
  const unmapped: string[] = [];
  const unresolved: { file: string; specifier: string }[] = [];
  const edges: Edge[] = [];
  const typeOnlyForbidden: Report["typeOnlyForbidden"] = [];
  const matrix: Record<string, Record<string, number>> = {};
  const fileCounts: Record<string, number> = {};
  const usedAllowances = new Set<string>();
  for (const p of PACKAGE_NAMES) {
    matrix[p] = Object.fromEntries(PACKAGE_NAMES.map((q) => [q, 0]));
    fileCounts[p] = 0;
  }

  const suppressLayer = (v: Violation): boolean => {
    const hit = config.layerExemptions.find(
      (k) => k.from === v.file && k.to === v.target,
    );
    if (hit) usedAllowances.add(`layer:${hit.from}->${hit.to}`);
    return !!hit;
  };

  const suppress = (v: Violation): boolean => {
    const list = v.test ? config.testAllowList : config.knownViolations;
    const hit = list.find((k) => k.from === v.file && k.to === v.target);
    if (hit)
      usedAllowances.add(`${v.test ? "test" : "known"}:${hit.from}->${hit.to}`);
    return !!hit;
  };

  for (const [file, text] of [...snapshot.sources].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    const fromPkg = packageOf(file, config.map);
    if (!fromPkg) {
      unmapped.push(file);
      continue;
    }
    fileCounts[fromPkg]!++;
    const test = isTestFile(file);
    const allowedSpecs = config.specifierAllowList[file];

    for (const imp of extractImports(file, text)) {
      // Forbidden specifiers: portable packages, non-test files, value imports.
      if (config.portable.has(fromPkg) && !test) {
        const rule = config.specifierRules.find((r) => r.test(imp.specifier));
        if (rule) {
          if (imp.typeOnly) {
            typeOnlyForbidden.push({
              file,
              specifier: imp.specifier,
              rule: rule.id,
            });
          } else if (allowedSpecs?.specifiers.includes(imp.specifier)) {
            usedAllowances.add(`spec:${file}:${imp.specifier}`);
          } else {
            violations.push({
              type: "specifier",
              group: `${fromPkg} ⊅ ${rule.id}`,
              file,
              target: imp.specifier,
              specifier: imp.specifier,
              typeOnly: false,
              test,
              message: `${file} imports "${imp.specifier}" (${rule.describe}); ${fromPkg} must run in Bun and the browser`,
            });
          }
        }
      }

      const res = resolveSpecifier(
        file,
        imp.specifier,
        known,
        config.aliases,
        packageByName,
      );
      if (res === null) continue;
      if ("unresolved" in res) {
        // `new URL("../..", import.meta.url)` in tests names directories and
        // docs; only a missing file under a package's src/ is a real problem.
        if (
          imp.kind === "new-url" &&
          !/^(packages|apps)\/[^/]+\/src\//.test(res.unresolved)
        )
          continue;
        if (imp.kind === "new-url" && !/\.[a-z]+$/.test(res.unresolved))
          continue;
        unresolved.push({ file, specifier: imp.specifier });
        continue;
      }
      const toPkg = packageOf(res.path, config.map);
      if (!toPkg) {
        // A file outside the map (package.json, scripts/, ...): not a package edge.
        if (/^(packages|apps)\//.test(res.path)) unmapped.push(res.path);
        continue;
      }
      edges.push({
        from: file,
        to: res.path,
        fromPkg,
        toPkg,
        specifier: imp.specifier,
        kind: imp.kind,
        typeOnly: imp.typeOnly,
        test,
        viaPackage: res.viaPackage,
      });
      matrix[fromPkg]![toPkg]!++;
      const layerViolation = test ? null : layerViolationOf(file, res.path);
      if (layerViolation) {
        const v: Violation = {
          type: "layer",
          group: layerViolation.group,
          file,
          target: res.path,
          specifier: imp.specifier,
          typeOnly: imp.typeOnly,
          test,
          message: `${file} imports ${res.path}${imp.typeOnly ? " (type-only)" : ""}`,
        };
        (suppressLayer(v) ? warnings : violations).push(v);
      }
      if (fromPkg !== toPkg && !config.allowed[fromPkg].includes(toPkg)) {
        const v: Violation = {
          type: "edge",
          group: `${fromPkg} → ${toPkg}`,
          file,
          target: res.path,
          specifier: imp.specifier,
          typeOnly: imp.typeOnly,
          test,
          message: `${file} imports ${res.path}${imp.typeOnly ? " (type-only)" : ""}`,
        };
        (suppress(v) ? warnings : violations).push(v);
      } else if (
        fromPkg !== toPkg &&
        !res.viaPackage &&
        imp.kind !== "new-url"
      ) {
        // Allowed edge, wrong spelling: the workspace link, not a path.
        violations.push({
          type: "relative",
          group: `${fromPkg} → ${toPkg} (by path)`,
          file,
          target: res.path,
          specifier: imp.specifier,
          typeOnly: imp.typeOnly,
          test,
          message: `${file} reaches into ${res.path} with "${imp.specifier}"; import it as ${packageNameOf(toPkg)}/<path under src>`,
        });
      }
    }
  }

  const staleAllowances: string[] = [];
  for (const k of config.knownViolations)
    if (!usedAllowances.has(`known:${k.from}->${k.to}`))
      staleAllowances.push(`KNOWN_VIOLATIONS ${k.from} -> ${k.to}`);
  for (const k of config.layerExemptions)
    if (!usedAllowances.has(`layer:${k.from}->${k.to}`))
      staleAllowances.push(`LAYER_EXEMPTIONS ${k.from} -> ${k.to}`);
  for (const k of config.testAllowList)
    if (!usedAllowances.has(`test:${k.from}->${k.to}`))
      staleAllowances.push(`TEST_ALLOW_LIST ${k.from} -> ${k.to}`);
  for (const [f, a] of Object.entries(config.specifierAllowList))
    for (const s of a.specifiers)
      if (!usedAllowances.has(`spec:${f}:${s}`))
        staleAllowances.push(`SPECIFIER_ALLOW_LIST ${f} "${s}"`);

  return {
    violations,
    warnings,
    manifestProblems: checkManifests(snapshot, edges, violations),
    unmapped: [...new Set(unmapped)].sort(),
    unresolved,
    matrix,
    fileCounts,
    typeOnlyForbidden,
    staleAllowances,
    cycles: findImportCycles(edges),
    edges,
  };
}

/** The import kinds a module needs loaded before it can run. */
const CYCLE_EDGE_KINDS: ReadonlySet<ImportKind> = new Set<ImportKind>([
  "import",
  "side-effect",
  "export-from",
  "require",
]);

/**
 * Every group of files that reach each other through static value imports
 * (the strongly connected components of that graph, by Tarjan's algorithm), a
 * lone file only if it imports itself. Each group and the list are sorted.
 */
export function findImportCycles(edges: readonly Edge[]): string[][] {
  const graph = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.typeOnly || !CYCLE_EDGE_KINDS.has(e.kind)) continue;
    if (!graph.has(e.to)) graph.set(e.to, new Set());
    const targets = graph.get(e.from);
    if (targets) targets.add(e.to);
    else graph.set(e.from, new Set([e.to]));
  }

  const cycles: string[][] = [];
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visit = (file: string): void => {
    index.set(file, index.size);
    low.set(file, index.get(file)!);
    stack.push(file);
    onStack.add(file);
    for (const next of graph.get(file)!) {
      if (!index.has(next)) {
        visit(next);
        low.set(file, Math.min(low.get(file)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(file, Math.min(low.get(file)!, index.get(next)!));
      }
    }
    if (low.get(file) !== index.get(file)) return;
    const group: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      group.push(member);
    } while (member !== file);
    if (group.length > 1 || graph.get(file)!.has(file))
      cycles.push(group.sort());
  };
  for (const file of graph.keys()) if (!index.has(file)) visit(file);
  return cycles.sort(([a], [b]) => (a! < b! ? -1 : 1));
}

/**
 * Each package's package.json has to say what the code does: its name, that
 * it is private, and exactly the `workspace:*` dependencies its imports need
 * (a package-specifier import of another package; type-only imports count,
 * allow-listed ones do not). The root package.json is the published CLI and
 * must not depend on a workspace package, or the tarball would not install
 * outside the repository.
 */
export function checkManifests(
  snapshot: Snapshot,
  edges: readonly Edge[],
  violations: readonly Violation[],
): string[] {
  if (!snapshot.manifests) return [];
  const problems: string[] = [];
  const rejected = new Set(violations.map((v) => `${v.file}\0${v.target}`));
  for (const pkg of PACKAGE_NAMES) {
    const dir = PACKAGE_DIRS[pkg];
    const where = `${dir}/package.json`;
    const manifest = snapshot.manifests.get(pkg);
    if (!manifest) {
      problems.push(`${where} is missing`);
      continue;
    }
    if (manifest.name !== packageNameOf(pkg))
      problems.push(
        `${where}: name is ${JSON.stringify(manifest.name)}, expected "${packageNameOf(pkg)}"`,
      );
    if (manifest.private !== true)
      problems.push(`${where}: "private" must be true`);
    if (pkg.startsWith("apps/") === false && !manifest.exports)
      problems.push(`${where}: a package needs an "exports" map`);

    const needed = new Map<string, number>();
    for (const e of edges) {
      if (
        e.fromPkg !== pkg ||
        e.toPkg === pkg ||
        !e.viaPackage ||
        rejected.has(`${e.from}\0${e.to}`)
      )
        continue;
      const name = packageNameOf(e.toPkg);
      needed.set(name, (needed.get(name) ?? 0) + 1);
    }
    const declared = Object.entries(manifest.dependencies ?? {}).filter(([n]) =>
      n.startsWith("@ocpp-cp-simulator/"),
    );
    for (const [name, range] of declared) {
      if (range !== "workspace:*")
        problems.push(
          `${where}: ${name} must be "workspace:*", not ${JSON.stringify(range)}`,
        );
      if (!needed.has(name))
        problems.push(`${where}: declares ${name} but nothing imports it`);
    }
    for (const [name, n] of [...needed].sort()) {
      if (!declared.some(([d]) => d === name))
        problems.push(
          `${where}: ${n} import(s) of ${name} but it is not in "dependencies"`,
        );
    }
  }
  if (
    snapshot.rootManifestText !== undefined &&
    /workspace:/.test(snapshot.rootManifestText)
  )
    problems.push(
      'package.json: the published root package must not use any "workspace:" dependency',
    );
  return problems;
}

/** True when the run must fail. */
export function hasFailures(r: Report): boolean {
  return (
    r.violations.length > 0 ||
    r.unmapped.length > 0 ||
    r.unresolved.length > 0 ||
    r.staleAllowances.length > 0 ||
    r.manifestProblems.length > 0 ||
    r.cycles.length > 0
  );
}

export function formatReport(r: Report): string {
  const lines: string[] = [];
  const group = (vs: Violation[]) => {
    const by = new Map<string, Violation[]>();
    for (const v of vs) by.set(v.group, [...(by.get(v.group) ?? []), v]);
    return [...by].sort(([a], [b]) => (a < b ? -1 : 1));
  };
  for (const [g, vs] of group(r.violations)) {
    lines.push(`${g}  (${vs.length})`);
    for (const v of vs) lines.push(`  ${v.test ? "[test] " : ""}${v.message}`);
  }
  for (const [g, vs] of group(r.warnings)) {
    lines.push(`warning, allow-listed: ${g}  (${vs.length})`);
    for (const v of vs) lines.push(`  ${v.test ? "[test] " : ""}${v.message}`);
  }
  if (r.unmapped.length) {
    lines.push(`not matched by any PACKAGE_MAP entry  (${r.unmapped.length})`);
    for (const f of r.unmapped) lines.push(`  ${f}`);
  }
  if (r.unresolved.length) {
    lines.push(
      `unresolvable relative / aliased specifiers  (${r.unresolved.length})`,
    );
    for (const u of r.unresolved)
      lines.push(`  ${u.file} imports "${u.specifier}"`);
  }
  if (r.manifestProblems.length) {
    lines.push(
      `package.json files that do not match the imports  (${r.manifestProblems.length})`,
    );
    for (const p of r.manifestProblems) lines.push(`  ${p}`);
  }
  if (r.cycles.length) {
    lines.push(
      `files that import each other, type-only imports aside  (${r.cycles.length})`,
    );
    for (const c of r.cycles) {
      lines.push(`  cycle of ${c.length} file(s):`);
      for (const f of c) lines.push(`    ${f}`);
    }
  }
  if (r.staleAllowances.length) {
    lines.push("allow-list entries that match nothing (delete them)");
    for (const s of r.staleAllowances) lines.push(`  ${s}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Reading the real tree
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-cli",
  "target",
]);

function walk(root: string, rel: string, out: string[]): void {
  const abs = join(root, rel);
  if (!existsSync(abs)) return;
  for (const name of readdirSync(abs)) {
    if (SKIP_DIRS.has(name)) continue;
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(join(root, r)).isDirectory()) walk(root, r, out);
    else out.push(r);
  }
}

export function loadSnapshot(root: string): Snapshot {
  const files: string[] = [];
  for (const dir of ["packages", "apps"]) walk(root, dir, files);
  const sources = new Map<string, string>();
  const others = new Set<string>(["package.json"]);
  for (const f of files) {
    if (/\.tsx?$/.test(f)) sources.set(f, readFileSync(join(root, f), "utf8"));
    else others.add(f);
  }
  const manifests = new Map<PackageName, PackageManifest>();
  for (const pkg of PACKAGE_NAMES) {
    const file = join(root, PACKAGE_DIRS[pkg], "package.json");
    if (!existsSync(file)) continue;
    const json = JSON.parse(readFileSync(file, "utf8")) as Omit<
      PackageManifest,
      "dir"
    >;
    manifests.set(pkg, { ...json, dir: PACKAGE_DIRS[pkg] });
  }
  return {
    sources,
    others,
    manifests,
    rootManifestText: readFileSync(join(root, "package.json"), "utf8"),
  };
}

export function loadConfig(root: string): Config {
  const dir = PACKAGE_DIRS["apps/web"];
  const tsconfig = join(root, dir, "tsconfig.json");
  const aliases = existsSync(tsconfig)
    ? readAliases(readFileSync(tsconfig, "utf8"), dir)
    : DEFAULT_CONFIG.aliases;
  return { ...DEFAULT_CONFIG, aliases };
}

/** Everything the CLI prints for `--json`. */
export function jsonSummary(r: Report): unknown {
  return {
    packages: PACKAGE_NAMES,
    fileCounts: r.fileCounts,
    matrix: r.matrix,
    violations: r.violations,
    warnings: r.warnings,
    typeOnlyForbidden: r.typeOnlyForbidden,
    cycles: r.cycles,
  };
}

function main(argv: string[]): number {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const config = loadConfig(root);
  const snapshot = loadSnapshot(root);

  const listIdx = argv.indexOf("--list");
  if (listIdx >= 0) {
    const pkg = argv[listIdx + 1] as PackageName | undefined;
    if (!pkg || !(PACKAGE_NAMES as readonly string[]).includes(pkg)) {
      console.error(`usage: --list <${PACKAGE_NAMES.join("|")}>`);
      return 2;
    }
    const all = [...snapshot.sources.keys(), ...snapshot.others]
      .filter((f) => packageOf(f, config.map) === pkg)
      .sort();
    console.log(all.join("\n"));
    return 0;
  }

  const report = checkBoundaries(snapshot, config);
  if (argv.includes("--json")) {
    console.log(JSON.stringify(jsonSummary(report), null, 2));
  } else {
    const text = formatReport(report);
    if (text) console.error(text);
    const total = Object.values(report.fileCounts).reduce((a, b) => a + b, 0);
    if (!hasFailures(report))
      console.log(
        `package boundaries OK: ${total} files in ${PACKAGE_NAMES.length} packages, ${report.edges.length} imports checked` +
          (report.warnings.length
            ? `, ${report.warnings.length} allow-listed`
            : ""),
      );
  }
  return hasFailures(report) ? 1 : 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}

// Used by the test to anchor the real tree.
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
