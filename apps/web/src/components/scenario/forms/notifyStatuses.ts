import {
  DIAGNOSTICS_STATUSES,
  FIRMWARE_STATUSES,
  UPLOAD_LOG_STATUSES,
} from "@ocpp-cp-simulator/contracts/firmwareLogStatus";
import { NOTIFY_KINDS } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

/** The statuses each kind of notification speaks. */
export const NOTIFY_STATUSES: Record<
  (typeof NOTIFY_KINDS)[number],
  readonly string[]
> = {
  firmwareStatus: FIRMWARE_STATUSES,
  signedFirmwareStatus: FIRMWARE_STATUSES,
  logStatus: UPLOAD_LOG_STATUSES,
  diagnosticsStatus: DIAGNOSTICS_STATUSES,
};

export function notifyKind(value: unknown): (typeof NOTIFY_KINDS)[number] {
  return NOTIFY_KINDS.find((kind) => kind === value) ?? "firmwareStatus";
}
