import type { ChargerState } from "../../../../application/engine/ChargerState";

/**
 * What a triggered status notification reports on OCPP 1.6, from the last
 * status the engine sent. `Idle` stands for "not busy": 1.6 §4.4 and §4.5 allow
 * it after a TriggerMessage only when no upload or update is in progress.
 */
export interface TriggerStatus {
  readonly status: string;
  readonly requestId?: number;
}

/** §4.5: downloading, downloaded and waiting to install, and installing. */
const FIRMWARE_BUSY = new Set(["Downloading", "Downloaded", "Installing"]);

/** §4.4: Uploading is the only busy diagnostics status. */
export function diagnosticsTriggerStatus(state: ChargerState): TriggerStatus {
  return {
    status: state.diagnostics.status === "Uploading" ? "Uploading" : "Idle",
  };
}

export function firmwareTriggerStatus(state: ChargerState): TriggerStatus {
  return {
    status: FIRMWARE_BUSY.has(state.firmware.status)
      ? state.firmware.status
      : "Idle",
  };
}

/**
 * Security whitepaper N01.FR.12: while an upload is ongoing the status carries
 * the GetLog `requestId`; otherwise `Idle` without one is allowed.
 */
export function logTriggerStatus(state: ChargerState): TriggerStatus {
  const { status, requestId } = state.log;
  return status === "Uploading" && requestId !== null
    ? { status, requestId }
    : { status: "Idle" };
}

/**
 * Security whitepaper L01.FR.28 / L01.FR.29: the last sent
 * SignedFirmwareStatusNotification status, `Idle` if that was `Installed`.
 */
export function signedFirmwareTriggerStatus(
  state: ChargerState,
): TriggerStatus {
  const { status, requestId } = state.signedFirmware;
  if (status === "Installed" || status === "Idle") return { status: "Idle" };
  return requestId === null ? { status } : { status, requestId };
}
