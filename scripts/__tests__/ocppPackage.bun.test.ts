import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { exportTargets, publishManifest } from "../build-ocpp-package";
import type { OcppManifest } from "../build-ocpp-package";
import { ENTRY_POINTS, tarballProblems } from "../check-ocpp-pack";
import { REPO_ROOT } from "../check-package-boundaries";

const source = JSON.parse(
  readFileSync(join(REPO_ROOT, "packages/ocpp/package.json"), "utf8"),
) as OcppManifest;

describe("publishable packages/ocpp (#1053)", () => {
  it("publishManifest hoists publishConfig.exports and drops workspace fields", () => {
    const m = publishManifest(source);
    expect(m.exports).toEqual(source.publishConfig!.exports!);
    expect(m.private).toBe(false);
    expect(m.scripts).toBeUndefined();
    expect(m.publishConfig).toEqual({ access: "public" });
    expect(m.dependencies).toEqual(source.dependencies!);
    expect(Object.keys(m).slice(0, 3)).toEqual(["name", "version", "private"]);
  });

  it("publishManifest refuses a manifest that would not install", () => {
    expect(() =>
      publishManifest({ ...source, publishConfig: { access: "public" } }),
    ).toThrow(/no "publishConfig.exports"/);
    expect(() =>
      publishManifest({
        ...source,
        dependencies: { "@ocpp-cp-simulator/core": "workspace:*" },
      }),
    ).toThrow(/workspace:\*/);
  });

  it("every published entry point is imported by the pack check", () => {
    const keys = Object.keys(source.publishConfig!.exports!).filter(
      (k) => k !== "./package.json",
    );
    const covered = (key: string) => {
      const name = `@ocpp-cp-simulator/ocpp${key.slice(1)}`;
      if (!name.includes("*")) return ENTRY_POINTS.includes(name as never);
      const [pre] = name.split("*");
      return ENTRY_POINTS.some((e) => e.startsWith(pre!));
    };
    // v16 and v21 type patterns are type-only modules, checked via v201's
    expect(keys.filter((k) => !covered(k))).toEqual([
      "./v16/types/*",
      "./v21/types/*",
    ]);
    expect(exportTargets(source.publishConfig!.exports!)).toContain(
      "./lib/index.js",
    );
  });

  it("tarballProblems flags missing files and shipped TypeScript sources", () => {
    const ok = [
      "package/package.json",
      "package/LICENSE",
      "package/lib/index.js",
      "package/lib/index.d.ts",
      "package/lib/validate.js",
      "package/vendor/ocpp-schemas/NOTICE",
      "package/vendor/ocpp-schemas/v16/BootNotification.json",
    ];
    expect(tarballProblems(ok)).toEqual([]);
    expect(
      tarballProblems([
        ...ok.filter((f) => !f.endsWith("NOTICE")),
        "package/src/index.ts",
      ]),
    ).toEqual([
      "missing vendor/ocpp-schemas/NOTICE",
      "ships TypeScript source src/index.ts",
    ]);
  });
});
