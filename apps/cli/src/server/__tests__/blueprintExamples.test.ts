import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { loadBlueprintFiles } from "../blueprintFiles";

/**
 * The documented sample blueprints under `docs/examples/blueprints/` (#331,
 * #241) and their per-value sources files. Every sample is picked up
 * automatically, so a new one is held to the same rules as the first:
 *
 * - it loads through `--blueprint` (same schema as `blueprint.save`);
 * - every value it sets has exactly one sources entry naming a document of
 *   `source.documents`, that document's SHA-256, a locator and an evidence type;
 * - `assumption` is only allowed where the simulator, not the vendor, decides
 *   (the capability profile's response form, behaviour params); identity and
 *   hardware values must come from the documents;
 * - the description carries the disclaimer of docs/concepts/charger-presets.md.
 */
const DIR = new URL("../../../../../docs/examples/blueprints/", import.meta.url)
  .pathname;

const EVIDENCE = new Set([
  "documented",
  "derived",
  "simulatorDefault",
  "assumption",
]);
const ASSUMPTION_ALLOWED = [
  "/params/capabilityProfile/",
  "/params/behaviorParams/",
];

interface SourcesEntry {
  pointer: string;
  documentId: string;
  documentSha256: string;
  locator: string;
  evidence: string;
  note?: string;
}

/** JSON Pointer escaping (RFC 6901). */
const esc = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");

const isScalar = (v: unknown) => v === null || typeof v !== "object";

/**
 * The values a blueprint sets, as JSON Pointers. A leaf is a scalar, or an
 * array of scalars (a list such as `disabledActions` is one documented value).
 */
function leaves(value: unknown, at: string, out: string[]): string[] {
  if (isScalar(value) || (Array.isArray(value) && value.every(isScalar))) {
    out.push(at);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => leaves(v, `${at}/${i}`, out));
  } else {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      leaves(v, `${at}/${esc(k)}`, out);
    }
  }
  return out;
}

const samples = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".json") && !f.endsWith(".sources.json"))
  .sort();

describe("documented sample blueprints (#331)", () => {
  it("exist", () => {
    expect(samples).toContain("abb-terra-ac-22kw-socket-fw1.6.6.json");
  });

  for (const file of samples) {
    describe(file, () => {
      const [blueprint] = loadBlueprintFiles([path.join(DIR, file)]);
      const sourcesFile = file.replace(/\.json$/, ".sources.json");

      it("validates against the blueprint schema, version 1, with provenance", () => {
        expect(blueprint).toBeDefined();
        expect(blueprint!.schemaVersion).toBe(1);
        expect(blueprint!.id).toBe(file.replace(/\.json$/, ""));
        expect(blueprint!.source?.format).toBe("manual");
        expect(blueprint!.source?.citations).toBe(
          `docs/examples/blueprints/${sourcesFile}`,
        );
        expect(blueprint!.source!.documents.length).toBeGreaterThan(0);
      });

      it("carries the disclaimer and no wsUrl", () => {
        expect(blueprint!.description).toMatch(
          /^Modelled on public documentation of /,
        );
        expect(blueprint!.description).toContain(
          "Not affiliated with or endorsed by",
        );
        expect(blueprint!.description).toContain(
          "not a certified or complete model",
        );
        expect(blueprint!.description).toContain("trademarks of their owners");
        expect(blueprint!.name).toContain("modelled on public");
        expect(blueprint!.params.wsUrl).toBeUndefined();
      });

      it("has a sources entry for every value it sets, and none for values it does not", () => {
        const sources = JSON.parse(
          fs.readFileSync(path.join(DIR, sourcesFile), "utf8"),
        ) as {
          blueprint: string;
          values: SourcesEntry[];
        };
        expect(sources.blueprint).toBe(file);
        const set = leaves(blueprint!.params, "/params", []);
        if (blueprint!.evSettings !== undefined)
          leaves(blueprint!.evSettings, "/evSettings", set);
        if (blueprint!.scenarioTemplateId !== undefined)
          set.push("/scenarioTemplateId");
        const pointers = sources.values.map((v) => v.pointer);
        expect(new Set(pointers).size).toBe(pointers.length);
        expect([...pointers].sort()).toEqual([...set].sort());
      });

      it("cites a listed document, its SHA-256, a locator and a known evidence type", () => {
        const sources = JSON.parse(
          fs.readFileSync(path.join(DIR, sourcesFile), "utf8"),
        ) as {
          values: SourcesEntry[];
        };
        const docs = new Map(
          blueprint!.source!.documents.map((d) => [d.id, d]),
        );
        for (const entry of sources.values) {
          const doc = docs.get(entry.documentId);
          expect(doc, entry.pointer).toBeDefined();
          expect(entry.documentSha256, entry.pointer).toBe(doc!.sha256);
          expect(entry.locator.length, entry.pointer).toBeGreaterThan(0);
          expect(EVIDENCE.has(entry.evidence), entry.pointer).toBe(true);
          if (entry.evidence === "derived" || entry.evidence === "assumption") {
            expect(
              entry.note?.length ?? 0,
              `${entry.pointer} needs a note`,
            ).toBeGreaterThan(0);
          }
          if (entry.evidence === "assumption") {
            expect(
              ASSUMPTION_ALLOWED.some((p) => entry.pointer.startsWith(p)),
              `${entry.pointer}: assumption is not allowed here`,
            ).toBe(true);
          }
        }
        for (const u of blueprint!.source!.unmapped ?? []) {
          expect(docs.has(u.documentId), u.what).toBe(true);
        }
      });
    });
  }
});
