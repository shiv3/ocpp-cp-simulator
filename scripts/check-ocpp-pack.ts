// scripts/check-ocpp-pack.ts
//
// Proves that @ocpp-cp-simulator/ocpp installs and runs outside the monorepo
// (#1053): builds packages/ocpp/dist (scripts/build-ocpp-package.ts), packs it
// with `bun pm pack`, installs the tarball with npm into a throwaway project in
// the system temp directory (no workspace, no simulator package), then
//
//   - checks the tarball's file list (lib/, the verbatim vendor/ schemas with
//     the OCA NOTICE, LICENSE; no TypeScript sources);
//   - imports every public entry point under Node and under Bun and validates
//     one valid and one invalid message per OCPP version;
//   - type-checks a consumer against the shipped declarations with
//     `module: nodenext` (what a Node ESM project uses).
//
//   bun run check:ocpp-pack           # exit 1 on any failure
//   bun run check:ocpp-pack --keep    # keep the temp project and print its path
//
// Needs network access for npm to fetch ajv / ajv-draft-04. Publishes nothing.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildOcppPackage } from "./build-ocpp-package";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The public entry points, as a consumer imports them. */
export const ENTRY_POINTS = [
  "@ocpp-cp-simulator/ocpp",
  "@ocpp-cp-simulator/ocpp/v16",
  "@ocpp-cp-simulator/ocpp/v201",
  "@ocpp-cp-simulator/ocpp/v21",
  "@ocpp-cp-simulator/ocpp/validation",
  "@ocpp-cp-simulator/ocpp/schema-sources",
  "@ocpp-cp-simulator/ocpp/v201/types/boot-notification-request",
] as const;

/** Files the tarball must contain (paths inside `package/`). */
export const REQUIRED_FILES = [
  "package.json",
  "LICENSE",
  "lib/index.js",
  "lib/index.d.ts",
  "lib/validate.js",
  "vendor/ocpp-schemas/NOTICE",
  "vendor/ocpp-schemas/v16/BootNotification.json",
] as const;

/** Problems with a tarball listing (`package/...` paths). */
export function tarballProblems(entries: readonly string[]): string[] {
  const files = new Set(entries.map((e) => e.replace(/^package\//, "")));
  const problems = REQUIRED_FILES.filter((f) => !files.has(f)).map(
    (f) => `missing ${f}`,
  );
  for (const f of files)
    if (/\.tsx?$/.test(f) && !f.endsWith(".d.ts"))
      problems.push(`ships TypeScript source ${f}`);
  return problems;
}

const CONSUMER_JS = `
import * as root from "@ocpp-cp-simulator/ocpp";
import * as v16 from "@ocpp-cp-simulator/ocpp/v16";
import * as v201 from "@ocpp-cp-simulator/ocpp/v201";
import * as v21 from "@ocpp-cp-simulator/ocpp/v21";
import * as validation from "@ocpp-cp-simulator/ocpp/validation";
import { schemaNotice, schemaSources } from "@ocpp-cp-simulator/ocpp/schema-sources";
import "@ocpp-cp-simulator/ocpp/v201/types/boot-notification-request";
import manifest from "@ocpp-cp-simulator/ocpp/package.json" with { type: "json" };

const fail = (msg) => { console.error("FAIL: " + msg); process.exit(1); };
const expect = (cond, msg) => { if (!cond) fail(msg); };

const boot16 = { chargePointVendor: "Acme", chargePointModel: "X1" };
expect(v16.isValidBootNotificationRequestV16(boot16), "v16 BootNotification valid");
expect(!v16.isValidBootNotificationRequestV16({ chargePointVendor: "Acme" }), "v16 missing model rejected");

const boot201 = { reason: "PowerUp", chargingStation: { model: "X1", vendorName: "Acme" } };
expect(v201.isValidBootNotificationRequestV201(boot201), "v201 BootNotification valid");
expect(
  validation.strictValidationErrors(v201.v201Schemas.bootNotificationRequestV201, { reason: "Nope" }).length > 0,
  "v201 strict errors reported",
);
expect(v21.isValidBootNotificationRequestV21(boot201), "v21 BootNotification valid");
expect(!root.isValidBootNotificationRequestV21({ reason: "PowerUp" }), "v21 missing station rejected");
expect(root.ActionNameV16.BootNotification === "BootNotification", "enums from the root entry");
expect(root.OCPPErrorCodeV201.FormatViolation === "FormatViolation", "2.x error codes");
expect(typeof validation.actionValidatorV201.BootNotification === "function", "action validator map");
expect(schemaNotice.includes("Open Charge Alliance"), "OCA notice text");
expect(schemaSources.v16.length > 0 && schemaSources.v16[0].text.includes("\\r\\n"), "verbatim schema text");
expect(manifest.name === "@ocpp-cp-simulator/ocpp", "package.json entry");

console.log("ok " + (typeof Bun === "undefined" ? "node " + process.version : "bun " + Bun.version));
`;

const CONSUMER_TS = `
import { isValidBootNotificationRequestV16, type BootNotificationRequestV16 } from "@ocpp-cp-simulator/ocpp/v16";
import type { BootNotificationRequestV201 } from "@ocpp-cp-simulator/ocpp/v201";
import type { BootNotificationRequestV201 as Direct } from "@ocpp-cp-simulator/ocpp/v201/types/boot-notification-request";
import { strictValidationIssues, type ValidationIssue } from "@ocpp-cp-simulator/ocpp/validation";
import { schemaSources, type OcppSchemaSource } from "@ocpp-cp-simulator/ocpp/schema-sources";
import { ActionNameV201, schemas } from "@ocpp-cp-simulator/ocpp";

const a: BootNotificationRequestV16 = { chargePointVendor: "A", chargePointModel: "B" };
const b: BootNotificationRequestV201 = { reason: "PowerUp", chargingStation: { model: "M", vendorName: "V" } };
const c: Direct = b;
const ok: boolean = isValidBootNotificationRequestV16(a);
const issues: ValidationIssue[] = strictValidationIssues(schemas.v201.bootNotificationRequestV201!, c);
const first: OcppSchemaSource | undefined = schemaSources.v21[0];
const action: string = ActionNameV201.BootNotification;
export { ok, issues, first, action };
`;

function sh(
  cmd: string,
  args: string[],
  cwd: string,
): { status: number; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return {
    status: r.status ?? 1,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(),
  };
}

function must(cmd: string, args: string[], cwd: string): string {
  const r = sh(cmd, args, cwd);
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}):\n${r.out}`);
  return r.out;
}

function main(argv: string[]): number {
  const keep = argv.includes("--keep");
  const dist = buildOcppPackage(ROOT);
  const work = mkdtempSync(join(tmpdir(), "ocpp-pack-"));
  const problems: string[] = [];
  try {
    const packDir = join(work, "pack");
    must("bun", ["pm", "pack", "--destination", packDir, "--quiet"], dist);
    const tgzName = JSON.parse(readFileSync(join(dist, "package.json"), "utf8"))
      .name.replace(/^@/, "")
      .replace("/", "-");
    const version = JSON.parse(
      readFileSync(join(dist, "package.json"), "utf8"),
    ).version;
    const tgz = join(packDir, `${tgzName}-${version}.tgz`);
    const listing = must("tar", ["-tzf", tgz], work).split("\n");
    problems.push(...tarballProblems(listing).map((p) => `tarball: ${p}`));

    const app = join(work, "consumer");
    cpSync(tgz, join(app, "ocpp.tgz"));
    writeFileSync(
      join(app, "package.json"),
      JSON.stringify(
        {
          name: "ocpp-pack-consumer",
          private: true,
          type: "module",
          dependencies: { "@ocpp-cp-simulator/ocpp": "file:./ocpp.tgz" },
        },
        null,
        2,
      ),
    );
    must(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        "--loglevel=error",
      ],
      app,
    );
    writeFileSync(join(app, "check.mjs"), CONSUMER_JS);
    for (const [runtime, args] of [
      ["node", ["check.mjs"]],
      ["bun", ["check.mjs"]],
    ] as const) {
      const r = sh(runtime, [...args], app);
      if (r.status === 0) console.log(`  ${r.out}`);
      else problems.push(`${runtime}: ${r.out}`);
    }

    writeFileSync(join(app, "check.ts"), CONSUMER_TS);
    writeFileSync(
      join(app, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "ES2022",
          strict: true,
          noEmit: true,
          noUncheckedIndexedAccess: true,
          types: [],
        },
        files: ["check.ts"],
      }),
    );
    const tsc = sh(
      join(ROOT, "node_modules", ".bin", "tsc"),
      ["-p", join(app, "tsconfig.json")],
      app,
    );
    if (tsc.status === 0) console.log("  ok tsc (module nodenext)");
    else problems.push(`tsc: ${tsc.out}`);
  } finally {
    if (keep) console.log(`kept ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
  if (problems.length > 0) {
    console.error(
      `@ocpp-cp-simulator/ocpp pack check failed:\n${problems.join("\n")}`,
    );
    return 1;
  }
  console.log(
    `@ocpp-cp-simulator/ocpp installs from its tarball (${ENTRY_POINTS.length} entry points, Node + Bun + tsc)`,
  );
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
