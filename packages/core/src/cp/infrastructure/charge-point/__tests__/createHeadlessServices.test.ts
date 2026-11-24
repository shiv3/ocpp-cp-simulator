import { describe, expect, it } from "vitest";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import { createChargePoint } from "../createChargePoint";
import { createHeadlessServices } from "../createHeadlessServices";

describe("createHeadlessServices (#1126)", () => {
  it("replaces the timeline and the state history, nothing else", () => {
    const cp = createChargePoint(
      "cp-headless",
      DefaultBootNotification,
      1,
      "ws://localhost:9/ocpp",
      null,
      null,
      null,
      {},
      [],
      "OCPP-1.6J",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {},
      createHeadlessServices(),
    );
    expect(cp.timeline.query()).toEqual({ entries: [], total: 0 });
    expect(cp.stateManager.history.getHistory()).toEqual([]);
    expect(cp.connectors.size).toBe(1);
    cp.dispose();
  });

  it("leaves the default services when no services are given", () => {
    const cp = createChargePoint(
      "cp-default",
      DefaultBootNotification,
      1,
      "ws://localhost:9/ocpp",
      null,
      null,
    );
    expect(cp.stateManager.constructor.name).toBe("StateManager");
    cp.dispose();
  });
});
