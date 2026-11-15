import {
  type BaseNodeData,
  CERT_SIGNATURE_ALGORITHMS,
  type ConnectorPlugNodeData,
  CSMS_CALL_TRIGGER_ACTIONS,
  INBOUND_POLICY_ACTIONS,
  INBOUND_POLICY_ERROR_CODES,
  type MeterValueNodeData,
  RESPONSE_OVERRIDE_ACTIONS,
  RESPONSE_OVERRIDE_STATUSES,
  type ScenarioNodeData,
  type StartNodeData,
  type TransactionNodeData,
  type UnlockOutcomeNodeData,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { OCPPStatus } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import type { CurvePoint } from "@ocpp-cp-simulator/core/cp/domain/connector/MeterValueCurve";
import type { NodeFormData } from "../types";

const OCPP_STATUS_VALUES = new Set<string>(Object.values(OCPPStatus));

export function compactDefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as T;
}

export function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asOcppStatus(value: unknown, fallback: OCPPStatus): OCPPStatus {
  return typeof value === "string" && OCPP_STATUS_VALUES.has(value)
    ? (value as OCPPStatus)
    : fallback;
}

const CSMS_CALL_TRIGGER_ACTIONS_SET = new Set<string>(
  CSMS_CALL_TRIGGER_ACTIONS,
);

export function asCsmsCallTriggerAction(
  value: unknown,
): (typeof CSMS_CALL_TRIGGER_ACTIONS)[number] {
  return typeof value === "string" && CSMS_CALL_TRIGGER_ACTIONS_SET.has(value)
    ? (value as (typeof CSMS_CALL_TRIGGER_ACTIONS)[number])
    : "Reset";
}

/** #240: keep only a plain-object payload condition; anything else
 *  (unparsed textarea string, array) is dropped on save. */
export function asPayloadCondition(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const RESPONSE_OVERRIDE_ACTIONS_SET = new Set<string>(
  RESPONSE_OVERRIDE_ACTIONS,
);

export function asResponseOverrideAction(
  value: unknown,
): (typeof RESPONSE_OVERRIDE_ACTIONS)[number] {
  return typeof value === "string" && RESPONSE_OVERRIDE_ACTIONS_SET.has(value)
    ? (value as (typeof RESPONSE_OVERRIDE_ACTIONS)[number])
    : "RemoteStartTransaction";
}

export function asResponseOverrideStatus(
  value: unknown,
  action: (typeof RESPONSE_OVERRIDE_ACTIONS)[number],
): string {
  const validStatuses = RESPONSE_OVERRIDE_STATUSES[action];
  return typeof value === "string" && validStatuses.includes(value)
    ? value
    : validStatuses[0];
}

const INBOUND_POLICY_ACTIONS_SET = new Set<string>(INBOUND_POLICY_ACTIONS);
export const CERT_SIGNATURE_ALGORITHMS_SET = new Set<string>(
  CERT_SIGNATURE_ALGORITHMS,
);
const INBOUND_POLICY_ERROR_CODES_SET = new Set<string>(
  INBOUND_POLICY_ERROR_CODES,
);

export function asInboundPolicyAction(
  value: unknown,
): (typeof INBOUND_POLICY_ACTIONS)[number] {
  return typeof value === "string" && INBOUND_POLICY_ACTIONS_SET.has(value)
    ? (value as (typeof INBOUND_POLICY_ACTIONS)[number])
    : "Reset";
}

export function asInboundPolicyMode(
  value: unknown,
): "answer" | "callerror" | "ignore" {
  return value === "answer" || value === "ignore" ? value : "callerror";
}

/** Imported/programmatic node data can carry any string here, and the
 *  transport casts the code straight into a CALLERROR frame — so an
 *  unknown value must not survive conversion. Absent stays absent (the
 *  runtime applies its own NotImplemented default); present-but-invalid
 *  normalizes to NotImplemented, mirroring asInboundPolicyAction. */
export function asInboundPolicyErrorCode(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && INBOUND_POLICY_ERROR_CODES_SET.has(value)
    ? value
    : "NotImplemented";
}

export function baseToForm(nodeData: ScenarioNodeData): NodeFormData {
  return compactDefined({
    label: stringValue(nodeData.label),
    description: optionalString(nodeData.description),
  });
}

export function baseFromForm(formData: NodeFormData): BaseNodeData {
  return compactDefined({
    label: stringValue(formData.label),
    description: optionalString(formData.description),
  });
}

export function transactionAction(
  value: unknown,
): TransactionNodeData["action"] {
  return value === "stop" ? "stop" : "start";
}

export function connectorAction(
  value: unknown,
): ConnectorPlugNodeData["action"] {
  return value === "plugout" ? "plugout" : "plugin";
}

export function stopMode(
  value: unknown,
): MeterValueNodeData["stopMode"] | undefined {
  return value === "manual" || value === "evSettings" ? value : undefined;
}

export function triggerOn(
  value: unknown,
): StartNodeData["triggerOn"] | undefined {
  return value === "connect" || value === "status" ? value : undefined;
}

export function unlockOutcome(
  value: unknown,
): UnlockOutcomeNodeData["outcome"] {
  return value === "UnlockFailed" || value === "NotSupported"
    ? value
    : "Unlocked";
}

export function curvePoints(value: unknown): CurvePoint[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const points = value
    .map((point) => {
      if (
        typeof point !== "object" ||
        point === null ||
        !("time" in point) ||
        !("value" in point)
      ) {
        return undefined;
      }

      const time = (point as { time: unknown }).time;
      const pointValue = (point as { value: unknown }).value;

      return typeof time === "number" &&
        Number.isFinite(time) &&
        typeof pointValue === "number" &&
        Number.isFinite(pointValue)
        ? { time, value: pointValue }
        : undefined;
    })
    .filter((point): point is CurvePoint => point !== undefined);

  return points.length > 0 ? points : undefined;
}

export function payloadValue(value: unknown): Record<string, unknown> | string {
  return typeof value === "string" ||
    (typeof value === "object" && value !== null && !Array.isArray(value))
    ? (value as Record<string, unknown> | string)
    : {};
}
