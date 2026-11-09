import { describe, expect, it, vi } from "vitest";
import type { ChargePointEvents } from "../../../domain/charge-point/ChargePointEvents";
import type { Connector } from "../../../domain/connector/Connector";
import { OCPPStatus } from "../../../domain/types/OcppTypes";
import { EventEmitter } from "../../../shared/EventEmitter";
import { Logger } from "../../../shared/Logger";
import { VirtualClock } from "../../../shared/clock";
import type { Rng } from "../../../shared/rng";
import { DEFAULT_SERVICES } from "../createDefaultServices";

/**
 * #575: the default factories hand the charge point's clock and random
 * streams to the services they build. Every service constructor defaults
 * both (real clock, system streams), so a dropped argument would still
 * compile and run.
 */
const START = Date.UTC(2031, 5, 1, 12, 0, 0);

function fixedRng(id: string): Rng {
  return {
    next: () => 0,
    int: (min) => min,
    pick: (items) => items[0]!,
    uuid: () => id,
  };
}

describe("DEFAULT_SERVICES (#575)", () => {
  it("runs the heartbeat on the given clock", async () => {
    const clock = new VirtualClock({ start: START });
    const heartbeat = DEFAULT_SERVICES.createHeartbeat(new Logger(), clock);
    const send = vi.fn();
    heartbeat.setHeartbeatCallback(send);
    heartbeat.startHeartbeat(10);
    await clock.advanceBy(10_000);
    expect(send).toHaveBeenCalledTimes(1);
    heartbeat.cleanup();
  });

  it("stamps the state history with the given clock and stream", () => {
    const clock = new VirtualClock({ start: START });
    const stateManager = DEFAULT_SERVICES.createStateManager({
      logger: new Logger(),
      events: new EventEmitter<ChargePointEvents>(),
      chargePoint: () => ({ status: OCPPStatus.Unavailable, error: "" }),
      clock,
      rng: fixedRng("state-history-id"),
    });
    stateManager.transitionChargePointStatus(OCPPStatus.Available, {
      source: "test",
      timestamp: new Date(START),
    });
    const [entry] = stateManager.history.getHistory();
    expect(entry?.id).toBe("state-history-id");
    expect(entry?.timestamp.getTime()).toBe(START);
  });

  it("stamps the timeline with the given clock and its incidents with the stream", () => {
    const clock = new VirtualClock({ start: START });
    const events = new EventEmitter<ChargePointEvents>();
    const { timeline, projector } = DEFAULT_SERVICES.createTimeline({
      cpId: "cp-services",
      events,
      connectors: new Map<number, Connector>(),
      clock,
      rng: fixedRng("timeline-id"),
    });
    events.emit("networkFaultInjected", {
      ruleId: "r1",
      ruleType: "manual-disconnect",
      reconnectDelayMs: 1000,
    });
    const [entry] = timeline.query().entries;
    expect(entry?.cpId).toBe("cp-services");
    expect(entry?.incidentId).toBe("timeline-id");
    expect(entry?.timestamp).toBe(new Date(START).toISOString());
    projector.dispose();
  });
});
