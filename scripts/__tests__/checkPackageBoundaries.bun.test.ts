import { describe, expect, it } from "bun:test";

import {
  DEFAULT_CONFIG,
  PACKAGE_DIRS,
  PACKAGE_MAP,
  PACKAGE_NAMES,
  REPO_ROOT,
  checkBoundaries,
  extractImports,
  formatReport,
  hasFailures,
  jsonSummary,
  layerViolationOf,
  loadConfig,
  loadSnapshot,
  readAliases,
  resolveExport,
  resolveSpecifier,
  validatePackageMap,
  type PackageManifest,
  type Snapshot,
} from "../check-package-boundaries";

function snapshot(
  files: Record<string, string>,
  others: string[] = [],
): Snapshot {
  return {
    sources: new Map(Object.entries(files)),
    others: new Set(others),
  };
}

describe("package boundaries of the real tree (#578)", () => {
  const report = checkBoundaries(
    loadSnapshot(REPO_ROOT),
    loadConfig(REPO_ROOT),
  );

  it("has no violation, unmapped file, unresolvable import or stale allow-list entry", () => {
    expect({
      violations: report.violations.map((v) => v.message),
      unmapped: report.unmapped,
      unresolved: report.unresolved,
      stale: report.staleAllowances,
      manifests: report.manifestProblems,
    }).toEqual({
      violations: [],
      unmapped: [],
      unresolved: [],
      stale: [],
      manifests: [],
    });
    expect(hasFailures(report)).toBe(false);
  });

  it("has no import cycle (#570)", () => {
    expect(report.cycles).toEqual([]);
  });

  it("checked a plausible number of files and imports", () => {
    expect(report.edges.length).toBeGreaterThan(1000);
    for (const n of Object.values(report.fileCounts))
      expect(n).toBeGreaterThan(0);
  });

  it("reads the @/ alias from apps/web/tsconfig.json", () => {
    expect(loadConfig(REPO_ROOT).aliases).toEqual({ "@/": "apps/web/src/" });
  });

  it("has one map entry per workspace directory, and the manifests agree", () => {
    expect(PACKAGE_MAP.map((e) => e.match)).toEqual(
      PACKAGE_NAMES.map((p) => `${PACKAGE_DIRS[p]}/`),
    );
    const snap = loadSnapshot(REPO_ROOT);
    expect([...snap.manifests!.keys()].sort()).toEqual(
      [...PACKAGE_NAMES].sort(),
    );
    expect(snap.manifests!.get("core")!.name).toBe("@ocpp-cp-simulator/core");
  });
});

describe("package boundaries on synthetic input", () => {
  it("catches a forbidden edge", () => {
    const r = checkBoundaries(
      snapshot({
        "packages/contracts/src/a.ts":
          'import { x } from "@ocpp-cp-simulator/core/cp/b";\nexport const y = x;',
        "packages/core/src/cp/b.ts": "export const x = 1;",
      }),
    );
    expect(r.violations.map((v) => [v.group, v.file, v.target])).toEqual([
      [
        "contracts → core",
        "packages/contracts/src/a.ts",
        "packages/core/src/cp/b.ts",
      ],
    ]);
    expect(hasFailures(r)).toBe(true);
  });

  it("catches a type-only forbidden edge, in every spelling", () => {
    const r = checkBoundaries(
      snapshot({
        "packages/client/src/interfaces/a.ts": [
          'import type { A } from "../../../../apps/web/src/store/s";',
          'import { type B } from "../../../../apps/web/src/store/s";',
          'export type { C } from "../../../../apps/web/src/store/s";',
          'export type D = import("../../../../apps/web/src/store/s").D;',
          'export const e = () => import("../../../../apps/web/src/store/s");',
        ].join("\n"),
        "apps/web/src/store/s.ts": "export type A = 1, B = 1, C = 1, D = 1;",
      }),
    );
    expect(r.violations.map((v) => v.typeOnly)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(new Set(r.violations.map((v) => v.group))).toEqual(
      new Set(["client → apps/web"]),
    );
  });

  it("resolves the @/ alias and new URL(..., import.meta.url)", () => {
    const r = checkBoundaries(
      snapshot({
        "packages/trace/src/a.ts": [
          'import { x } from "@/cp/b";',
          'export const u = new URL("../../core/src/cp/b.ts", import.meta.url);',
        ].join("\n"),
        "apps/web/src/cp/b.ts": "export const x = 1;",
        "packages/core/src/cp/b.ts": "export const x = 1;",
      }),
    );
    expect(r.violations).toHaveLength(2);
    expect(r.violations.map((v) => v.group)).toEqual([
      "trace → apps/web",
      "trace → core",
    ]);
  });

  it("catches a forbidden specifier in a portable package, not in a test or an app", () => {
    const r = checkBoundaries(
      snapshot({
        "packages/core/src/cp/a.ts":
          'import { useState } from "react";\nimport fs from "node:fs";',
        "packages/core/src/cp/a.test.ts": 'import fs from "node:fs";',
        "apps/cli/src/a.ts": 'import fs from "node:fs";',
        "apps/web/src/components/a.tsx": 'import { useState } from "react";',
        "packages/core/src/cp/types.ts":
          'import type { Node } from "@xyflow/react";',
      }),
    );
    expect(r.violations.map((v) => [v.group, v.file])).toEqual([
      ["core ⊅ react", "packages/core/src/cp/a.ts"],
      ["core ⊅ node", "packages/core/src/cp/a.ts"],
    ]);
    expect(r.typeOnlyForbidden.map((t) => t.file)).toEqual([
      "packages/core/src/cp/types.ts",
    ]);
  });

  it("honours the specifier allow-list and flags stale entries", () => {
    const config = {
      ...DEFAULT_CONFIG,
      testAllowList: [],
      layerExemptions: [],
      specifierAllowList: {
        "packages/core/src/cp/a.ts": {
          specifiers: ["bun:sqlite", "bun:ffi"],
          why: "test",
        },
      },
    };
    const r = checkBoundaries(
      snapshot({
        "packages/core/src/cp/a.ts": 'import { Database } from "bun:sqlite";',
      }),
      config,
    );
    expect(r.violations).toEqual([]);
    expect(r.staleAllowances).toEqual([
      'SPECIFIER_ALLOW_LIST packages/core/src/cp/a.ts "bun:ffi"',
    ]);
  });

  it("fails on a file that matches no map entry and on an unresolvable import", () => {
    const r = checkBoundaries(
      snapshot({ "src/newdir/a.ts": 'import "./missing";' }),
    );
    expect(r.unmapped).toEqual(["src/newdir/a.ts"]);
    const r2 = checkBoundaries(
      snapshot({ "packages/core/src/cp/a.ts": 'import "./missing";' }),
    );
    expect(r2.unresolved).toEqual([
      { file: "packages/core/src/cp/a.ts", specifier: "./missing" },
    ]);
  });

  it("rejects a map whose broad entry shadows a specific one", () => {
    expect(() =>
      validatePackageMap([
        { match: "apps/", pkg: "apps/cli" },
        { match: "apps/web/", pkg: "apps/web" },
      ]),
    ).toThrow(/shadowed/);
    expect(() => validatePackageMap(PACKAGE_MAP)).not.toThrow();
  });
});

describe("import cycles (#570)", () => {
  const A = "packages/core/src/cp/a.ts";
  const B = "packages/core/src/cp/b.ts";
  const C = "packages/core/src/cp/c.ts";
  const cyclesOf = (files: Record<string, string>) =>
    checkBoundaries(snapshot(files)).cycles;

  it("reports a cycle of value imports and fails the run", () => {
    const r = checkBoundaries(
      snapshot({
        [A]: 'import { b } from "./b";\nexport const a = b;',
        [B]: 'import { a } from "./a";\nexport const b = a;',
      }),
    );
    expect(r.cycles).toEqual([[A, B]]);
    expect(hasFailures(r)).toBe(true);
    expect(formatReport(r)).toContain(
      `  cycle of 2 file(s):\n    ${A}\n    ${B}`,
    );
    expect(jsonSummary(r)).toMatchObject({ cycles: [[A, B]] });
  });

  it("reports a cycle through a barrel's re-export", () => {
    expect(
      cyclesOf({
        [A]: 'export * from "./b";',
        [B]: 'import { c } from "./a";\nexport const b = c;',
      }),
    ).toEqual([[A, B]]);
  });

  it("reports a cycle closed by a side-effect import", () => {
    expect(
      cyclesOf({
        [A]: 'import "./b";',
        [B]: 'import { a } from "./a";\nexport const b = a;',
      }),
    ).toEqual([[A, B]]);
  });

  it("reports a file that imports itself", () => {
    expect(cyclesOf({ [A]: 'export * from "./a";' })).toEqual([[A]]);
  });

  it("reports one group for every file of a longer cycle, and separate groups apart", () => {
    const D = "packages/core/src/cp/d.ts";
    const E = "packages/core/src/cp/e.ts";
    expect(
      cyclesOf({
        [A]: 'import "./b";',
        [B]: 'import "./c";',
        [C]: 'import "./a";',
        [D]: 'import "./e";',
        [E]: 'import "./d";',
      }),
    ).toEqual([
      [A, B, C],
      [D, E],
    ]);
  });

  it.each([
    ["import type", 'import type { T } from "./a";'],
    ["inline type imports only", 'import { type T } from "./a";'],
    ["export type ... from", 'export type { T } from "./a";'],
    ["an import() type", 'export type T = import("./a").T;'],
    ["a dynamic import", 'export const load = () => import("./a");'],
  ])("does not count an edge made of %s", (_name, closingEdge) => {
    expect(
      cyclesOf({
        [A]: 'import { b } from "./b";\nexport type T = number;\nexport const a = b;',
        [B]: closingEdge,
      }),
    ).toEqual([]);
  });

  it("counts a declaration that mixes a type and a value", () => {
    expect(
      cyclesOf({
        [A]: 'import { b } from "./b";\nexport type T = number;\nexport const a = b;',
        [B]: 'import { a, type T } from "./a";\nexport const b: T = a;',
      }),
    ).toEqual([[A, B]]);
  });

  it("does not report a diamond", () => {
    const D = "packages/core/src/cp/d.ts";
    expect(
      cyclesOf({
        [A]: 'import "./b";\nimport "./c";',
        [B]: 'import "./d";',
        [C]: 'import "./d";',
        [D]: "export const d = 1;",
      }),
    ).toEqual([]);
  });

  it("finds a cycle across packages", () => {
    const contracts = "packages/contracts/src/x.ts";
    const r = checkBoundaries(
      snapshot({
        [A]: 'import { x } from "@ocpp-cp-simulator/contracts/x";\nexport const a = x;',
        [contracts]:
          'import { a } from "@ocpp-cp-simulator/core/cp/a";\nexport const x = a;',
      }),
    );
    expect(r.cycles).toEqual([[contracts, A]]);
  });
});

describe("extractImports", () => {
  it("finds every import form", () => {
    const kinds = extractImports(
      "src/x.ts",
      [
        'import a from "a";',
        'import "b";',
        'import type { C } from "c";',
        'export * from "d";',
        'export { e } from "e";',
        'await import("f");',
        'import g = require("g");',
      ].join("\n"),
    ).map((i) => [i.specifier, i.kind]);
    expect(kinds).toEqual([
      ["a", "import"],
      ["b", "side-effect"],
      ["c", "import-type"],
      ["d", "export-from"],
      ["e", "export-from"],
      ["f", "dynamic"],
      ["g", "require"],
    ]);
  });

  it("parses the alias out of a commented tsconfig", () => {
    expect(
      readAliases(
        '{ /* c */ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
        "apps/web",
      ),
    ).toEqual({ "@/": "apps/web/src/" });
  });
});

describe("workspace package specifiers", () => {
  const files = new Set([
    "packages/core/src/cp/b.ts",
    "packages/core/src/cp/index.ts",
    "packages/core/src/utils/scenarios/x.json",
    "packages/core/schema/scenario.schema.json",
  ]);
  const coreExports = {
    "./*": "./src/*.ts",
    "./utils/scenarios/x.json": "./src/utils/scenarios/x.json",
    "./schema/scenario.schema.json": "./schema/scenario.schema.json",
  };

  it("maps a subpath through exports: exact keys beat the pattern", () => {
    expect(resolveExport(coreExports, "./cp/b")).toBe("./src/cp/b.ts");
    expect(resolveExport(coreExports, "./utils/scenarios/x.json")).toBe(
      "./src/utils/scenarios/x.json",
    );
    expect(
      resolveExport({ "./a/*": "./x/*.ts", "./*": "./y/*.ts" }, "./a/b"),
    ).toBe("./x/b.ts");
    expect(resolveExport({ "./a": "./a.ts" }, "./b")).toBeNull();
  });

  it("resolves @ocpp-cp-simulator/<pkg>/<path> to a file, or reports it unresolved", () => {
    const manifests = new Map<string, PackageManifest>([
      [
        "@ocpp-cp-simulator/core",
        { dir: "packages/core", exports: coreExports },
      ],
    ]);
    const at = (spec: string) =>
      resolveSpecifier("apps/cli/src/a.ts", spec, files, {}, manifests);
    expect(at("@ocpp-cp-simulator/core/cp/b")).toEqual({
      path: "packages/core/src/cp/b.ts",
      viaPackage: true,
    });
    expect(at("@ocpp-cp-simulator/core/schema/scenario.schema.json")).toEqual({
      path: "packages/core/schema/scenario.schema.json",
      viaPackage: true,
    });
    // a directory import has to say /index: the pattern is a file pattern
    expect(at("@ocpp-cp-simulator/core/cp")).toEqual({
      unresolved: "@ocpp-cp-simulator/core/cp",
    });
    expect(at("@ocpp-cp-simulator/core/cp/index")).toEqual({
      path: "packages/core/src/cp/index.ts",
      viaPackage: true,
    });
    expect(at("@ocpp-cp-simulator/core/cp/missing")).toEqual({
      unresolved: "@ocpp-cp-simulator/core/cp/missing",
    });
    expect(at("@ocpp-cp-simulator/nope/x")).toEqual({
      unresolved: "@ocpp-cp-simulator/nope/x",
    });
    expect(at("zod")).toBeNull();
  });

  it("an allowed edge must use the package specifier, not a path", () => {
    const r = checkBoundaries(
      snapshot({
        "apps/cli/src/a.ts":
          'import { x } from "../../../packages/core/src/cp/b";',
        "apps/cli/src/c.ts":
          'import { x } from "@ocpp-cp-simulator/core/cp/b";',
        "packages/core/src/cp/b.ts": "export const x = 1;",
      }),
    );
    expect(r.violations.map((v) => [v.type, v.group, v.file])).toEqual([
      ["relative", "apps/cli → core (by path)", "apps/cli/src/a.ts"],
    ]);
  });
});

describe("package manifests", () => {
  const manifest = (
    pkg: string,
    extra: Partial<PackageManifest> = {},
  ): PackageManifest => ({
    dir: pkg,
    name: `@ocpp-cp-simulator/${pkg.split("/")[1]}`,
    private: true,
    exports: pkg.startsWith("packages/") ? { "./*": "./src/*.ts" } : undefined,
    ...extra,
  });
  const all = (overrides: Record<string, Partial<PackageManifest>> = {}) =>
    new Map(
      PACKAGE_NAMES.map((p) => [
        p,
        manifest(PACKAGE_DIRS[p], overrides[p] ?? {}),
      ]),
    );
  const sources = {
    "apps/cli/src/a.ts": 'import { x } from "@ocpp-cp-simulator/core/cp/b";',
    "packages/core/src/cp/b.ts": "export const x = 1;",
  };
  const run = (manifests: ReturnType<typeof all>, rootManifestText = "{}") =>
    checkBoundaries({ ...snapshot(sources), manifests, rootManifestText })
      .manifestProblems;

  it("accepts manifests that declare exactly what is imported", () => {
    expect(
      run(
        all({
          "apps/cli": {
            dependencies: { "@ocpp-cp-simulator/core": "workspace:*" },
          },
        }),
      ),
    ).toEqual([]);
  });

  it("reports a missing, an unused and a wrongly ranged dependency", () => {
    expect(run(all())).toEqual([
      'apps/cli/package.json: 1 import(s) of @ocpp-cp-simulator/core but it is not in "dependencies"',
    ]);
    expect(
      run(
        all({
          "apps/cli": {
            dependencies: {
              "@ocpp-cp-simulator/core": "workspace:*",
              "@ocpp-cp-simulator/trace": "workspace:*",
            },
          },
        }),
      ),
    ).toEqual([
      "apps/cli/package.json: declares @ocpp-cp-simulator/trace but nothing imports it",
    ]);
    expect(
      run(
        all({
          "apps/cli": { dependencies: { "@ocpp-cp-simulator/core": "^1.0.0" } },
        }),
      ),
    ).toEqual([
      'apps/cli/package.json: @ocpp-cp-simulator/core must be "workspace:*", not "^1.0.0"',
    ]);
  });

  it("reports a wrong name, a public package, a missing exports map and a missing manifest", () => {
    const m = all({
      "apps/cli": {
        dependencies: { "@ocpp-cp-simulator/core": "workspace:*" },
      },
      trace: { name: "trace", private: false, exports: undefined },
    });
    m.delete("ocpp");
    expect(run(m)).toEqual([
      "packages/ocpp/package.json is missing",
      'packages/trace/package.json: name is "trace", expected "@ocpp-cp-simulator/trace"',
      'packages/trace/package.json: "private" must be true',
      'packages/trace/package.json: a package needs an "exports" map',
    ]);
  });

  it("an edge that is itself a violation does not count as a dependency", () => {
    const r = checkBoundaries({
      ...snapshot({
        "packages/contracts/src/a.ts":
          'import { x } from "@ocpp-cp-simulator/core/cp/b";',
        "packages/core/src/cp/b.ts": "export const x = 1;",
      }),
      manifests: all(),
      rootManifestText: "{}",
    });
    expect(r.violations).toHaveLength(1);
    expect(r.manifestProblems).toEqual([]);
  });

  it("the published root package must not depend on a workspace package", () => {
    expect(
      run(
        all({
          "apps/cli": {
            dependencies: { "@ocpp-cp-simulator/core": "workspace:*" },
          },
        }),
        '{ "dependencies": { "@ocpp-cp-simulator/core": "workspace:*" } }',
      ),
    ).toEqual([
      'package.json: the published root package must not use any "workspace:" dependency',
    ]);
  });
});

describe("layer direction inside src/cp (#571)", () => {
  const cp = "packages/core/src/cp";
  const run = (
    files: Record<string, string>,
    exemptions: { from: string; to: string; why: string }[] = [],
  ) =>
    checkBoundaries(snapshot(files), {
      ...DEFAULT_CONFIG,
      knownViolations: [],
      testAllowList: [],
      specifierAllowList: {},
      layerExemptions: exemptions,
    });

  it("judges each pair of layers", () => {
    const ok = [
      ["domain", "domain"],
      ["domain", "shared"],
      ["application", "domain"],
      ["application", "shared"],
      ["infrastructure", "domain"],
      ["infrastructure", "application"],
      ["infrastructure", "shared"],
      ["shared", "shared"],
    ];
    for (const [a, b] of ok)
      expect(layerViolationOf(`${cp}/${a}/x.ts`, `${cp}/${b}/y.ts`)).toBeNull();
    const bad = [
      ["domain", "application"],
      ["domain", "infrastructure"],
      ["application", "infrastructure"],
      ["shared", "domain"],
      ["shared", "application"],
      ["shared", "infrastructure"],
    ];
    for (const [a, b] of bad)
      expect(layerViolationOf(`${cp}/${a}/x.ts`, `${cp}/${b}/y.ts`)).toEqual({
        group: `layer ${a} ⊅ ${b}`,
      });
  });

  it("seals domain and shared from core code outside src/cp and from apps", () => {
    for (const a of ["domain", "shared"]) {
      expect(
        layerViolationOf(`${cp}/${a}/x.ts`, "packages/core/src/utils/y.ts"),
      ).not.toBeNull();
      expect(
        layerViolationOf(`${cp}/${a}/x.ts`, "apps/cli/src/y.ts"),
      ).not.toBeNull();
    }
    expect(
      layerViolationOf(
        `${cp}/application/x.ts`,
        "packages/core/src/utils/y.ts",
      ),
    ).toBeNull();
    expect(
      layerViolationOf(`${cp}/domain/x.ts`, "packages/ocpp/src/y.ts"),
    ).toBeNull();
  });

  it("fails on an import against the direction, type-only ones included", () => {
    const r = run({
      [`${cp}/domain/a.ts`]: 'import type { B } from "../application/b";',
      [`${cp}/application/b.ts`]: "export type B = 1;",
    });
    expect(r.violations.map((v) => [v.type, v.group, v.typeOnly])).toEqual([
      ["layer", "layer domain ⊅ application", true],
    ]);
    expect(hasFailures(r)).toBe(true);
  });

  it("does not check test files", () => {
    const r = run({
      [`${cp}/domain/a.test.ts`]: 'import "../infrastructure/b";',
      [`${cp}/infrastructure/b.ts`]: "export const b = 1;",
    });
    expect(r.violations).toEqual([]);
  });

  it("downgrades an exempted edge to a warning and fails once the exemption is stale", () => {
    const files = {
      [`${cp}/domain/a.ts`]: 'import { b } from "../infrastructure/b";',
      [`${cp}/infrastructure/b.ts`]: "export const b = 1;",
    };
    const exemption = {
      from: `${cp}/domain/a.ts`,
      to: `${cp}/infrastructure/b.ts`,
      why: "test",
    };
    const r = run(files, [exemption]);
    expect(r.violations).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.staleAllowances).toEqual([]);

    const fixed = run(
      {
        [`${cp}/domain/a.ts`]: "export const a = 1;",
        [`${cp}/infrastructure/b.ts`]: "export const b = 1;",
      },
      [exemption],
    );
    expect(fixed.staleAllowances).toEqual([
      `LAYER_EXEMPTIONS ${exemption.from} -> ${exemption.to}`,
    ]);
    expect(hasFailures(fixed)).toBe(true);
  });

  it("exempts one pair only, not the whole importing file", () => {
    const r = run(
      {
        [`${cp}/domain/a.ts`]:
          'import "../infrastructure/b";\nimport "../infrastructure/c";',
        [`${cp}/infrastructure/b.ts`]: "export const b = 1;",
        [`${cp}/infrastructure/c.ts`]: "export const c = 1;",
      },
      [
        {
          from: `${cp}/domain/a.ts`,
          to: `${cp}/infrastructure/b.ts`,
          why: "test",
        },
      ],
    );
    expect(r.violations.map((v) => v.target)).toEqual([
      `${cp}/infrastructure/c.ts`,
    ]);
  });

  it("every exemption of the real tree carries a reason", () => {
    for (const e of DEFAULT_CONFIG.layerExemptions)
      expect(e.why.length).toBeGreaterThan(20);
  });
});
