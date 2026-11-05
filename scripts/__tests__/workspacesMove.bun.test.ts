import { describe, expect, test } from "bun:test";
import {
  collectSourceRefs,
  destinationFor,
  detectLayout,
  findOldRootRefs,
  makeCtx,
  mapPath,
  mapTextToken,
  newPathString,
  newSpecifier,
  planMoves,
  rewriteFile,
  workspaceOf,
  type Ctx,
} from "../workspaces-move";

// A miniature repository: one file per interesting destination rule.
const MAP = [
  { match: "src/cli/exportK6/runtime/", pkg: "k6-runtime" },
  { match: "src/cli/", pkg: "apps/cli" },
  { match: "src/ocpp/", pkg: "ocpp" },
  { match: "vendor/ocpp-schemas/", pkg: "ocpp" },
  { match: "src/protocol/", pkg: "contracts" },
  { match: "src/cp/", pkg: "core" },
  { match: "schema/", pkg: "core" },
  { match: "src/utils/scenarioTemplates.ts", pkg: "core" },
  { match: "src/utils/scenarios/", pkg: "core" },
  { match: "src/data/interfaces/", pkg: "client" },
  { match: "src/data/configPort.ts", pkg: "client" },
  { match: "src/test/setup.dom.ts", pkg: "apps/web" },
  { match: "src/test/", pkg: "core" },
  { match: "src/build/", pkg: "apps/cli" },
  { match: "src/utils/", pkg: "apps/web" },
  { match: "src/components/", pkg: "apps/web" },
  { match: "src/data/", pkg: "apps/web" },
  { match: "src/main.tsx", pkg: "apps/web" },
];

const FILES = [
  "src/cli/main.ts",
  "src/cli/server/socket.ts",
  "src/cli/exportK6/runtime/index.ts",
  "src/cli/exportK6/runtimeSources.ts",
  "src/ocpp/v16/schemas.ts",
  "vendor/ocpp-schemas/v16/Authorize.json",
  "src/protocol/methods.ts",
  "src/cp/domain/ChargePoint.ts",
  "src/cp/domain/index.ts",
  "schema/scenario.schema.json",
  "src/utils/scenarioTemplates.ts",
  "src/utils/scenarios/README.md",
  "src/utils/ocppUrl.ts",
  "src/data/configPort.ts",
  "src/data/interfaces/Service.ts",
  "src/data/hooks/useThing.ts",
  "src/test/deferred.ts",
  "src/test/setup.dom.ts",
  "src/build/__tests__/cliBundle.bun.test.ts",
  "src/components/Button.tsx",
  "src/main.tsx",
  "scripts/tool.ts",
  "docs/overview.md",
  "package.json",
];

function pkgOf(file: string): string | null {
  for (const e of MAP)
    if (e.match.endsWith("/") ? file.startsWith(e.match) : file === e.match)
      return e.pkg;
  return null;
}

function ctx(): Ctx {
  return makeCtx(FILES, planMoves(FILES, pkgOf, MAP));
}

describe("destinationFor", () => {
  test.each([
    ["src/ocpp/v16/schemas.ts", "ocpp", "packages/ocpp/src/v16/schemas.ts"],
    [
      "vendor/ocpp-schemas/v16/Authorize.json",
      "ocpp",
      "packages/ocpp/vendor/ocpp-schemas/v16/Authorize.json",
    ],
    [
      "src/protocol/methods.ts",
      "contracts",
      "packages/contracts/src/methods.ts",
    ],
    ["src/trace/read.ts", "trace", "packages/trace/src/read.ts"],
    [
      "src/cli/exportK6/runtime/index.ts",
      "k6-runtime",
      "packages/k6-runtime/src/index.ts",
    ],
    ["src/cli/main.ts", "apps/cli", "apps/cli/src/main.ts"],
    [
      "src/build/__tests__/a.bun.test.ts",
      "apps/cli",
      "apps/cli/src/build/__tests__/a.bun.test.ts",
    ],
    ["src/cp/x.ts", "core", "packages/core/src/cp/x.ts"],
    [
      "schema/scenario.schema.json",
      "core",
      "packages/core/schema/scenario.schema.json",
    ],
    ["src/data/remote/R.ts", "client", "packages/client/src/remote/R.ts"],
    ["src/data/hooks/h.ts", "apps/web", "apps/web/src/data/hooks/h.ts"],
    ["src/main.tsx", "apps/web", "apps/web/src/main.tsx"],
  ])("%s (%s) -> %s", (file, pkg, expected) => {
    expect(destinationFor(file, pkg)).toBe(expected);
  });

  test("the k6 type declarations sit beside src/, not inside the verbatim runtime", () => {
    expect(destinationFor("src/cli/exportK6/k6-types.d.ts", "k6-runtime")).toBe(
      "packages/k6-runtime/k6-types.d.ts",
    );
    expect(
      destinationFor("src/cli/exportK6/k6-types.d.ts", "apps/cli"),
    ).toBeNull();
  });

  test("a file outside the roots, or in the wrong package, has no destination", () => {
    expect(destinationFor("scripts/x.ts", "core")).toBeNull();
    expect(destinationFor("src/cp/x.ts", "ocpp")).toBeNull();
    expect(destinationFor("vendor/ocpp-schemas/a.json", "core")).toBeNull();
    expect(destinationFor("src/cp/x.ts", "nope")).toBeNull();
  });
});

describe("planMoves", () => {
  test("moves only files under the old roots and counts per package", () => {
    const plan = planMoves(FILES, pkgOf, MAP);
    expect(plan.moves.has("scripts/tool.ts")).toBe(false);
    expect(plan.moves.get("src/cp/domain/ChargePoint.ts")).toBe(
      "packages/core/src/cp/domain/ChargePoint.ts",
    );
    expect(plan.perPackage.get("core")).toBe(6);
    expect(plan.unplaced).toEqual([]);
    expect(plan.collisions).toEqual([]);
  });

  test("a tracked file nothing places is reported", () => {
    const plan = planMoves(["src/stray/a.ts"], pkgOf, MAP);
    expect(plan.unplaced).toEqual(["src/stray/a.ts"]);
  });

  test("two files landing on one path are reported", () => {
    const map = [
      { match: "src/a/", pkg: "contracts" },
      { match: "src/b/", pkg: "contracts" },
    ];
    // Both would need distinct sub-paths; force a clash via the stripped dir.
    const plan = planMoves(
      ["src/protocol/x.ts", "src/protocol/x.ts"],
      () => "contracts",
      map,
    );
    expect(plan.collisions.length).toBe(1);
  });

  test("uniform directories map, split ones take the PACKAGE_MAP entry", () => {
    const plan = planMoves(FILES, pkgOf, MAP);
    expect(plan.dirMap.get("src/cp")).toBe("packages/core/src/cp");
    expect(plan.ambiguousDirs.has("src/cp")).toBe(false);
    // src/cli holds apps/cli files and the k6 runtime
    expect(plan.dirMap.get("src/cli")).toBe("apps/cli/src");
    expect(plan.ambiguousDirs.has("src/cli")).toBe(true);
    expect(plan.dirMap.get("src/data")).toBe("apps/web/src/data");
    // the top-level root never maps
    expect(plan.dirMap.has("src")).toBe(false);
  });
});

describe("mapPath / mapTextToken", () => {
  test("files, directories and paths below a mapped directory", () => {
    const c = ctx();
    expect(mapPath(c, "src/cp/domain/ChargePoint.ts")?.path).toBe(
      "packages/core/src/cp/domain/ChargePoint.ts",
    );
    expect(mapPath(c, "src/cp/domain")?.path).toBe(
      "packages/core/src/cp/domain",
    );
    expect(mapPath(c, "src/cp/new/not/yet.ts")?.path).toBe(
      "packages/core/src/cp/new/not/yet.ts",
    );
    expect(mapPath(c, "src/cli/exportK6/runtime")?.path).toBe(
      "packages/k6-runtime/src",
    );
    expect(mapPath(c, "docs/overview.md")).toBeNull();
    expect(mapPath(c, "src")).toBeNull();
  });

  test("longest match wins: a file inside a split directory", () => {
    const c = ctx();
    expect(mapPath(c, "src/utils/scenarioTemplates.ts")?.path).toBe(
      "packages/core/src/utils/scenarioTemplates.ts",
    );
    expect(mapPath(c, "src/utils/ocppUrl.ts")?.path).toBe(
      "apps/web/src/utils/ocppUrl.ts",
    );
  });

  test("tokens with globs, braces and trailing slashes", () => {
    const c = ctx();
    expect(mapTextToken(c, "src/components/**/*.{ts,tsx}")?.text).toBe(
      "apps/web/src/components/**/*.{ts,tsx}",
    );
    expect(mapTextToken(c, "src/ocpp/v{16,201}/schemas.ts")?.text).toBe(
      "packages/ocpp/src/v{16,201}/schemas.ts",
    );
    expect(mapTextToken(c, "src/cp/")?.text).toBe("packages/core/src/cp/");
    expect(mapTextToken(c, "src/**/*.ts")).toBeNull();
    expect(mapTextToken(c, "src/")).toBeNull();
  });
});

describe("newSpecifier", () => {
  test("inside one package a relative import stays relative", () => {
    const c = ctx();
    expect(newSpecifier(c, "src/cp/domain/ChargePoint.ts", "./index")).toEqual({
      text: "./index",
      kind: "relative",
    });
    expect(newSpecifier(c, "src/cli/server/socket.ts", "../main")).toEqual({
      text: "../main",
      kind: "relative",
    });
  });

  test("across packages it becomes a package specifier without extension", () => {
    const c = ctx();
    expect(newSpecifier(c, "src/cli/main.ts", "../protocol/methods")).toEqual({
      text: "@ocpp-cp-sim/contracts/methods",
      kind: "package",
    });
    expect(
      newSpecifier(c, "src/cli/main.ts", "../cp/domain/ChargePoint.ts"),
    ).toEqual({
      text: "@ocpp-cp-sim/core/cp/domain/ChargePoint",
      kind: "package",
    });
  });

  test("a directory import becomes an explicit /index", () => {
    const c = ctx();
    // the package's own src/ directory: <pkg>/index, not <pkg>/src/index
    expect(
      newSpecifier(
        makeCtx(
          [...FILES, "src/protocol/index.ts"],
          planMoves([...FILES, "src/protocol/index.ts"], pkgOf, MAP),
        ),
        "src/cli/main.ts",
        "../protocol",
      )?.text,
    ).toBe("@ocpp-cp-sim/contracts/index");
    expect(newSpecifier(c, "src/cli/main.ts", "../cp/domain")?.text).toBe(
      "@ocpp-cp-sim/core/cp/domain/index",
    );
  });

  test("files outside the workspaces use relative specifiers", () => {
    const c = ctx();
    expect(
      newSpecifier(c, "scripts/tool.ts", "../src/protocol/methods"),
    ).toEqual({ text: "../packages/contracts/src/methods", kind: "relative" });
  });

  test("JSON next to the source keeps its extension; vendored JSON is relative inside ocpp", () => {
    const c = ctx();
    expect(
      newSpecifier(
        c,
        "src/ocpp/v16/schemas.ts",
        "../../../vendor/ocpp-schemas/v16/Authorize.json",
      ),
    ).toEqual({
      text: "../../vendor/ocpp-schemas/v16/Authorize.json",
      kind: "relative",
    });
    expect(
      newSpecifier(
        c,
        "src/cp/domain/ChargePoint.ts",
        "../../../schema/scenario.schema.json",
      ),
    ).toEqual({
      text: "../../../schema/scenario.schema.json",
      kind: "relative",
    });
    expect(
      newSpecifier(c, "src/cli/main.ts", "../../schema/scenario.schema.json"),
    ).toEqual({
      text: "@ocpp-cp-sim/core/schema/scenario.schema.json",
      kind: "package",
    });
  });

  test("inside apps/web an @/ import stays @/", () => {
    const c = ctx();
    expect(
      newSpecifier(c, "src/components/Button.tsx", "@/data/hooks/useThing"),
    ).toEqual({
      text: "@/data/hooks/useThing",
      kind: "alias",
    });
    expect(
      newSpecifier(c, "src/components/Button.tsx", "@/cp/domain/ChargePoint"),
    ).toEqual({
      text: "@ocpp-cp-sim/core/cp/domain/ChargePoint",
      kind: "package",
    });
    expect(
      newSpecifier(c, "src/components/Button.tsx", "@/data/configPort"),
    ).toEqual({
      text: "@ocpp-cp-sim/client/configPort",
      kind: "package",
    });
  });

  test("a relative import that crosses the web/client split becomes a package specifier", () => {
    const c = ctx();
    expect(
      newSpecifier(c, "src/data/hooks/useThing.ts", "../interfaces/Service")
        ?.text,
    ).toBe("@ocpp-cp-sim/client/interfaces/Service");
  });

  test("bare packages and unresolved specifiers are left alone", () => {
    const c = ctx();
    expect(newSpecifier(c, "src/cli/main.ts", "zod")).toBeNull();
    expect(newSpecifier(c, "src/cli/main.ts", "./nope")).toBeNull();
  });

  test("a query suffix is preserved", () => {
    const c = ctx();
    expect(
      newSpecifier(c, "src/components/Button.tsx", "../main?url")?.text,
    ).toBe("../main?url");
    expect(
      newSpecifier(c, "src/components/Button.tsx", "@/main?url")?.text,
    ).toBe("@/main?url");
  });
});

describe("collectSourceRefs + rewriteFile", () => {
  test("covers import, export-from, dynamic import, import types, mocks, URLs and references", () => {
    const text = [
      '/// <reference path="../protocol/methods.ts" />',
      'import a from "../protocol/methods";',
      'import type { B } from "../cp/domain";',
      'export * from "../protocol/methods";',
      'const c = await import("../protocol/methods");',
      'type D = import("../protocol/methods").Foo;',
      'vi.mock("../protocol/methods", () => ({}));',
      'mock.module("../protocol/methods", () => ({}));',
      'const u = new URL("../protocol/methods.ts", import.meta.url);',
      'const r = require.resolve("../protocol/methods");',
      'import z from "zod";',
    ].join("\n");
    const refs = collectSourceRefs("src/cli/main.ts", text);
    expect(refs.map((r) => r.value)).toEqual([
      "../protocol/methods",
      "../cp/domain",
      "../protocol/methods",
      "../protocol/methods",
      "../protocol/methods",
      "../protocol/methods",
      "../protocol/methods",
      "../protocol/methods.ts",
      "../protocol/methods",
      "zod",
      "../protocol/methods.ts",
    ]);

    const out = rewriteFile(ctx(), "src/cli/main.ts", text);
    expect(out.text).toContain('from "@ocpp-cp-sim/contracts/methods";');
    expect(out.text).toContain(
      'import type { B } from "@ocpp-cp-sim/core/cp/domain/index";',
    );
    expect(out.text).toContain(
      'export * from "@ocpp-cp-sim/contracts/methods";',
    );
    expect(out.text).toContain('import("@ocpp-cp-sim/contracts/methods")');
    expect(out.text).toContain('vi.mock("@ocpp-cp-sim/contracts/methods"');
    expect(out.text).toContain('mock.module("@ocpp-cp-sim/contracts/methods"');
    expect(out.text).toContain(
      'require.resolve("@ocpp-cp-sim/contracts/methods")',
    );
    expect(out.text).toContain('import z from "zod";');
    // formatting is preserved outside the replaced strings
    expect(out.text.split("\n").length).toBe(text.split("\n").length);
    expect(out.stats.toPackage).toBe(8);
  });

  test("new URL() and dirname joins follow the file to its new directory", () => {
    const c = ctx();
    const text = [
      'const root = new URL("../../..", import.meta.url);',
      'const base = resolve(import.meta.dir, "../../../package.json");',
      'const dist = resolve(import.meta.dir, "../dist");',
    ].join("\n");
    const out = rewriteFile(
      c,
      "src/build/__tests__/cliBundle.bun.test.ts",
      text,
    );
    expect(out.text).toBe(
      [
        'const root = new URL("../../../../..", import.meta.url);',
        'const base = resolve(import.meta.dir, "../../../../../package.json");',
        // names nothing tracked: left for a human
        'const dist = resolve(import.meta.dir, "../dist");',
      ].join("\n"),
    );
  });

  test("an unresolved relative import is reported and not rewritten", () => {
    const out = rewriteFile(ctx(), "src/cli/main.ts", 'import "./gone";');
    expect(out.text).toBe('import "./gone";');
    expect(out.unresolved).toEqual(['src/cli/main.ts:1 "./gone"']);
  });

  test("prose: longest path first, src-tauri and github URLs", () => {
    const c = ctx();
    const text = [
      "see `src/cp/domain/ChargePoint.ts`, and src/cli/exportK6/runtime/index.ts.",
      "also src-tauri/src/lib.rs and node_modules/x/src/cp/y.ts stay",
      "[x](https://github.com/shiv3/ocpp-cp-simulator/blob/main/src/protocol/methods.ts)",
      'include: ["src/components/**/*.tsx"]',
      '<script src="/src/main.tsx"></script>',
    ].join("\n");
    const out = rewriteFile(c, "docs/overview.md", text);
    expect(out.text).toBe(
      [
        "see `packages/core/src/cp/domain/ChargePoint.ts`, and packages/k6-runtime/src/index.ts.",
        "also src-tauri/src/lib.rs and node_modules/x/src/cp/y.ts stay",
        "[x](https://github.com/shiv3/ocpp-cp-simulator/blob/main/packages/contracts/src/methods.ts)",
        'include: ["apps/web/src/components/**/*.tsx"]',
        '<script src="/apps/web/src/main.tsx"></script>',
      ].join("\n"),
    );
  });

  test("a regex literal that looks like a rooted path is left alone", () => {
    const out = rewriteFile(
      ctx(),
      "src/cli/main.ts",
      'expect(s).toMatch(/schema/i);\nconst x = "/src/main.tsx";',
    );
    expect(out.text).toBe(
      'expect(s).toMatch(/schema/i);\nconst x = "/apps/web/src/main.tsx";',
    );
  });

  test("a ./src path in an eval string is relative to the working directory", () => {
    const text = "const s = 'import x from \"./src/cli/main.ts\"';";
    expect(rewriteFile(ctx(), "src/cli/main.ts", text).text).toBe(
      "const s = 'import x from \"./apps/cli/src/main.ts\"';",
    );
    // a ./ path that does resolve from the file wins
    expect(
      rewriteFile(
        ctx(),
        "src/cli/main.ts",
        "see ./server/socket.ts and ./src/cp/domain/index.ts",
      ).text,
    ).toBe("see ./server/socket.ts and ./packages/core/src/cp/domain/index.ts");
  });

  test("path.join segments that spell an old root are rewritten as segments", () => {
    const text = [
      'const a = join(REPO_ROOT, "src", "cli", "main.ts");',
      "const b = join(rootDir, 'vendor', 'ocpp-schemas');",
      'const c = resolve(root, "schema", "scenario.schema.json");',
      'const d = join(root, "docs", "x.md");',
      'const e = join(root, "src", name);',
    ].join("\n");
    const out = rewriteFile(ctx(), "scripts/tool.ts", text);
    expect(out.text).toBe(
      [
        'const a = join(REPO_ROOT, "apps", "cli", "src", "main.ts");',
        "const b = join(rootDir, 'packages', 'ocpp', 'vendor', 'ocpp-schemas');",
        'const c = resolve(root, "packages", "core", "schema", "scenario.schema.json");',
        'const d = join(root, "docs", "x.md");',
        'const e = join(root, "src", name);',
      ].join("\n"),
    );
    // `src` alone names no moved path: reported for a human
    expect(out.unmapped).toEqual(["scripts/tool.ts:5 src (path segments)"]);
  });

  test("unmapped roots are reported; unrelated src/ paths are not", () => {
    const out = rewriteFile(
      ctx(),
      "docs/overview.md",
      "all of src/ and src/main/java/Foo.java",
    );
    expect(out.unmapped).toEqual(["docs/overview.md:1 src/"]);
  });

  test("markdown relative links keep resolving, from a file that moves too", () => {
    const c = ctx();
    const doc = rewriteFile(
      c,
      "docs/overview.md",
      "[a](../src/protocol/methods.ts#x) [b](https://x.y/src/a.ts) [c](#h)",
    );
    expect(doc.text).toBe(
      "[a](../packages/contracts/src/methods.ts#x) [b](https://x.y/src/a.ts) [c](#h)",
    );
    const moved = makeCtx(
      [...FILES, "src/utils/scenarios/README.md"],
      planMoves([...FILES, "src/utils/scenarios/README.md"], pkgOf, MAP),
    );
    const readme = rewriteFile(
      moved,
      "src/utils/scenarios/README.md",
      "[d](../../../docs/overview.md) [e](../scenarioTemplates.ts)",
    );
    expect(readme.text).toBe(
      "[d](../../../../../docs/overview.md) [e](../scenarioTemplates.ts)",
    );
  });

  test("history files only get their links rewritten", () => {
    const out = rewriteFile(
      ctx(),
      "docs/overview.md",
      "touched `src/cp/x.ts` and [m](../src/protocol/methods.ts)",
      { linksOnly: true },
    );
    expect(out.text).toBe(
      "touched `src/cp/x.ts` and [m](../packages/contracts/src/methods.ts)",
    );
  });

  test("rewriting is idempotent on its own output's inputs: same input, same output", () => {
    const c = ctx();
    const text =
      'import a from "../protocol/methods";\n// src/cp/domain/ChargePoint.ts\n';
    expect(rewriteFile(c, "src/cli/main.ts", text).text).toBe(
      rewriteFile(c, "src/cli/main.ts", text).text,
    );
  });
});

describe("newPathString / findOldRootRefs / layout", () => {
  test("only paths that name tracked things are touched", () => {
    const c = ctx();
    const f = "src/build/__tests__/cliBundle.bun.test.ts";
    expect(newPathString(c, f, "../../..")).toBe("../../../../..");
    expect(newPathString(c, f, "../../../docs/")).toBe("../../../../../docs/");
    expect(newPathString(c, f, "../../../dist")).toBeNull();
    expect(newPathString(c, f, "/abs")).toBeNull();
  });

  test("the sweep ignores relative paths that now point into a package", () => {
    const text =
      "a ../../vendor/ocpp-schemas/v16/A.json b src/cp/x.ts c packages/core/src/cp/y.ts";
    expect(findOldRootRefs("packages/ocpp/src/v16/schemas.ts", text)).toEqual([
      { line: 1, token: "src/cp/x.ts" },
    ]);
  });

  test("workspaceOf and detectLayout", () => {
    expect(workspaceOf("packages/core/src/a.ts")).toBe("packages/core");
    expect(workspaceOf("apps/web/src/a.ts")).toBe("apps/web");
    expect(workspaceOf("scripts/a.ts")).toBeNull();
    expect(detectLayout(["src/a.ts", "package.json"])).toBe("pre-move");
    expect(detectLayout(["packages/core/src/a.ts", "package.json"])).toBe(
      "moved",
    );
    expect(detectLayout(["package.json"])).toBe("unknown");
  });
});
