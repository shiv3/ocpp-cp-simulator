// The golden wire test (docs/analyses/charger-engine.md, rule 4): real
// ChargePoint instances against an in-process fake CSMS, on OCPP 1.6 and
// 2.0.1, with the ordered OCPP frames compared with committed fixtures. With
// nothing configured, the bytes on the wire and their order must not change.
import { describe, expect, test } from "bun:test";
import { goldenCases as handCases } from "./cases";
import { regressionCases } from "./regressionCases";
import { PINNED_TEMPLATE_IDS, scenarioCases } from "./scenarioCases";
import { scenarioTemplates } from "../../utils/scenarioTemplates";
import {
  fixtureNames,
  readFixture,
  recordCase,
  recordMissingFixture,
} from "./golden";

const goldenCases = [...handCases, ...regressionCases, ...scenarioCases];

describe("golden wire", () => {
  test("case names are unique", () => {
    const names = goldenCases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every fixture belongs to a case", () => {
    const names = new Set(goldenCases.map((c) => c.name));
    expect(fixtureNames().filter((n) => !names.has(n))).toEqual([]);
  });

  test("the built-in template set is the pinned one", () => {
    expect(scenarioTemplates.map((t) => t.id).sort()).toEqual(
      [...PINNED_TEMPLATE_IDS].sort(),
    );
  });

  for (const c of goldenCases) {
    test.concurrent(
      c.name,
      async () => {
        const lines = await recordCase(c);
        if (
          process.env.GOLDEN_PRINT &&
          c.name.includes(process.env.GOLDEN_PRINT)
        ) {
          console.log(`--- ${c.name}\n${lines.join("\n")}`);
        }
        if (recordMissingFixture(c.name, lines)) return;
        const expected = readFixture(c.name);
        if (expected === null) {
          throw new Error(
            `no fixture for ${c.name}; record it once with GOLDEN_RECORD=1`,
          );
        }
        expect(lines).toEqual(expected);
      },
      90_000,
    );
  }
});
