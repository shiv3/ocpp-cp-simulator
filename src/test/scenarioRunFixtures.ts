import type { ScenarioRunResult } from "../cp/application/verification/ScenarioAssertions";
import {
  summarizeRun,
  type ScenarioRunSummary,
} from "../cp/application/verification/ScenarioRunSummary";

/** Test fixture (#388): a finished run's report — completed, PASS, one sent
 *  Heartbeat in its transcript — with `overrides` applied. Plain TS, shared by
 *  the bun and vitest suites. */
export function scenarioRunResult(
  overrides: Partial<ScenarioRunResult> = {},
): ScenarioRunResult {
  const startedAt = overrides.startedAt ?? "2026-09-30T08:00:00.000Z";
  return {
    schemaVersion: 1,
    runId: "s1#1",
    scenarioId: "s1",
    scenarioName: "Scenario one",
    cpId: "CP-1",
    connectorId: 1,
    simulatorVersion: "test",
    ocppVersion: "OCPP-1.6J",
    startedAt,
    endedAt: "2026-09-30T08:00:02.000Z",
    durationMs: 2000,
    executionState: "completed",
    verdict: "PASS",
    conformanceVerdict: "PASS",
    compatibilityVerdict: "SKIPPED",
    strict: false,
    assertions: [],
    transcript: [
      {
        seq: 0,
        ts: startedAt,
        direction: "sent",
        kind: "call",
        uniqueId: "u1",
        action: "Heartbeat",
        payload: {},
      },
    ],
    errors: [],
    timeout: null,
    interventions: [],
    initialState: {
      connectorStatus: "Available",
      meterValue: 0,
      transactionId: null,
    },
    finalState: {
      connectorStatus: "Available",
      meterValue: 0,
      transactionId: null,
    },
    ...overrides,
  };
}

/** The listing row of {@link scenarioRunResult}`(overrides)`. */
export function scenarioRunSummary(
  overrides: Partial<ScenarioRunResult> = {},
): ScenarioRunSummary {
  return summarizeRun(scenarioRunResult(overrides));
}
