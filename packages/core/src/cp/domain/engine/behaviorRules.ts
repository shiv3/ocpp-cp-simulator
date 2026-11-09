import type {
  CallAnswer,
  CallBehavior,
} from "@ocpp-cp-simulator/contracts/behavior";

/**
 * The vocabulary of the rules that may take an inbound CSMS CALL over from the
 * default path (docs/concepts/charger-engine.md, "BehaviorRegistry"). The
 * registry itself lives in application/behavior/BehaviorRegistry.ts.
 */

/** An inbound CSMS CALL as the registry sees it. */
export interface BehaviorCall {
  /** The action as it arrived on the wire. */
  readonly action: string;
  readonly payload: unknown;
  /** The connector the CALL names, when it names one. */
  readonly connectorId?: number;
}

/** Who registered a rule, and so who releases it. */
export type RuleOwner =
  | { readonly kind: "code"; readonly behaviorId: string }
  | {
      readonly kind: "scenario";
      readonly scenarioId: string;
      readonly connectorId: number;
      readonly nodeId: string;
    };

/**
 * What the registry needs from the exchange of a CALL. `CallExchange`
 * satisfies it; the registry does not import the transport.
 */
export interface HeldAnswerOptions {
  /** Work that follows the answer once it settled on the wire. */
  readonly effect?: () => void;
  /** Told once if `effect` will not run. */
  readonly onEffectDropped?: (reason: string) => void;
}

/** How an observed answer ended; always resolves. */
export type HeldSettlement =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly reason: string };

export interface HeldExchange {
  readonly state: "open" | "answered" | "suppressed" | "abandoned";
  readonly action: string;
  readonly messageId: string;
  onClosed(listener: () => void): void;
  reply(payload: unknown, options?: HeldAnswerOptions): void;
  replyError(
    errorCode: string,
    errorDescription: string,
    options?: HeldAnswerOptions,
  ): void;
  /** Like `reply`, and says whether the frame was written. */
  respond(
    payload: unknown,
    options?: HeldAnswerOptions,
  ): Promise<HeldSettlement>;
  respondError(
    errorCode: string,
    errorDescription: string,
    options?: HeldAnswerOptions,
  ): Promise<HeldSettlement>;
  suppress(): unknown;
}

export interface BehaviorRule {
  readonly owner: RuleOwner;
  /** The action in either OCPP version's spelling. */
  readonly action: string;
  /**
   * The connector the rule belongs to. A ranking hint, not a filter: among
   * the rules that match a CALL, those for exactly the connector it names win
   * (use `match` to filter on a payload field).
   */
  readonly connectorId?: number;
  /** A deep partial match against the request payload. */
  readonly match?: Record<string, unknown>;
  readonly mode: CallBehavior["mode"];
  /** What a second matching CALL gets while the rule holds an open exchange. */
  readonly onBusy?: CallAnswer;
  /**
   * The registry chose this rule for `call` and `exchange` is now held by it.
   * Runs synchronously inside the gate: start the work, do not await it here.
   */
  take(call: BehaviorCall, exchange: HeldExchange): void;
}

/** What to do with a CALL. */
export type BehaviorResolution =
  /** No rule applies: run the default path. */
  | { readonly kind: "default" }
  /** A rule took the CALL; it answers through the exchange. */
  | { readonly kind: "taken"; readonly rule: BehaviorRule }
  /** The rule that applies already holds an open exchange: `onBusy` was sent. */
  | { readonly kind: "busy"; readonly rule: BehaviorRule };

/** What a behavior registry reads from its charge point. */
export interface BehaviorRegistryOptions {
  /** The station's OCPP version; action names translate on 2.x only. */
  readonly ocppVersion?: () => string;
  warn?(message: string): void;
}

/**
 * The charge point's behavior registry as the station, the engine and the
 * inbound gate use it. `BehaviorRegistry` (application) implements it.
 */
export interface ChargePointBehaviorRegistry {
  /** Add `rule`; returns the function that removes it. */
  register(rule: BehaviorRule, options?: { rank?: number }): () => void;
  /** The rank of each rule whose owner `owned` accepts, by rule key. */
  ranks(owned: (owner: RuleOwner) => boolean): Map<string, number>;
  /** Remove the rules `owned` accepts; returns the exchanges they held. */
  release(owned: (owner: RuleOwner) => boolean): HeldExchange[];
  /** Pick what answers `call`. */
  resolve(call: BehaviorCall, exchange?: HeldExchange): BehaviorResolution;
}
