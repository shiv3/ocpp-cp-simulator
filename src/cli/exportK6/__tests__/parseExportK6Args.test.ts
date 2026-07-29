import { describe, expect, it } from "vitest";
import { parseExportK6Args } from "../parseExportK6Args";

describe("parseExportK6Args", () => {
  it("parses the minimal form with defaults", () => {
    expect(parseExportK6Args(["--scenario", "s.json"])).toEqual({
      ok: true,
      args: {
        scenarioFile: "s.json",
        outDir: "k6-loadtest",
        ocppVersion: "1.6",
        force: false,
      },
    });
  });

  it("accepts -o/--out, --ocpp-version, and --force", () => {
    expect(
      parseExportK6Args([
        "--scenario",
        "s.json",
        "-o",
        "out",
        "--ocpp-version",
        "1.6",
        "--force",
      ]),
    ).toEqual({
      ok: true,
      args: {
        scenarioFile: "s.json",
        outDir: "out",
        ocppVersion: "1.6",
        force: true,
      },
    });
  });

  it("requires --scenario", () => {
    const r = parseExportK6Args([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/--scenario/);
  });

  it("rejects unsupported versions with the Phase-2 hint", () => {
    const r = parseExportK6Args([
      "--scenario",
      "s.json",
      "--ocpp-version",
      "2.0.1",
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/1\.6/);
  });

  it("rejects flags missing values and unknown flags", () => {
    expect(parseExportK6Args(["--scenario"]).ok).toBe(false);
    expect(parseExportK6Args(["--scenario", "s.json", "--wat"]).ok).toBe(false);
    expect(parseExportK6Args(["--scenario", "s.json", "stray"]).ok).toBe(false);
  });
});
