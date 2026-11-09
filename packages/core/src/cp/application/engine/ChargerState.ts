import type { JsonValue } from "@ocpp-cp-simulator/contracts/behavior";
import { reduceConnectorRecord } from "../../domain/connector/ConnectorRecord";
import type {
  ChargerState,
  EngineEvent,
  PersistedEngineState,
  StatusRecord,
} from "../../domain/engine/ChargerState";

// The engine vocabulary is defined in domain (#575); re-exported for the
// existing import sites.
export type {
  ChargerState,
  EngineEvent,
  NotifyKind,
  PersistedEngineState,
} from "../../domain/engine/ChargerState";

export function initialChargerState(): ChargerState {
  return {
    schema: 1,
    firmware: { status: "Idle", requestId: null },
    signedFirmware: { status: "Idle", requestId: null },
    log: { status: "Idle", requestId: null },
    diagnostics: { status: "Idle" },
    connectors: {},
    behaviors: {},
  };
}

/** The pure part of event handling: the next state for `event`. */
export function reduceChargerState(
  state: ChargerState,
  event: EngineEvent,
): ChargerState {
  switch (event.type) {
    case "notified": {
      const record = {
        status: event.status,
        requestId: event.requestId ?? null,
      };
      switch (event.kind) {
        case "firmware":
          return { ...state, firmware: record };
        case "signedFirmware":
          return { ...state, signedFirmware: record };
        case "log":
          return { ...state, log: record };
        case "diagnostics":
          return { ...state, diagnostics: { status: event.status } };
      }
      return state;
    }
    case "connector.added":
      return {
        ...state,
        connectors: { ...state.connectors, [event.connectorId]: event.record },
      };
    case "connector.removed": {
      const { [event.connectorId]: _gone, ...rest } = state.connectors;
      return { ...state, connectors: rest };
    }
    case "connector.write": {
      const record = state.connectors[event.connectorId];
      if (!record) return state;
      return {
        ...state,
        connectors: {
          ...state.connectors,
          [event.connectorId]: reduceConnectorRecord(record, event.write),
        },
      };
    }
    case "state.restored":
      return {
        ...state,
        firmware: event.firmware,
        signedFirmware: event.signedFirmware,
        log: event.log,
        diagnostics: event.diagnostics,
      };
    case "behavior.loaded":
      return Object.hasOwn(state.behaviors, event.behaviorId)
        ? state
        : {
            ...state,
            behaviors: { ...state.behaviors, [event.behaviorId]: {} },
          };
    case "behavior.unloaded": {
      const { [event.behaviorId]: _gone, ...rest } = state.behaviors;
      return { ...state, behaviors: rest };
    }
    default:
      return state;
  }
}

/** Throws unless `value` survives a JSON round trip unchanged in shape. */
export function assertJsonSerializable(value: unknown, path = "state"): void {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`${path} is not a finite number`);
      }
      return;
    case "object": {
      if (Array.isArray(value)) {
        value.forEach((item, i) =>
          assertJsonSerializable(item, `${path}[${i}]`),
        );
        return;
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`${path} is not a plain object`);
      }
      for (const [key, item] of Object.entries(value as object)) {
        // A key set to `undefined` is an absent key (JSON drops it): the usual
        // way to clear one.
        if (item === undefined) continue;
        assertJsonSerializable(item, `${path}.${key}`);
      }
      return;
    }
    default:
      throw new TypeError(`${path} is not JSON-serializable (${typeof value})`);
  }
}

const isStatusRecord = (value: unknown): value is StatusRecord => {
  const v = value as StatusRecord | null;
  return (
    !!v &&
    typeof v === "object" &&
    typeof v.status === "string" &&
    (v.requestId === null || typeof v.requestId === "number")
  );
};

/**
 * Read stored engine state back. Anything it does not recognize is dropped
 * rather than trusted: a row written by another build must never stop a
 * charge point from starting. Returns null for a value that is not a state.
 */
export function parsePersistedEngineState(
  value: unknown,
): PersistedEngineState | null {
  const v = value as Partial<PersistedEngineState> | null;
  if (!v || typeof v !== "object" || v.schema !== 1) return null;
  const initial = initialChargerState();
  const behaviors: Record<string, Record<string, JsonValue>> = {};
  if (v.behaviors && typeof v.behaviors === "object") {
    for (const [id, data] of Object.entries(v.behaviors)) {
      // An id that names a member of every object is no behavior's: it could
      // only have been written by hand, and it must not reach a lookup.
      if (id in Object.prototype) continue;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        try {
          assertJsonSerializable(data);
          behaviors[id] = data;
        } catch {
          // A state that is not JSON is skipped.
        }
      }
    }
  }
  return {
    schema: 1,
    firmware: isStatusRecord(v.firmware) ? v.firmware : initial.firmware,
    signedFirmware: isStatusRecord(v.signedFirmware)
      ? v.signedFirmware
      : initial.signedFirmware,
    log: isStatusRecord(v.log) ? v.log : initial.log,
    diagnostics:
      v.diagnostics && typeof v.diagnostics.status === "string"
        ? { status: v.diagnostics.status }
        : initial.diagnostics,
    behaviors,
  };
}
