/**
 * The behavior API (docs/analyses/charger-engine.md, "Behavior API"): types
 * only. A behavior is a plain TypeScript module that imports these types and
 * nothing else; it must not use module-scope mutable state, `Date`,
 * `Math.random` or timers, because every wait and every draw goes through
 * {@link BehaviorContext}.
 *
 * The API has to work on k6 as well: nothing here needs `AbortController`,
 * `URL`, `structuredClone`, `queueMicrotask`, `performance`, async generators
 * or `for await`.
 */

/** What a behavior needs from the station that runs it. */
export type BehaviorCapability =
  "ocpp1.6" | "ocpp2.x" | "physical" | "virtual-time" | "raw-frames";

/** JSON-serializable data, the only kind of user state the engine holds. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * How a behavior answers an inbound CSMS CALL. `after` runs once, when the
 * answer has settled on the wire; it is skipped, with a warning, if the
 * answer was not delivered.
 */
export type CallOutcome =
  | {
      response: unknown;
      /** Send `response` without checking it against the action's schema. */
      skipValidation?: boolean;
      after?: () => Promise<void>;
    }
  | {
      error: { code: string; description: string };
      after?: () => Promise<void>;
    }
  | { noResponse: true; after?: () => Promise<void> };

/** An answer that is chosen without running code: `onBusy`. */
export type CallAnswer =
  | { response: unknown; skipValidation?: boolean }
  | { error: { code: string; description: string } }
  | { noResponse: true };

export interface CallBehavior {
  /**
   * `replace`: the handler is the whole answer, the default behavior does not
   * run. `extend`: the handler may call `ctx.defaultBehavior(req)` and wrap it.
   */
  mode: "replace" | "extend";
  /** A deep partial match against the request payload. */
  match?: Record<string, unknown>;
  /**
   * What a second matching CALL gets while the rule still holds an open
   * exchange. Default: CALLERROR `GenericError`.
   */
  onBusy?: CallAnswer;
  handle(
    req: unknown,
    ctx: BehaviorContext,
  ): CallOutcome | Promise<CallOutcome>;
}

/** A connector's status changed (`from` differs from `to`). */
export interface ConnectorStatusEvent {
  readonly connectorId: number;
  readonly from: string;
  readonly to: string;
}

/**
 * A transaction began or ended on a connector. `transactionId` is the id the
 * connector holds at that moment: `0` on 1.6 while the CSMS has not yet
 * answered StartTransaction.
 */
export interface TransactionEvent {
  readonly connectorId: number;
  readonly transactionId: number | string | null;
  readonly idTag: string | null;
  /** Stop only: the stop reason, when one was recorded. */
  readonly reason?: string;
}

/** The connection to the CSMS came up (`at`: epoch ms on the station's clock). */
export interface ConnectedEvent {
  readonly at: number;
}

/** The connection ended. */
export interface DisconnectedEvent {
  readonly at: number;
  readonly code?: number;
  readonly reason?: string;
}

/**
 * The CSMS answered a station-initiated CALL, an automatic one (Heartbeat,
 * StatusNotification, …) as much as one a behavior or a scenario sent.
 * `payload` is the result, or `{ errorCode, errorDescription }` for an error.
 */
export interface CallResultEvent {
  readonly action: string;
  readonly messageId: string;
  readonly outcome: "result" | "error";
  readonly payload: unknown;
}

/** The CSMS sent a CALL. Observation only: it cannot change the answer. */
export interface CallReceivedEvent {
  readonly action: string;
  readonly messageId: string;
  readonly payload: unknown;
}

/**
 * Event hooks. The engine calls them after the state change is applied and
 * after the turn that caused it, never inside it; it does not await them. A
 * hook that throws is logged and changes nothing. Several behaviors each get
 * the event, in load order.
 */
export interface BehaviorEvents {
  connectorStatus?(
    event: ConnectorStatusEvent,
    ctx: BehaviorContext,
  ): void | Promise<void>;
  transactionStarted?(
    event: TransactionEvent,
    ctx: BehaviorContext,
  ): void | Promise<void>;
  transactionStopped?(
    event: TransactionEvent,
    ctx: BehaviorContext,
  ): void | Promise<void>;
  connected?(event: ConnectedEvent, ctx: BehaviorContext): void | Promise<void>;
  disconnected?(
    event: DisconnectedEvent,
    ctx: BehaviorContext,
  ): void | Promise<void>;
  callResult?(
    event: CallResultEvent,
    ctx: BehaviorContext,
  ): void | Promise<void>;
  callReceived?(
    event: CallReceivedEvent,
    ctx: BehaviorContext,
  ): void | Promise<void>;
}

/** Returned from a {@link BeforeSend} to put nothing on the wire. */
export interface DropCall {
  readonly drop: true;
}

/**
 * Called, synchronously, for a station-initiated CALL of the action it is
 * registered under, before the CALL is queued. `payload` is a copy. Return
 * the payload to send (changed or not), `{ drop: true }`, or nothing to
 * leave the CALL as it is. A returned promise is refused with a warning and
 * the CALL goes out unchanged, because the order of the chain must not move.
 */
export type BeforeSend = (
  payload: Record<string, unknown>,
  ctx: BehaviorContext,
) => Record<string, unknown> | DropCall | undefined | void;

export interface Behavior {
  api: 1;
  id: string;
  requires?: readonly BehaviorCapability[];
  /** Keyed by action, in either OCPP version's spelling. */
  onCall?: Record<string, CallBehavior>;
  on?: BehaviorEvents;
  /**
   * Interception of station-initiated CALLs on the OCPP-J paths, keyed by
   * action in either version's spelling. Refused at load on a SOAP station.
   */
  beforeSend?: Record<string, BeforeSend>;
  main?(ctx: BehaviorContext): Promise<void>;
  /** After the station state was restored; async positions are not. */
  onResume?(ctx: BehaviorContext): Promise<void>;
}

/** A read-only view of one connector. */
export interface ConnectorSnapshot {
  readonly id: number;
  readonly status: string;
  readonly availability: "Operative" | "Inoperative";
  readonly transactionId: number | string | null;
  readonly idTag: string | null;
}

/** A read-only view of the station. */
export interface ChargerSnapshot {
  readonly id: string;
  readonly ocppVersion: string;
  readonly status: string;
  readonly connectorIds: readonly number[];
}

export type RandomStream = {
  next(): number;
  int(minInclusive: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  uuid(): string;
};

export interface SendOptions {
  /** Do not wait for the CSMS answer. */
  readonly fireAndForget?: boolean;
}

/** Version-neutral station notifications. */
export interface BehaviorNotify {
  firmwareStatus(status: string, opts?: { requestId?: number }): void;
  /** 1.6 Security Whitepaper SignedFirmwareStatusNotification. */
  signedFirmwareStatus(status: string, requestId: number): void;
  logStatus(status: string, opts?: { requestId?: number }): void;
  /** 1.6 DiagnosticsStatusNotification. */
  diagnosticsStatus(status: string): void;
}

export interface BehaviorContext {
  /** Epoch ms on the station's clock. */
  now(): number;
  sleep(ms: number): Promise<void>;
  /**
   * Resolves with the promise's value, or rejects with a timeout error after
   * `ms` on the station's clock.
   */
  until<T>(promise: Promise<T>, opts: { ms: number }): Promise<T>;
  /** A named, seeded stream: the same seed gives the same numbers. */
  random(stream: string): RandomStream;
  /** True once the behavior was unloaded or the station is disposed. */
  readonly stopping: boolean;
  /**
   * User data; must be JSON-serializable, held by the engine. The object is
   * the engine's: change its keys (`ctx.state.count = 1`), never assign
   * `ctx.state` itself (core refuses it).
   */
  readonly state: Record<string, JsonValue>;
  /** A station-initiated CALL through the normal path; resolves to its result. */
  send(action: string, payload: unknown, opts?: SendOptions): Promise<unknown>;
  /** Explicit opt-in for non-compliant traffic, via the raw frame sender. */
  raw(frame: string): void;
  plugIn(connectorId: number): void;
  unplug(connectorId: number): void;
  authorize(idTag: string): void;
  startCharging(connectorId: number, idTag?: string): void;
  stopCharging(connectorId: number, reason?: string): void;
  setConnectorStatus(connectorId: number, status: string): void;
  readonly notify: BehaviorNotify;
  /**
   * Only in an `extend` handler: run the default behavior for `req`, register
   * its effect, and return the default response.
   */
  defaultBehavior(req: unknown): unknown;
  /**
   * The valid "accepted" response of `action` for this station's OCPP version:
   * `{}` for 1.6 `UpdateFirmware`, `{ status: "Accepted" }` on 2.x. `action`
   * may be spelled as either version spells it. Throws when the action has no
   * such response.
   */
  accepted(action: string): Record<string, unknown>;
  /** Likewise `{ status: "Rejected" }` where the action has that status. */
  rejected(action: string): Record<string, unknown>;
  connector(id: number): ConnectorSnapshot | undefined;
  readonly charger: ChargerSnapshot;
  log(message: string): void;
}
