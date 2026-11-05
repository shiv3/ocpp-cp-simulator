// scripts/check-package-boundaries.ts
//
// Executable form of the package dependency rules from #578.
//
// The repository is going to become a Bun workspace in one pull request that
// only moves files (`git mv`) and rewrites import specifiers. For that move to
// be mechanical, the source tree has to obey the future package boundaries
// while everything still lives under src/. This script is the definition of
// those boundaries: PACKAGE_MAP says which future package every file belongs
// to, ALLOWED_DEPENDENCIES says which package may import which, and
// FORBIDDEN_SPECIFIERS keeps the portable packages free of UI frameworks and
// runtime-specific built-ins.
//
//   bun run check:boundaries                 # exit 1 on any violation
//   bun run check:boundaries --json          # the full package x package edge matrix
//   bun run check:boundaries --list core     # files mapped to one package
//
// TypeScript project references forbid cycles at the type level too, so
// `import type`, `export type ... from` and `import("x").T` count as edges
// exactly like value imports.

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

/**
 * Which future package each path belongs to. The FIRST matching entry wins, so
 * list the most specific first; `validatePackageMap` rejects an entry that a
 * broader earlier entry would swallow. Every .ts/.tsx file under src/ must
 * match an entry (the checker fails on a file that matches none), so a new
 * top-level directory has to be placed here on purpose.
 *
 * Test files belong to the package of the directory they sit in: there are no
 * separate test entries except where a directory mixes owners (src/test).
 */
export const PACKAGE_MAP: readonly MapEntry[] = [
  // --- k6-runtime: dependency-free files copied verbatim into an export.
  // Must precede the apps/cli entry for src/cli/. runtimeManifest.test.ts
  // already enforces that these files import nothing outside themselves.
  { match: "src/cli/exportK6/runtime/", pkg: "k6-runtime" },

  // --- apps/cli: the CLI, the daemon, the MCP endpoint, export-k6, analyze.
  { match: "src/cli/", pkg: "apps/cli" },

  // --- ocpp: generated message types, validators and the vendored schemas.
  { match: "src/ocpp/", pkg: "ocpp" },
  { match: "vendor/ocpp-schemas/", pkg: "ocpp" },

  // --- contracts: the wire/RPC vocabulary shared by daemon and clients.
  // src/protocol/buildVersion.ts is also used by src/cli, src/components and
  // src/lib; it stays here for now.
  { match: "src/protocol/", pkg: "contracts" },

  // --- trace: the trace format reader/writer.
  { match: "src/trace/", pkg: "trace" },

  // --- core: the charge point engine, the scenario engine and what they need.
  { match: "src/cp/", pkg: "core" },
  { match: "src/scenario/", pkg: "core" },
  {
    match: "schema/",
    pkg: "core",
    why: "scenario.schema.json, validated by src/scenario",
  },
  // src/utils is a grab bag; each file goes where its importers are.
  // Scenario templates are imported by src/cp tests, src/data/local, src/cli
  // and the console, and import only src/cp: they are core data. Their JSON
  // files and the blueprint helpers travel with them.
  { match: "src/utils/scenarioTemplates.ts", pkg: "core" },
  { match: "src/utils/scenarioTemplates.test.ts", pkg: "core" },
  {
    match: "src/utils/scenarios/",
    pkg: "core",
    why: "template JSON imported by scenarioTemplates.ts",
  },
  {
    match: "src/utils/blueprints/",
    pkg: "core",
    why: "also listed in tsconfig.cli.json",
  },
  // src/types holds one ambient .d.ts that gives the CLI project the WebCrypto
  // dictionary types src/cp/domain/security refers to.
  {
    match: "src/types/",
    pkg: "core",
    why: "ambient WebCrypto types for src/cp/domain/security",
  },

  // --- client: how a UI or tool talks to a daemon or to an in-process engine.
  { match: "src/data/interfaces/", pkg: "client" },
  { match: "src/data/remote/", pkg: "client" },
  { match: "src/data/configPort.ts", pkg: "client" },
  { match: "src/data/RuntimeMode.ts", pkg: "client" },
  {
    match: "src/data/sqlite/SqliteConnectorSettingsRepository.ts",
    pkg: "client",
    why: "listed in tsconfig.cli.json; the CLI persists connector settings with it",
  },

  // --- src/test: shared test helpers. They are split by file because the
  // directory mixes owners. The ones that import only src/cp (or nothing) and
  // are used by cp, cli and web tests alike live in core, the only package all
  // of those users may depend on. All four are also in tsconfig.cli.json.
  {
    match: "src/test/setup.dom.ts",
    pkg: "apps/web",
    why: "vitest setupFiles: jsdom / testing-library only",
  },
  {
    match: "src/test/",
    pkg: "core",
    why: "bunServe, deferred and the fixtures import only src/cp (or nothing); used by core, cli and web tests",
  },

  // --- src/build: tests that build the shipped artifacts. Per file.
  {
    match: "src/build/__tests__/browserBundleNoDaemonXml.bun.test.ts",
    pkg: "apps/web",
    why: "builds the web console",
  },
  {
    match: "src/build/",
    pkg: "apps/cli",
    why: "builds and boots the CLI bundle / Tauri sidecar",
  },

  // --- apps/web: the browser console and everything only it uses.
  // src/lib: shadcn cn(), connector formatting, build label, log download —
  // imported only by src/components and src/console.
  { match: "src/lib/", pkg: "apps/web" },
  // src/utils leftovers: ocppUrl*, downloadJson, scenarioFile (File/Blob and
  // download helpers) are imported only by src/components and src/console.
  { match: "src/utils/", pkg: "apps/web" },
  { match: "src/components/", pkg: "apps/web" },
  { match: "src/console/", pkg: "apps/web" },
  { match: "src/contexts/", pkg: "apps/web" },
  {
    match: "src/store/",
    pkg: "apps/web",
    why: "jotai-style UI state; the CLI must not read it",
  },
  {
    match: "src/data/",
    pkg: "apps/web",
    why: "hooks, providers, the in-process service and sql.js persistence",
  },
  { match: "src/assets/", pkg: "apps/web" },
  { match: "src/index.css", pkg: "apps/web" },
  { match: "src/App.tsx", pkg: "apps/web" },
  { match: "src/AppRoutes.dom.test.tsx", pkg: "apps/web" },
  { match: "src/main.tsx", pkg: "apps/web" },
  { match: "src/vite-env.d.ts", pkg: "apps/web" },
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
  "src/cp/domain/persistence/BunSqliteDatabase.ts": {
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
    from: "src/cp/infrastructure/transport/__tests__/OCPPMessageHandler.settlement.test.ts",
    to: "src/cli/server/metrics/MetricsRecorder.ts",
    why: "One case (#302) pins the exact watchdog log line the daemon's Prometheus recorder parses: it drives the real transport watchdog with this file's fake socket and asserts the recorder's counter moves. The wording is the contract between the two packages, so the test needs both sides; moving it would mean copying the whole fake socket into apps/cli.",
  },
];

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
  /** Alias prefix -> repo-relative directory, e.g. "@/" -> "src/". */
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
  aliases: { "@/": "src/" },
};

/**
 * The `@/*` alias from a tsconfig's `compilerOptions.paths`. vite.config.ts
 * and tsconfig.app.json both map "@" to src/; reading it from the tsconfig
 * keeps this script from drifting if that ever changes.
 */
export function readAliases(tsconfigText: string): Record<string, string> {
  const parsed = ts.parseConfigFileTextToJson("tsconfig.json", tsconfigText);
  const paths = (parsed.config?.compilerOptions?.paths ?? {}) as Record<
    string,
    string[]
  >;
  const out: Record<string, string> = {};
  for (const [key, targets] of Object.entries(paths)) {
    const target = targets[0];
    if (!key.endsWith("/*") || !target?.endsWith("/*")) continue;
    out[key.slice(0, -1)] = posix.normalize(target.slice(0, -1) + "/");
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
    file.startsWith("src/test/") ||
    file.startsWith("src/console/test/")
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

/**
 * Repo-relative path a specifier points to, or null for a bare package.
 * `known` is the set of every file that exists. Throws-free: returns
 * `{ unresolved }` when a relative or aliased specifier hits nothing.
 */
export function resolveSpecifier(
  fromFile: string,
  specifier: string,
  known: ReadonlySet<string>,
  aliases: Readonly<Record<string, string>>,
): { path: string } | { unresolved: string } | null {
  const clean = specifier.replace(/\?.*$/, "");
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
  for (const c of candidates) if (known.has(c)) return { path: c };
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
}

export interface Violation {
  readonly type: "edge" | "specifier";
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
  readonly edges: Edge[];
}

export interface Snapshot {
  /** Repo-relative path -> text, for every .ts/.tsx file to check. */
  readonly sources: ReadonlyMap<string, string>;
  /** Every other file that may be an import target (json, css, svg, ...). */
  readonly others: ReadonlySet<string>;
}

export function checkBoundaries(
  snapshot: Snapshot,
  config: Config = DEFAULT_CONFIG,
): Report {
  validatePackageMap(config.map);
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

      const res = resolveSpecifier(file, imp.specifier, known, config.aliases);
      if (res === null) continue;
      if ("unresolved" in res) {
        // `new URL("../..", import.meta.url)` in tests names directories and
        // docs; only a missing file under src/ is a real problem.
        if (imp.kind === "new-url" && !res.unresolved.startsWith("src/"))
          continue;
        if (imp.kind === "new-url" && !/\.[a-z]+$/.test(res.unresolved))
          continue;
        unresolved.push({ file, specifier: imp.specifier });
        continue;
      }
      const toPkg = packageOf(res.path, config.map);
      if (!toPkg) {
        // A file outside the map (package.json, scripts/, ...): not a package edge.
        if (res.path.startsWith("src/")) unmapped.push(res.path);
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
      });
      matrix[fromPkg]![toPkg]!++;
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
      }
    }
  }

  const staleAllowances: string[] = [];
  for (const k of config.knownViolations)
    if (!usedAllowances.has(`known:${k.from}->${k.to}`))
      staleAllowances.push(`KNOWN_VIOLATIONS ${k.from} -> ${k.to}`);
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
    unmapped: [...new Set(unmapped)].sort(),
    unresolved,
    matrix,
    fileCounts,
    typeOnlyForbidden,
    staleAllowances,
    edges,
  };
}

/** True when the run must fail. */
export function hasFailures(r: Report): boolean {
  return (
    r.violations.length > 0 ||
    r.unmapped.length > 0 ||
    r.unresolved.length > 0 ||
    r.staleAllowances.length > 0
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
  for (const dir of ["src", "schema", "vendor"]) walk(root, dir, files);
  const sources = new Map<string, string>();
  const others = new Set<string>(["package.json"]);
  for (const f of files) {
    if (f.startsWith("src/") && /\.tsx?$/.test(f))
      sources.set(f, readFileSync(join(root, f), "utf8"));
    else others.add(f);
  }
  return { sources, others };
}

export function loadConfig(root: string): Config {
  const tsconfig = join(root, "tsconfig.app.json");
  const aliases = existsSync(tsconfig)
    ? readAliases(readFileSync(tsconfig, "utf8"))
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
