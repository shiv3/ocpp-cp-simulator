import type { CallAnswer } from "@ocpp-cp-simulator/contracts/behavior";
import { behaviorActionMatches } from "../../domain/types/csmsActionNames";
import { deepPartialMatch } from "../../../scenario/deepPartialMatch";
import type {
  BehaviorCall,
  BehaviorResolution,
  BehaviorRule,
  ChargePointBehaviorRegistry,
  HeldExchange,
  RuleOwner,
} from "../../domain/engine/behaviorRules";

// The rule vocabulary is defined in domain (#575); re-exported for the
// existing import sites.
export type {
  BehaviorCall,
  BehaviorResolution,
  BehaviorRule,
  HeldAnswerOptions,
  HeldExchange,
  HeldSettlement,
  RuleOwner,
} from "../../domain/engine/behaviorRules";

/**
 * The rules that may take an inbound CSMS CALL over from the default path
 * (docs/concepts/charger-engine.md, "BehaviorRegistry"). One per charge point.
 *
 * Two providers register here: code behaviors (`{ kind: "code" }`, alive as
 * long as the behavior is loaded) and scenario rules (`{ kind: "scenario" }`,
 * alive until their run ends). The registry does the selection, the "one open
 * exchange per rule" bookkeeping and the release by owner; the provider that
 * registered a rule decides what to do with a CALL the rule takes
 * ({@link BehaviorRule.take}).
 */

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

/** The identity of a rule: its owner and its action. */
export function ruleKey(owner: RuleOwner, action: string): string {
  return `${ruleOwnerKey(owner)}|${action}`;
}

export class BehaviorRegistry implements ChargePointBehaviorRegistry {
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
   * Returns a function that removes the rule. `options.rank` is the sequence
   * number of a rule this one replaces (see {@link ranks}): it takes that
   * place in the ranking instead of the newest one.
   */
  register(rule: BehaviorRule, options?: { rank?: number }): () => void {
    const key = ruleKey(rule.owner, rule.action);
    if (this.entries.some((entry) => entry.key === key)) {
      throw new Error(`A behavior rule is already registered for ${key}`);
    }
    const entry: Entry = {
      rule,
      seq: options?.rank ?? this.seq++,
      key,
      held: null,
    };
    this.entries.push(entry);
    return () => {
      const at = this.entries.indexOf(entry);
      if (at >= 0) this.entries.splice(at, 1);
    };
  }

  /** The ranking position of every rule whose owner satisfies `owned`, by rule key. */
  ranks(owned: (owner: RuleOwner) => boolean): Map<string, number> {
    const out = new Map<string, number>();
    for (const entry of this.entries) {
      if (owned(entry.rule.owner)) out.set(entry.key, entry.seq);
    }
    return out;
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
   * whose `match` fits the payload, scenario rules win over code rules; within
   * a kind the ones for exactly the CALL's connector win over the others, then
   * the newest scenario rule or the code rule loaded first. A warning names
   * the losers. A CALL that names no connector matches every rule alike.
   */
  resolve(call: BehaviorCall, exchange?: HeldExchange): BehaviorResolution {
    if (this.entries.length === 0) return DEFAULT_RESOLUTION;
    const version = this.options.ocppVersion?.() ?? "OCPP-1.6J";
    const candidates = this.entries.filter(({ rule }) => {
      if (!behaviorActionMatches(rule.action, call.action, version)) {
        return false;
      }
      return (
        rule.match === undefined || deepPartialMatch(rule.match, call.payload)
      );
    });
    if (candidates.length === 0) return DEFAULT_RESOLUTION;

    // A running scenario wins over code behaviors (docs/concepts/call-precedence.md):
    // first the kind, then the rules for exactly the CALL's connector, then
    // the newest scenario rule or the code rule loaded first.
    const tier = (entry: Entry): number =>
      entry.rule.owner.kind === "scenario" ? 0 : 1;
    const exact = (entry: Entry): number =>
      call.connectorId !== undefined &&
      entry.rule.connectorId === call.connectorId
        ? 0
        : 1;
    const age = (a: Entry, b: Entry): number =>
      a.rule.owner.kind === "scenario" ? b.seq - a.seq : a.seq - b.seq;
    candidates.sort(
      (a, b) => tier(a) - tier(b) || exact(a) - exact(b) || age(a, b),
    );
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
