import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { validateScenarioSchema } from "../scenarioSchemaValidator";

/**
 * Issue #214 — conformance test proving `schema/scenario.schema.json`
 * accepts every scenario file this repo actually ships. This is the key
 * test: it guards against schema drift (a field the schema doesn't know
 * about, a required field the shipped templates don't carry, etc.) by
 * running the real fixtures through the real validator, not hand-picked
 * samples.
 */

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function jsonFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name));
}

const fixturePaths = [
  ...jsonFilesIn(join(repoRoot, "src/utils/scenarios")),
  ...jsonFilesIn(join(repoRoot, "docs/examples/scenarios")),
];

describe("scenario schema conformance", () => {
  it("finds a non-trivial number of shipped scenario fixtures", () => {
    // Sanity guard: if this drops to 0 the test below would vacuously pass.
    expect(fixturePaths.length).toBeGreaterThan(30);
  });

  it.each(fixturePaths.map((p) => [p] as const))(
    "%s validates against schema/scenario.schema.json",
    (path) => {
      const data: unknown = JSON.parse(readFileSync(path, "utf-8"));
      const result = validateScenarioSchema(data);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    },
  );

  it("validates every shipped fixture (aggregate count)", () => {
    const results = fixturePaths.map((path) => ({
      path,
      ...validateScenarioSchema(
        JSON.parse(readFileSync(path, "utf-8")) as unknown,
      ),
    }));
    const failures = results.filter((r) => !r.valid);
    expect(failures).toEqual([]);
    // Prove the count, not just "no failures" (a moved/renamed fixtures dir
    // would otherwise silently validate zero files).
    expect(results.length).toBe(fixturePaths.length);
  });
});
