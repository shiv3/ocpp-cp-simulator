import type { CallAnswer, CallBehavior } from "@ocpp-cp-sim/contracts/behavior";
import { csmsActionMatches } from "../../domain/types/csmsActionNames";
import { deepPartialMatch } from "../../../scenario/deepPartialMatch";

/**
 * The rules that may take an inbound CSMS CALL over from the default path
 * (docs/analyses/charger-engine.md, "BehaviorRegistry"). One per charge point.
 *
 * Two providers register here: code behaviors (`{ kind: "code" }`, alive as
 * long as the behavior is loaded) and scenario rules (`{ kind: "scenario" }`,
 * alive until their run ends). The registry does the selection, the "one open
 * exchange per rule" bookkeeping and the release by owner; the provider that
 * registered a rule decides what to do with a CALL the rule takes
 * ({@link BehaviorRule.take}).
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
export interface HeldExchange {
  readonly state: "open" | "answered" | "suppressed" | "abandoned";
  readonly action: string;
  readonly messageId: string;
  onClosed(listener: () => void): void;
  reply(payload: unknown): void;
  replyError(errorCode: string, errorDescription: string): void;
  suppress(): unknown;
}

export interface BehaviorRule {
  readonly owner: RuleOwner;
  /** The action in either OCPP version's spelling. */
  readonly action: string;
  /** The rule serves CALLs for this connector only; absent: any CALL. */
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

export interface BehaviorRegistryOptions {
  /** The station's OCPP version; action names translate on 2.x only. */
  readonly ocppVersion?: () => string;
  warn?(message: string): void;
}

const DEFAULT_RESOLUTION: BehaviorResolution = { kind: "default" };

/** The CALLERROR a CALL gets when `onBusy` names none. */
export const DEFAULT_BUSY_ANSWER: CallAnswer = {
  error: {
    code: "GenericError",
    description: "Another call of this kind is still being answered",
  },
};

interface Entry {
  readonly rule: BehaviorRule;
  readonly seq: number;
  readonly key: string;
  held: HeldExchange | null;
}

export function ruleOwnerKey(owner: RuleOwner): string {
  return owner.kind === "code"
    ? `code:${owner.behaviorId}`
    : `scenario:${owner.scenarioId}:${owner.connectorId}:${owner.nodeId}`;
}

export class BehaviorRegistry {
  private readonly entries: Entry[] = [];
  private seq = 0;

  constructor(private readonly options: BehaviorRegistryOptions = {}) {}

  /** Number of rules currently registered. */
  get size(): number {
    return this.entries.length;
  }

  /**
   * Register a rule. A rule is identified by its owner and action: the same
   * pair twice throws (a provider releases before it registers again).
   * Returns a function that removes the rule.
   */
  register(rule: BehaviorRule): () => void {
    const key = `${ruleOwnerKey(rule.owner)}|${rule.action}`;
    if (this.entries.some((entry) => entry.key === key)) {
      throw new Error(`A behavior rule is already registered for ${key}`);
    }
    const entry: Entry = { rule, seq: this.seq++, key, held: null };
    this.entries.push(entry);
    return () => {
      const at = this.entries.indexOf(entry);
      if (at >= 0) this.entries.splice(at, 1);
    };
  }

  /**
   * Remove every rule whose owner satisfies `owned` and return the exchanges
   * those rules still held open, for their provider to settle.
   */
  release(owned: (owner: RuleOwner) => boolean): HeldExchange[] {
    const stillOpen: HeldExchange[] = [];
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (!owned(entry.rule.owner)) continue;
      this.entries.splice(i, 1);
      if (entry.held !== null && entry.held.state === "open") {
        stillOpen.push(entry.held);
      }
    }
    return stillOpen;
  }

  /**
   * Synchronous, and called before the payload is validated, so a rule can
   * own a malformed CALL.
   *
   * Selection: among the rules that name the action (translated on 2.x) and
   * whose `match` fits the payload, the ones for exactly the CALL's connector
   * win over the ones for any connector, then the oldest registration; a
   * warning names the losers.
   */
  resolve(call: BehaviorCall, exchange?: HeldExchange): BehaviorResolution {
    if (this.entries.length === 0) return DEFAULT_RESOLUTION;
    const version = this.options.ocppVersion?.() ?? "OCPP-1.6J";
    const candidates = this.entries.filter(({ rule }) => {
      if (!csmsActionMatches(rule.action, call.action, version)) return false;
      if (
        rule.connectorId !== undefined &&
        call.connectorId !== undefined &&
        rule.connectorId !== call.connectorId
      ) {
        return false;
      }
      // A rule for one connector does not serve a CALL that names none.
      if (rule.connectorId !== undefined && call.connectorId === undefined) {
        return false;
      }
      return (
        rule.match === undefined || deepPartialMatch(rule.match, call.payload)
      );
    });
    if (candidates.length === 0) return DEFAULT_RESOLUTION;

    const exact = (entry: Entry): number =>
      call.connectorId !== undefined &&
      entry.rule.connectorId === call.connectorId
        ? 0
        : 1;
    candidates.sort((a, b) => exact(a) - exact(b) || a.seq - b.seq);
    const [chosen, ...losers] = candidates;
    if (losers.length > 0) {
      this.options.warn?.(
        `${call.action}: ${ruleOwnerKey(chosen.rule.owner)} was chosen over ${losers
          .map((entry) => ruleOwnerKey(entry.rule.owner))
          .join(", ")}`,
      );
    }
    if (exchange === undefined) {
      throw new Error(
        "BehaviorRegistry.resolve needs the exchange of the CALL",
      );
    }

    if (chosen.held !== null && chosen.held.state === "open") {
      this.answerBusy(chosen.rule, exchange);
      return { kind: "busy", rule: chosen.rule };
    }
    chosen.held = exchange;
    exchange.onClosed(() => {
      if (chosen.held === exchange) chosen.held = null;
    });
    chosen.rule.take(call, exchange);
    return { kind: "taken", rule: chosen.rule };
  }

  private answerBusy(rule: BehaviorRule, exchange: HeldExchange): void {
    const answer = rule.onBusy ?? DEFAULT_BUSY_ANSWER;
    this.options.warn?.(
      `${exchange.action}: ${ruleOwnerKey(rule.owner)} is busy with another call; answering onBusy`,
    );
    if ("noResponse" in answer) exchange.suppress();
    else if ("error" in answer) {
      exchange.replyError(answer.error.code, answer.error.description);
    } else exchange.reply(answer.response);
  }
}
