import type { JsonValue } from "@ocpp-cp-sim/contracts/behavior";
import {
  reduceConnectorRecord,
  type ConnectorRecord,
  type ConnectorWrite,
} from "../../domain/connector/ConnectorRecord";

/**
 * The charger engine's state (docs/analyses/charger-engine.md, "Charger
 * engine"): a plain, JSON-serializable record. Only
 * {@link reduceChargerState} writes the fields the engine owns; the user data
 * of a behavior (`ctx.state`) lives under `behaviors` and is the one thing a
 * behavior mutates in place.
 *
 * It holds what the default behaviors that moved report (firmware, log and
 * diagnostics status) and, per connector, status, availability and error
 * info. Transactions and reservations join it when their behaviors move.
 */
export interface ChargerState {
  readonly schema: 1;
  readonly firmware: StatusRecord;
  readonly signedFirmware: StatusRecord;
  readonly log: StatusRecord;
  readonly diagnostics: { readonly status: string };
  /** Connector records by connector id (a JSON object key, so a string). */
  readonly connectors: Readonly<Record<string, ConnectorRecord>>;
  /** `ctx.state` of every loaded behavior, by behavior id. */
  readonly behaviors: Record<string, Record<string, JsonValue>>;
}

export interface StatusRecord {
  readonly status: string;
  readonly requestId: number | null;
}

/**
 * What survives a restart: the notification statuses and the `ctx.state` of the
 * behaviors. Connectors persist through their own rows (`connector_runtime`).
 */
export interface PersistedEngineState {
  readonly schema: 1;
  readonly firmware: StatusRecord;
  readonly signedFirmware: StatusRecord;
  readonly log: StatusRecord;
  readonly diagnostics: { readonly status: string };
  readonly behaviors: Readonly<Record<string, Record<string, JsonValue>>>;
}

export type NotifyKind = "firmware" | "signedFirmware" | "log" | "diagnostics";

/** Everything that changes the engine goes through one of these. */
export type EngineEvent =
  | {
      readonly type: "notified";
      readonly kind: NotifyKind;
      readonly status: string;
      readonly requestId?: number;
    }
  | {
      readonly type: "connector.added";
      readonly connectorId: number;
      readonly record: ConnectorRecord;
    }
  | { readonly type: "connector.removed"; readonly connectorId: number }
  | {
      readonly type: "connector.write";
      readonly connectorId: number;
      readonly write: ConnectorWrite;
    }
  | {
      /** The notification statuses read back from storage; sends nothing. */
      readonly type: "state.restored";
      readonly firmware: StatusRecord;
      readonly signedFirmware: StatusRecord;
      readonly log: StatusRecord;
      readonly diagnostics: { readonly status: string };
    }
  | { readonly type: "behavior.loaded"; readonly behaviorId: string }
  | { readonly type: "behavior.unloaded"; readonly behaviorId: string }
  | { readonly type: "connection.closed" }
  | { readonly type: "disposed" };

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
      return state.behaviors[event.behaviorId]
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
