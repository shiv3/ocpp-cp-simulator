// The k6 runtime repeats the behavior API's types (it may not import another
// package). This holds the copy and the contract assignable to each other, so
// a change to one that is not made to the other fails the typecheck.
import { describe, expect, it } from "vitest";
import type {
  Behavior as ContractBehavior,
  BehaviorContext as ContractContext,
  CallOutcome as ContractOutcome,
} from "@ocpp-cp-sim/contracts/behavior";
import type {
  Behavior,
  BehaviorContext,
  CallOutcome,
} from "@ocpp-cp-sim/k6-runtime/behaviorTypes";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const behavior: Same<ContractBehavior, Behavior> = true;
const context: Same<ContractContext, BehaviorContext> = true;
const outcome: Same<ContractOutcome, CallOutcome> = true;

describe("behaviorTypes mirror", () => {
  it("equals the contract", () => {
    expect([behavior, context, outcome]).toEqual([true, true, true]);
  });
});
