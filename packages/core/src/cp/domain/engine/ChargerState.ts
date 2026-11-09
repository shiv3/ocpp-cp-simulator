import type { JsonValue } from "@ocpp-cp-simulator/contracts/behavior";
import type {
  ConnectorRecord,
  ConnectorWrite,
} from "../connector/ConnectorRecord";

/**
 * The charger engine's state (docs/concepts/charger-engine.md, "Charger
 * engine"): a plain, JSON-serializable record. Only
 * `reduceChargerState` (application/engine/ChargerState.ts) writes the fields
 * the engine owns; the user data of a behavior (`ctx.state`) lives under
 * `behaviors` and is the one thing a behavior mutates in place.
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
