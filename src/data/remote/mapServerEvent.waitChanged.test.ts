import { describe, expect, it } from "vitest";

import { mapServerEventToChargePointEvent } from "./RemoteChargePointService";

describe("mapServerEventToChargePointEvent scenario_wait_changed (#240)", () => {
  it("maps the daemon event to scenario-wait-changed", () => {
    expect(
      mapServerEventToChargePointEvent({
        event: "scenario_wait_changed",
        data: {
          connectorId: 1,
          scenarioId: "s1",
          runId: "s1#1",
          nodeId: "wait",
          kind: "extend",
        },
      } as never),
    ).toEqual({
      type: "scenario-wait-changed",
      connectorId: 1,
      scenarioId: "s1",
      runId: "s1#1",
      nodeId: "wait",
      kind: "extend",
    });
  });

  it("drops a malformed event instead of guessing its kind", () => {
    expect(
      mapServerEventToChargePointEvent({
        event: "scenario_wait_changed",
        data: { connectorId: 1, scenarioId: "s1", nodeId: "wait", kind: "?" },
      } as never),
    ).toBeNull();
  });
});
