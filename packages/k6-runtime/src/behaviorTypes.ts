// packages/k6-runtime/src/behaviorTypes.ts
// A structural mirror of packages/contracts/src/behavior.ts (the behavior API).
// The k6 runtime may not import another package (it is copied verbatim into an
// export), so the types are repeated here.
// apps/cli/src/exportK6/__tests__/behaviorTypes.test.ts holds the two
// assignable to each other, so a change to the contract that is not repeated
// here fails the typecheck.

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

export interface Behavior {
  api: 1;
  id: string;
  requires?: readonly BehaviorCapability[];
  /** Keyed by action, in either OCPP version's spelling. */
  onCall?: Record<string, CallBehavior>;
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
  /** User data; must be JSON-serializable, held by the engine. */
  state: Record<string, JsonValue>;
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
