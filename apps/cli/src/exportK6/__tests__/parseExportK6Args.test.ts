import { describe, expect, it } from "vitest";
import { parseExportK6Args } from "../parseExportK6Args";

describe("parseExportK6Args", () => {
  it("reads the flags and applies the defaults", () => {
    const r = parseExportK6Args(["--scenario", "s.json"]);
    expect(r).toEqual({
      ok: true,
      args: {
        scenarioFile: "s.json",
        outDir: "k6-loadtest",
        ocppVersion: "1.6",
        chargersPerVu: 50,
        force: false,
      },
    });
  });

  it("keeps the old flags", () => {
    const r = parseExportK6Args([
      "--scenario",
      "s.json",
      "--behavior",
      "a.ts",
      "--behavior",
      "b.ts",
      "-o",
      "out",
      "--force",
      "--ocpp-version",
      "1.6",
      "--chargers-per-vu",
      "80",
    ]);
    expect(r).toMatchObject({
      ok: true,
      args: {
        scenarioFile: "s.json",
        behaviorFiles: ["a.ts", "b.ts"],
        outDir: "out",
        force: true,
        chargersPerVu: 80,
      },
    });
  });

  it("accepts behaviors alone", () => {
    const r = parseExportK6Args(["--behavior", "a.ts"]);
    expect(r).toMatchObject({
      ok: true,
      args: { scenarioFile: "", behaviorFiles: ["a.ts"] },
    });
  });

  it("needs a scenario or a behavior", () => {
    const r = parseExportK6Args(["-o", "out"]);
    expect(r.ok).toBe(false);
  });

  it("refuses other OCPP versions, as it always did", () => {
    const r = parseExportK6Args([
      "--scenario",
      "s.json",
      "--ocpp-version",
      "2.0.1",
    ]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(/only 1\.6/);
  });

  it("refuses a bad --chargers-per-vu, a missing value and an unknown option", () => {
    expect(
      parseExportK6Args(["--scenario", "s", "--chargers-per-vu", "0"]).ok,
    ).toBe(false);
    expect(parseExportK6Args(["--scenario"]).ok).toBe(false);
    expect(parseExportK6Args(["--scenario", "s", "--nope"]).ok).toBe(false);
  });
});
