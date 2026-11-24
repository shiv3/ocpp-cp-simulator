// scripts/build-ocpp-package.ts
//
// Builds the publishable form of packages/ocpp (#1053) into packages/ocpp/dist,
// a self-contained package directory:
//
//   dist/package.json         the manifest below (publishManifest)
//   dist/lib/**/*.js, *.d.ts  ESM JavaScript + declarations emitted by tsc
//   dist/vendor/ocpp-schemas  the OCA JSON schemas, copied byte for byte (with
//                             their NOTICE and README), not re-serialized by tsc
//   dist/LICENSE              the project's Apache-2.0 license
//
//   bun run --cwd packages/ocpp build      (or: bun run scripts/build-ocpp-package.ts)
//
// packages/ocpp/package.json is the workspace form: its `exports` point at the
// TypeScript sources, so the simulator, CLI, web console and tests resolve the
// package from source with no build step and no custom condition (Bun applies
// a custom export condition only through a command-line flag). The published
// entry points are declared next to them, in `publishConfig.exports`, with the
// same keys; publishManifest() hoists them into the built manifest.
// scripts/check-package-boundaries.ts keeps the two maps in step, and
// scripts/check-ocpp-pack.ts installs the packed result outside the workspace.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ExportTarget =
  string | null | { readonly [condition: string]: ExportTarget };

export interface OcppManifest {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly exports: Readonly<Record<string, ExportTarget>>;
  readonly publishConfig?: {
    readonly access?: string;
    readonly exports?: Readonly<Record<string, ExportTarget>>;
  };
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly [field: string]: unknown;
}

/**
 * The manifest of the built package: the workspace manifest with
 * `publishConfig.exports` as its `exports`, `private: false`, and without the
 * workspace-only fields (scripts, devDependencies). Throws when there is no
 * `publishConfig.exports` or a dependency uses the `workspace:` protocol.
 */
export function publishManifest(source: OcppManifest): Record<string, unknown> {
  const published = source.publishConfig?.exports;
  if (!published)
    throw new Error(`${source.name}: no "publishConfig.exports" to publish`);
  for (const [dep, range] of Object.entries(source.dependencies ?? {}))
    if (range.startsWith("workspace:"))
      throw new Error(
        `${source.name}: dependency ${dep} is ${range}, which does not install outside the workspace`,
      );
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "scripts" || key === "devDependencies") continue;
    if (key === "private") out.private = false;
    else if (key === "exports") out.exports = published;
    else if (key === "publishConfig") {
      const { exports: _drop, ...rest } = source.publishConfig ?? {};
      void _drop;
      if (Object.keys(rest).length > 0) out.publishConfig = rest;
    } else out[key] = value;
  }
  if (!("private" in out)) out.private = false;
  return out;
}

/** Every file path an exports map names (patterns keep their `*`). */
export function exportTargets(
  exportsMap: Readonly<Record<string, ExportTarget>>,
): string[] {
  const out: string[] = [];
  const visit = (t: ExportTarget): void => {
    if (typeof t === "string") out.push(t);
    else if (t) for (const v of Object.values(t)) visit(v);
  };
  for (const t of Object.values(exportsMap)) visit(t);
  return out;
}

function run(cmd: string, args: string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.join(" ")} exited with ${r.status}`);
}

export function buildOcppPackage(rootDir: string): string {
  const pkgDir = join(rootDir, "packages", "ocpp");
  const dist = join(pkgDir, "dist");
  const source = JSON.parse(
    readFileSync(join(pkgDir, "package.json"), "utf8"),
  ) as OcppManifest;
  const manifest = publishManifest(source);

  rmSync(dist, { recursive: true, force: true });
  const tsc = join(
    rootDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsc.cmd" : "tsc",
  );
  run(tsc, ["-p", join(pkgDir, "tsconfig.build.json")], rootDir);

  // tsc mirrors the package root (src/ imports ../../vendor/...): keep the
  // code as lib/ at the same depth, so lib/v16/schemas.js still reaches
  // ../../vendor, and replace the JSON tsc re-serialized with the originals.
  renameSync(join(dist, ".tsc", "src"), join(dist, "lib"));
  rmSync(join(dist, ".tsc"), { recursive: true, force: true });
  cpSync(join(pkgDir, "vendor"), join(dist, "vendor"), { recursive: true });
  cpSync(join(rootDir, "LICENSE"), join(dist, "LICENSE"));
  writeFileSync(
    join(dist, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  // A pattern target (lib/v16/types/*.js) counts when its directory exists.
  const missing = exportTargets(
    manifest.exports as Record<string, ExportTarget>,
  )
    .map((t) => join(dist, t.includes("*") ? dirname(t) : t))
    .filter((p) => !existsSync(p));
  if (missing.length > 0)
    throw new Error(
      `built package misses export targets:\n${missing.join("\n")}`,
    );
  return dist;
}

if (import.meta.main) {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dist = buildOcppPackage(rootDir);
  console.log(`Built ${dist}`);
}
