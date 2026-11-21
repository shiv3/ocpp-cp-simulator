import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { CLIChargePointService } from "../service";
import { testCpInit } from "./testCpInit";

/**
 * A template declares the OCPP versions its wire shapes are written for
 * (`ocppVersions`, schema 1.12). Loading it on a charge point that speaks
 * another version still works, but says so on stderr.
 */
let svc: CLIChargePointService | null = null;

afterEach(() => {
  svc?.cleanup();
  svc = null;
});

function loadOn(ocppVersion: string, templateId: string): string {
  svc = new CLIChargePointService(
    testCpInit({ cpId: "cp-version-warning", ocppVersion }),
    null,
  );
  const written: string[] = [];
  const spy = spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  try {
    svc.loadScenarioTemplate(templateId, 1, undefined, { autoStart: false });
  } finally {
    spy.mockRestore();
  }
  return written.join("");
}

describe("loading a template on another OCPP version", () => {
  it("warns when a 1.6 template meets a 2.0.1 charge point", () => {
    const out = loadOn("OCPP-2.0.1", "cert16-tc010-remote-start");
    expect(out).toContain("is written for OCPP 1.6");
    expect(out).toContain("speaks 2.0.1");
  });

  it("warns when a 2.x variant meets a 1.6 charge point", () => {
    const out = loadOn("OCPP-1.6J", "cert201-remote-start");
    expect(out).toContain("is written for OCPP 2.0.1 / 2.1");
  });

  it("stays quiet when the version is one the template declares", () => {
    expect(loadOn("OCPP-2.1", "cert201-remote-start")).not.toContain(
      "is written for",
    );
    expect(loadOn("OCPP-1.6J", "cert16-tc010-remote-start")).not.toContain(
      "is written for",
    );
  });
});
