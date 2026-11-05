import { describe, expect, it } from "vitest";

import { mapServerEventToChargePointEvent } from "./RemoteChargePointService";

describe("mapServerEventToChargePointEvent scenario_run_recorded (#388)", () => {
  it("maps the daemon event to scenario-run-recorded", () => {
    expect(
      mapServerEventToChargePointEvent({
        event: "scenario_run_recorded",
        data: { connectorId: 1, scenarioId: "s1", runId: "s1#1" },
      } as never),
    ).toEqual({
      type: "scenario-run-recorded",
      connectorId: 1,
      scenarioId: "s1",
      runId: "s1#1",
    });
  });

  it("drops an event without a runId: there is no run to refresh on", () => {
    expect(
      mapServerEventToChargePointEvent({
        event: "scenario_run_recorded",
        data: { connectorId: 1, scenarioId: "s1" },
      } as never),
    ).toBeNull();
  });
});
