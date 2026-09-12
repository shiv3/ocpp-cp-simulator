// src/cli/exportK6/__tests__/documentedSubset.test.ts
// The export's subset is deliberate; what was missing is anything that fails
// when it moves (#329).
//
// `export-k6` implements a reduced version of the scenario semantics on
// purpose — enough to put realistic OCPP traffic on a CSMS at volume, not the
// simulator's meter physics. The failure mode is not the subset, it is that a
// field added to the domain used to reach neither the runtime nor the page a
// user would look at, so the export diverged silently. This test makes that
// loud: it reads the coverage tables out of
// `docs/entities/cli.md#export-k6` and holds them against
// `schema/scenario.schema.json` (what the domain has) and the runtime's own
// source (what the export actually reads).
//
// It is deliberately NOT a daemon/k6 equivalence test: most rows would fail by
// design. It asserts only *which* node types and `evSettings` fields the
// exported runtime honours at all.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SUPPORTED_NODE_TYPES } from "../runExportK6";
import { RUNTIME_FILES } from "../runtimeManifest";
import { join } from "node:path";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const docPath = join(repoRoot, "docs", "entities", "cli.md");
const schemaPath = join(repoRoot, "schema", "scenario.schema.json");
const runtimeDir = fileURLToPath(new URL("../runtime", import.meta.url));

const HOW_TO_FIX =
  "either implement it in src/cli/exportK6/runtime/ or record it as not implemented " +
  "in the coverage tables under docs/entities/cli.md#export-k6 — the export's " +
  "subset is allowed to be a subset, it is not allowed to be undocumented";

/** Rows of the first markdown table after `heading`, as `[cell0, honoured]`.
 *  `honoured` is true when the second column begins with "Yes". */
function coverageTable(doc: string, firstColumn: string): Map<string, boolean> {
  // Whitespace-tolerant: prettier owns this file's column padding.
  const header = new RegExp(
    `^\\|\\s*${firstColumn}\\s*\\|\\s*Honoured\\s*\\|\\s*$`,
    "m",
  );
  const at = doc.search(header);
  expect(
    at,
    `docs/entities/cli.md#export-k6 no longer has a "${firstColumn} | Honoured" table — the coverage tables this test reads are gone; restore them or delete this test deliberately`,
  ).toBeGreaterThan(-1);
  const rows = new Map<string, boolean>();
  const lines = doc.slice(at).split("\n");
  // lines[0] is the header row, lines[1] the `| --- |` separator.
  for (const line of lines.slice(2)) {
    if (!line.startsWith("|")) break;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const name = cells[0].replace(/`/g, "");
    const honoured = /^\*{0,2}Yes\b/.test(cells[1]);
    expect(
      honoured || /^\*{0,2}No\b/.test(cells[1]),
      `row "${name}" must say Yes or No in its Honoured column, not "${cells[1]}"`,
    ).toBe(true);
    rows.set(name, honoured);
  }
  expect(rows.size, `the "${firstColumn}" table is empty`).toBeGreaterThan(0);
  return rows;
}

function runtimeSource(): string {
  return RUNTIME_FILES.map((f) =>
    readFileSync(join(runtimeDir, f), "utf8"),
  ).join("\n");
}

const doc = readFileSync(docPath, "utf8");
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
  $defs: {
    node: { properties: { type: { enum: string[] } } };
    evSettings: { properties: Record<string, unknown> };
  };
};

describe("export-k6's documented subset matches what it implements (#329)", () => {
  describe("scenario node types", () => {
    const documented = coverageTable(doc, "Scenario node type");
    const schemaTypes = schema.$defs.node.properties.type.enum;

    it("gives every node type in the scenario schema a row", () => {
      for (const type of schemaTypes) {
        expect(
          documented.has(type),
          `scenario node type "${type}" is in schema/scenario.schema.json but has no row in docs/entities/cli.md#export-k6 — ${HOW_TO_FIX}`,
        ).toBe(true);
      }
    });

    it("documents no node type the scenario schema does not have", () => {
      for (const type of documented.keys()) {
        expect(
          schemaTypes.includes(type),
          `docs/entities/cli.md#export-k6 has a row for node type "${type}", which schema/scenario.schema.json does not define — delete the row or add the type to the schema`,
        ).toBe(true);
      }
    });

    it("marks Yes exactly the types the exporter accepts", () => {
      const documentedYes = [...documented]
        .filter(([, yes]) => yes)
        .map(([t]) => t)
        .sort();
      expect(
        documentedYes,
        `the node types marked Yes in docs/entities/cli.md#export-k6 and SUPPORTED_NODE_TYPES in src/cli/exportK6/runExportK6.ts disagree — ${HOW_TO_FIX}`,
      ).toEqual([...SUPPORTED_NODE_TYPES].sort());
    });

    it("has a walk for every type the exporter accepts", () => {
      const source = readFileSync(join(runtimeDir, "interpreter.ts"), "utf8");
      for (const type of SUPPORTED_NODE_TYPES) {
        // `start` is the entry point, consumed by the walk rather than by a
        // case of the node switch.
        if (type === "start") continue;
        expect(
          source.includes(`case "${type}":`) ||
            source.includes(`case "${type}": {`) ||
            source.includes(`case "${type}": `),
          `"${type}" is accepted by export-k6 but src/cli/exportK6/runtime/interpreter.ts has no case for it, so an exported bundle throws on it at run time`,
        ).toBe(true);
      }
    });
  });

  describe("evSettings fields", () => {
    const documented = coverageTable(doc, "`evSettings` field");
    const schemaFields = Object.keys(schema.$defs.evSettings.properties);
    // What the runtime actually reads. Two independent readings, so a
    // refactor that hides one of them still trips the other: the property
    // accesses in the emitted source, and the mirror interface the runtime
    // declares for the scenario's evSettings object.
    const read = new Set(
      [...runtimeSource().matchAll(/evSettings\?\.(\w+)/g)].map((m) => m[1]),
    );
    const mirrored = new Set(
      [
        ...(
          readFileSync(join(runtimeDir, "types.ts"), "utf8").match(
            /export interface EvSettingsJson \{[^}]*\}/,
          )?.[0] ?? ""
        ).matchAll(/^\s*(\w+)\??:/gm),
      ].map((m) => m[1]),
    );

    it("gives every evSettings field in the scenario schema a row", () => {
      for (const field of schemaFields) {
        expect(
          documented.has(field),
          `evSettings.${field} is in schema/scenario.schema.json but has no row in docs/entities/cli.md#export-k6 — ${HOW_TO_FIX}`,
        ).toBe(true);
      }
    });

    it("documents no evSettings field the scenario schema does not have", () => {
      for (const field of documented.keys()) {
        expect(
          schemaFields.includes(field),
          `docs/entities/cli.md#export-k6 has a row for evSettings.${field}, which schema/scenario.schema.json does not define — delete the row or add the field to the schema`,
        ).toBe(true);
      }
    });

    it("marks Yes exactly the fields the runtime reads", () => {
      const documentedYes = [...documented]
        .filter(([, yes]) => yes)
        .map(([f]) => f)
        .sort();
      expect(
        documentedYes,
        `the evSettings fields marked Yes in docs/entities/cli.md#export-k6 and the ones src/cli/exportK6/runtime/ actually reads disagree — ${HOW_TO_FIX}`,
      ).toEqual([...read].sort());
    });

    it("mirrors in the runtime's own type exactly the fields it reads", () => {
      // Keeps the reading above honest: a field declared in EvSettingsJson but
      // never read is dead weight the table would claim credit for, and a
      // field read through a destructured alias would be missing here.
      expect(
        [...mirrored].sort(),
        `EvSettingsJson in src/cli/exportK6/runtime/types.ts and the evSettings fields the runtime reads disagree — ${HOW_TO_FIX}`,
      ).toEqual([...read].sort());
    });
  });
});
