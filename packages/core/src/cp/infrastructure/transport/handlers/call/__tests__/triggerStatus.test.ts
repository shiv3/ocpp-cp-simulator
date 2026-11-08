import { describe, expect, it } from "vitest";
import type { ChargerState } from "../../../../../application/engine/ChargerState";
import {
  diagnosticsTriggerStatus,
  firmwareTriggerStatus,
  logTriggerStatus,
  signedFirmwareTriggerStatus,
} from "../triggerStatus";

const state = (over: Partial<ChargerState>): ChargerState =>
  ({
    schema: 1,
    firmware: { status: "Idle", requestId: null },
    signedFirmware: { status: "Idle", requestId: null },
    log: { status: "Idle", requestId: null },
    diagnostics: { status: "Idle" },
    connectors: {},
    behaviors: {},
    ...over,
  }) as ChargerState;

describe("triggered status on OCPP 1.6 (§4.4, §4.5)", () => {
  it("reports Uploading while diagnostics are uploading, else Idle", () => {
    expect(
      diagnosticsTriggerStatus(state({ diagnostics: { status: "Uploading" } })),
    ).toEqual({ status: "Uploading" });
    for (const status of ["Idle", "Uploaded", "UploadFailed"]) {
      expect(
        diagnosticsTriggerStatus(state({ diagnostics: { status } })).status,
      ).toBe("Idle");
    }
  });

  it("reports the firmware status between Downloading and Installing", () => {
    for (const status of ["Downloading", "Downloaded", "Installing"]) {
      expect(
        firmwareTriggerStatus(state({ firmware: { status, requestId: null } }))
          .status,
      ).toBe(status);
    }
    for (const status of [
      "Idle",
      "Installed",
      "DownloadFailed",
      "InstallationFailed",
    ]) {
      expect(
        firmwareTriggerStatus(state({ firmware: { status, requestId: null } }))
          .status,
      ).toBe("Idle");
    }
  });

  it("carries the GetLog requestId while uploading (N01.FR.12)", () => {
    expect(
      logTriggerStatus(state({ log: { status: "Uploading", requestId: 7 } })),
    ).toEqual({ status: "Uploading", requestId: 7 });
    expect(
      logTriggerStatus(state({ log: { status: "Uploaded", requestId: 7 } })),
    ).toEqual({ status: "Idle" });
  });

  it("repeats the last signed firmware status unless Installed (L01.FR.28/29)", () => {
    expect(
      signedFirmwareTriggerStatus(
        state({
          signedFirmware: { status: "InstallationFailed", requestId: 4 },
        }),
      ),
    ).toEqual({ status: "InstallationFailed", requestId: 4 });
    expect(
      signedFirmwareTriggerStatus(
        state({ signedFirmware: { status: "Installed", requestId: 4 } }),
      ),
    ).toEqual({ status: "Idle" });
    expect(signedFirmwareTriggerStatus(state({}))).toEqual({ status: "Idle" });
  });
});
