// The vocabularies in `packages/contracts/src` are written out as literals so the
// contract package needs nothing from the charge point (#578). This pins them
// to the charge-point types they describe, at compile time (`bun run
// typecheck`), so a new verdict or execution state cannot be added on one side
// only.
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ScenarioVerdict } from "../../application/scenario/ScenarioTypes";
import type { ScenarioRunResult } from "../../application/verification/ScenarioAssertions";
import {
  SCENARIO_RUN_EXECUTION_STATES,
  SCENARIO_VERDICTS,
} from "@ocpp-cp-simulator/contracts/scenario";
import { DEFAULT_AUTHORIZATION_CACHE_MAX_ENTRIES } from "../../domain/auth/AuthorizationCache";
import { AUTHORIZATION_CACHE_SEED_MAX } from "@ocpp-cp-simulator/contracts/authorization";
import { STOP_TRANSACTION_REASON_VALUES } from "@ocpp-cp-simulator/contracts/transactionVocabulary";

describe("protocol vocabularies match the charge-point types", () => {
  it("scenario verdicts", () => {
    expectTypeOf<
      (typeof SCENARIO_VERDICTS)[number]
    >().toEqualTypeOf<ScenarioVerdict>();
    expect(SCENARIO_VERDICTS).toEqual(["PASS", "FAIL", "BLOCKED", "SKIPPED"]);
  });

  it("scenario run execution states", () => {
    expectTypeOf<
      (typeof SCENARIO_RUN_EXECUTION_STATES)[number]
    >().toEqualTypeOf<ScenarioRunResult["executionState"]>();
    expect(SCENARIO_RUN_EXECUTION_STATES).toEqual(["completed", "error"]);
  });

  it("the authorization seed bound is the cache capacity", () => {
    expect(AUTHORIZATION_CACHE_SEED_MAX).toBe(
      DEFAULT_AUTHORIZATION_CACHE_MAX_ENTRIES,
    );
  });

  it("1.6 stop reasons", () => {
    expect(STOP_TRANSACTION_REASON_VALUES).toHaveLength(11);
  });
});
