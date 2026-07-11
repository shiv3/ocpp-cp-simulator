import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChargePoint } from "../ChargePoint";
import type { BootNotification } from "../../types/OcppTypes";
import { DefaultBootNotification } from "../../types/OcppTypes";

/**
 * Cert 1.6 Firmware TC_044_2 (Download Failed) / TC_044_3 (Installation
 * Failed): `simulateFirmwareUpdate` normally walks the happy-path status
 * train (Downloading → Downloaded → Installing → Installed). Setting the
 * `SimulatedFirmwareUpdateFailure` custom config key — the same seam a
 * scenario's `configSet` node writes through before UpdateFirmware fires —
 * diverts it onto a failure status instead.
 */

const bootNotification: BootNotification = DefaultBootNotification;

function buildChargePoint(): ChargePoint {
  return new ChargePoint(
    "test-cp-firmware-failure",
    bootNotification,
    1,
    "ws://localhost:8080",
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    {},
  );
}

describe("ChargePoint.simulateFirmwareUpdate — pre-armed failure outcomes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("TC_044_2: SimulatedFirmwareUpdateFailure=DownloadFailed diverts after Downloading", async () => {
    const cp = buildChargePoint();
    const status = cp.configuration.applyChange(
      "SimulatedFirmwareUpdateFailure",
      "DownloadFailed",
    );
    expect(status).toBe("Accepted");

    const sent: string[] = [];
    vi.spyOn(cp, "sendFirmwareStatusNotification").mockImplementation((s) => {
      sent.push(s);
    });

    cp.simulateFirmwareUpdate(new Date(Date.now() - 1000));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["Downloading"]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual(["Downloading", "DownloadFailed"]);

    // Sequence stops here — no Installing/Installed after a download failure.
    await vi.advanceTimersByTimeAsync(10000);
    expect(sent).toEqual(["Downloading", "DownloadFailed"]);
  });

  it("TC_044_3: SimulatedFirmwareUpdateFailure=InstallationFailed diverts after Installing", async () => {
    const cp = buildChargePoint();
    const status = cp.configuration.applyChange(
      "SimulatedFirmwareUpdateFailure",
      "InstallationFailed",
    );
    expect(status).toBe("Accepted");

    const sent: string[] = [];
    vi.spyOn(cp, "sendFirmwareStatusNotification").mockImplementation((s) => {
      sent.push(s);
    });

    cp.simulateFirmwareUpdate(new Date(Date.now() - 1000));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(["Downloading"]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual(["Downloading", "Downloaded"]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual(["Downloading", "Downloaded", "Installing"]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual([
      "Downloading",
      "Downloaded",
      "Installing",
      "InstallationFailed",
    ]);
  });

  it("default (no config key set) still completes the happy path", async () => {
    const cp = buildChargePoint();
    const sent: string[] = [];
    vi.spyOn(cp, "sendFirmwareStatusNotification").mockImplementation((s) => {
      sent.push(s);
    });

    cp.simulateFirmwareUpdate(new Date(Date.now() - 1000));
    await vi.advanceTimersByTimeAsync(6000);
    expect(sent).toEqual([
      "Downloading",
      "Downloaded",
      "Installing",
      "Installed",
    ]);
  });

  it("one-shot: after DownloadFailed, second UpdateFirmware (without re-arm) completes happy path", async () => {
    const cp = buildChargePoint();
    const sent: string[] = [];
    vi.spyOn(cp, "sendFirmwareStatusNotification").mockImplementation((s) => {
      sent.push(s);
    });

    // First UpdateFirmware: arm the failure
    cp.configuration.applyChange(
      "SimulatedFirmwareUpdateFailure",
      "DownloadFailed",
    );
    cp.simulateFirmwareUpdate(new Date(Date.now() - 1000));
    await vi.advanceTimersByTimeAsync(4000);
    expect(sent).toEqual(["Downloading", "DownloadFailed"]);

    // Second UpdateFirmware: no re-arm — arm was auto-cleared by the first call
    // Should now complete the happy path
    sent.length = 0;
    cp.simulateFirmwareUpdate(new Date(Date.now() - 1000));
    await vi.advanceTimersByTimeAsync(8000);
    expect(sent).toEqual([
      "Downloading",
      "Downloaded",
      "Installing",
      "Installed",
    ]);
  });
});
