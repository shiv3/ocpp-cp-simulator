import {
  DIAGNOSTICS_STATUSES,
  FIRMWARE_STATUSES,
  UPLOAD_LOG_STATUSES,
} from "@ocpp-cp-simulator/contracts/firmwareLogStatus";
import { NOTIFY_KINDS } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type { MessageKey } from "../../../i18n";

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

/** A request id is an integer or a whole `$from` reference. */
export function validateRequestId(value: unknown): MessageKey | null {
  if (typeof value === "number" && Number.isInteger(value)) return null;
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { $from?: unknown }).$from === "string"
  ) {
    return null;
  }
  return "scenarioEditor.notify.requestIdInvalid";
}
