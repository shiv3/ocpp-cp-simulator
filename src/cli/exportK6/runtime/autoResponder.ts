// src/cli/exportK6/runtime/autoResponder.ts
// Default replies for CSMS-initiated CALLs so N load-test CPs stay healthy
// from the CSMS's point of view. The scenario can pre-arm one-shot status
// overrides (responseOverride node) and the UnlockConnector outcome
// (unlockOutcome node).
import { str } from "./types";

export interface ResponderState {
  localConfig: Map<string, string>;
  armedOverrides: Map<string, string>;
  unlockOutcome: "Unlocked" | "UnlockFailed" | "NotSupported";
}

export function createResponderState(): ResponderState {
  return {
    localConfig: new Map(),
    armedOverrides: new Map(),
    unlockOutcome: "Unlocked",
  };
}

const ACCEPTED_ACTIONS = new Set([
  "RemoteStartTransaction",
  "RemoteStopTransaction",
  "ChangeAvailability",
  "ClearCache",
  "Reset",
  "ReserveNow",
  "CancelReservation",
  "SetChargingProfile",
  "ClearChargingProfile",
  "SendLocalList",
  "DataTransfer",
]);

export function respondToCall16(
  action: string,
  payload: Record<string, unknown>,
  state: ResponderState,
): Record<string, unknown> {
  const response = buildResponse(action, payload, state);
  const override = state.armedOverrides.get(action);
  if (override !== undefined) {
    state.armedOverrides.delete(action);
    return { ...response, status: override };
  }
  return response;
}

function buildResponse(
  action: string,
  payload: Record<string, unknown>,
  state: ResponderState,
): Record<string, unknown> {
  if (ACCEPTED_ACTIONS.has(action)) return { status: "Accepted" };
  switch (action) {
    case "UnlockConnector":
      return { status: state.unlockOutcome };
    case "ChangeConfiguration": {
      const key = str(payload.key);
      if (key !== undefined) {
        state.localConfig.set(key, str(payload.value) ?? "");
      }
      return { status: "Accepted" };
    }
    case "GetConfiguration": {
      const requested = Array.isArray(payload.key)
        ? payload.key.filter((k): k is string => typeof k === "string")
        : null;
      const keys = requested ?? [...state.localConfig.keys()];
      const configurationKey = keys
        .filter((k) => state.localConfig.has(k))
        .map((k) => ({
          key: k,
          readonly: false,
          value: state.localConfig.get(k) as string,
        }));
      const result: Record<string, unknown> = { configurationKey };
      if (requested) {
        const unknownKey = requested.filter((k) => !state.localConfig.has(k));
        if (unknownKey.length > 0) result.unknownKey = unknownKey;
      }
      return result;
    }
    case "TriggerMessage":
      return { status: "NotImplemented" };
    case "GetLocalListVersion":
      return { listVersion: 0 };
    default:
      return {};
  }
}
