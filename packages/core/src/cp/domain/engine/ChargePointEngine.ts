import type {
  Behavior,
  ChargerSnapshot,
  ConnectorSnapshot,
  JsonObject,
} from "@ocpp-cp-simulator/contracts/behavior";
import type { Connector } from "../connector/Connector";
import type { TransactionLifecycleEvent } from "../transport/TransactionLifecycleEvent";
import type { RuleOwner } from "./behaviorRules";
import type {
  ChargerState,
  EngineEvent,
  NotifyKind,
  PersistedEngineState,
} from "./ChargerState";

export interface LoadBehaviorOptions {
  /**
   * Load without serving: no rule is registered, `main` does not start and
   * no `on` hook or `beforeSend` runs until a scenario selects the behavior
   * with `useBehavior`. All of it, or none of it: while a run holds the
   * behavior it is complete; when the last holder lets go it is idle again.
   */
  readonly dormant?: boolean;
  /**
   * The params the selector set (`--use-behavior` with `--behavior-params`,
   * `cp.behaviors.set`), merged over the behavior's defaults. Validated before
   * anything is registered, so a refusal loads nothing.
   */
  readonly params?: JsonObject;
}

/** What a default behavior produced for one CALL, in the shape handlers use. */
export interface DefaultResult {
  readonly response: unknown;
  /** Starts the work that follows the response; run it once the response settled. */
  readonly effect?: (() => void) & {
    /** The exchange told the queue to drop the effect: it will never run. */
    onDropped?: () => void;
  };
}

/**
 * What the transaction defaults need from the station beyond its public API.
 * `ChargePoint` builds one and hands it to the engine.
 */
export interface TransactionPorts {
  /** Hand a transaction phase to the protocol encoder. */
  sendTransactionEvent(event: TransactionLifecycleEvent): void;
  /** (Re)start the ConnectionTimeOut of a connector that is in Preparing. */
  startConnectionTimeout(connectorId: number): void;
}

/**
 * What the transport and the charge point report to the engine: the
 * connection came up or went down, the CSMS sent a CALL, the CSMS answered
 * one of ours.
 */
export type EngineObservation =
  | { type: "connected" }
  | { type: "disconnected"; code?: number; reason?: string }
  | {
      type: "callResult";
      action: string;
      messageId: string;
      outcome: "result" | "error";
      payload: unknown;
    }
  | {
      type: "callReceived";
      action: string;
      messageId: string;
      payload: unknown;
    };

/** What `beforeSend` decided for a station-initiated CALL. */
export type BeforeSendResult =
  { readonly drop: true } | { readonly payload: unknown };

/**
 * The charger engine as the station and the code around it use it
 * (docs/concepts/charger-engine.md). `ChargerEngine` (application)
 * implements it; `ChargePoint.engine` returns it.
 */
export interface ChargePointEngine {
  /** The current state. Do not mutate it. */
  readonly state: ChargerState;
  /** Ids of the loaded code behaviors. */
  readonly behaviorIds: readonly string[];
  /** The params the station's selection gave each behavior, a copy. */
  readonly selectedParams: Record<string, JsonObject>;

  /** Everything that changes the engine goes through here. */
  dispatch(event: EngineEvent): void;
  /** Put `connector`'s record into the engine state. */
  attachConnector(connector: Connector): void;
  /** The connector leaves: it keeps its last record in a cell of its own. */
  detachConnector(connectorId: number): void;
  /** The connection ended: the work that followed its answers stops. */
  connectionClosed(): void;
  /** The station is going away: every behavior stops. */
  dispose(): void;

  /** Report a connection or CALL event to the loaded behaviors' hooks. */
  observe(event: EngineObservation): void;
  /** Run every loaded behavior's `beforeSend` over a station CALL. */
  beforeSend(action: string, payload: unknown): BeforeSendResult;
  /** Run the default behavior of `action` for a CALL on the default path. */
  runDefault(action: string, payload: unknown): DefaultResult;

  /** The loaded behavior with this id, if any. */
  behaviorOf(id: string): Behavior | undefined;
  /** Throws if this station cannot run `behavior`. */
  assertLoadable(behavior: Behavior): void;
  /** Load a behavior; throws and registers nothing when it cannot. */
  loadBehavior(behavior: Behavior, options?: LoadBehaviorOptions): void;
  /** Swap a loaded behavior for a new version of it. */
  replaceBehavior(next: Behavior): void;
  /** Unload a behavior; false when no behavior has that id. */
  unloadBehavior(id: string): boolean;
  /** Put a dormant behavior's rules to work under `owner`. */
  activateBehavior(id: string, owner: RuleOwner, params?: JsonObject): void;
  /** Answer every CALL of the behavior's actions with `accepted`. */
  disableBehavior(id: string, owner: RuleOwner): void;
  /** The dormant behaviors the owners `owned` accepts let go of. */
  deactivateBehaviors(owned: (owner: RuleOwner) => boolean): void;

  /** The params `ctx.params` hands out for `id` now. */
  effectiveParams(id: string): JsonObject;
  /** Set (or clear) the params the station's selection gives `id`. */
  setSelectionParams(id: string, params: JsonObject | undefined): void;
  /** Change a loaded behavior's selection params in place. */
  reselectBehaviorParams(id: string, params: JsonObject | undefined): void;

  /** Called when the persistable state may have changed. */
  onPersist(listener: (() => void) | null): void;
  /** The part of the state that survives a restart, a deep copy. */
  persistable(): PersistedEngineState;
  /** Put stored state back. */
  restoreState(saved: PersistedEngineState): void;
  /** Run `onResume` once the CSMS accepted the next BootNotification. */
  resumeAfterBoot(): void;
  /** The station's boot was accepted. */
  bootAccepted(): void;

  /** A read-only view of one connector. */
  snapshotConnector(id: number): ConnectorSnapshot | undefined;
  /** A read-only view of the station. */
  snapshotCharger(): ChargerSnapshot;
  /** Send a station status notification. */
  notifyStatus(kind: NotifyKind, status: string, requestId?: number): void;
}
