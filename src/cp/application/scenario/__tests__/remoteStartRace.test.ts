import { describe, expect, it } from "vitest";

import { createScenarioExecutorCallbacks } from "../ScenarioRuntime";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import { RemoteStartTransactionHandler } from "../../../infrastructure/transport/handlers/call/RemoteStartTransactionHandler";
import { RemoteStopTransactionHandler } from "../../../infrastructure/transport/handlers/call/RemoteStopTransactionHandler";
import type { HandlerContext } from "../../../infrastructure/transport/handlers/MessageHandlerRegistry";

/**
 * A client that calls run_scenario and immediately fires the
 * RemoteStartTransaction/RemoteStopTransaction the scenario is meant to
 * intercept can race the trigger node's arming: ScenarioRuntime only calls
 * ChargePoint.registerScenarioHandler when the executor actually reaches the
 * trigger node (e.g. after preceding delay/plug-in nodes), not when
 * run_scenario is called. Until then RemoteStartTransactionHandler /
 * RemoteStopTransactionHandler / handleRequestStartTransactionV201 /
 * handleRequestStopTransactionV201 take their default branch and start/stop
 * a REAL transaction outside the scenario, silently. The scenario then
 * parks at the trigger node waiting for a call that will never come again.
 *
 * These tests reproduce the race directly: call the real handler while
 * unarmed (the bypass), then arm the trigger node the way ScenarioRuntime
 * does, and assert the bypass is now reported via the scenario's log.
 */
function newChargePoint(id: string): ChargePoint {
  // wsUrl points at an unused local port — no real transport connection is
  // ever attempted, matching the pattern used by cert16RemoteStart.test.ts.
  const cp = new ChargePoint(
    id,
    DefaultBootNotification,
    1,
    "ws://127.0.0.1:9/",
    null,
    null,
  );
  cp.events.on("error", () => undefined);
  return cp;
}

describe("run_scenario / RemoteStartTransaction race — bypass visibility", () => {
  it("warns when RemoteStartTransaction bypasses the scenario before the trigger node arms", async () => {
    const cp = newChargePoint("CP-RACE-START");
    const connector = cp.getConnector(1)!;
    const logs: Array<{ message: string; level?: string }> = [];

    // run_scenario's callbacks are built the instant the run starts (this
    // is what anchors runStartedAt) — well before the executor's delay/
    // plug-in nodes let it reach the trigger node and actually arm.
    const callbacks = createScenarioExecutorCallbacks({
      chargePoint: cp,
      connector,
      hooks: { log: (message, level) => logs.push({ message, level }) },
    });

    // The race: a RemoteStartTransaction arrives (and is handled by the
    // DEFAULT path, starting a real transaction) BEFORE the scenario's
    // trigger node has had a chance to call registerScenarioHandler.
    expect(cp.isScenarioHandled(1)).toBe(false);
    new RemoteStartTransactionHandler().handle(
      { idTag: "RACE-TAG", connectorId: 1 },
      { chargePoint: cp, logger: cp.logger } satisfies HandlerContext,
    );
    expect(connector.transaction).not.toBeNull();

    // The scenario now reaches its trigger node and arms — exactly what
    // ScenarioRuntime.waitForRemoteStart does via onWaitForRemoteStart.
    const wait = callbacks.onWaitForRemoteStart!(0);

    const warning = logs.find(
      (l) => l.level === "warn" && l.message.includes("RemoteStartTransaction"),
    );
    expect(warning).toBeDefined();
    expect(warning!.message).toMatch(/handled OUTSIDE this scenario/);
    expect(warning!.message).toMatch(/race between run_scenario/);

    wait.cancel?.();
  });

  it("does NOT warn when the trigger node armed before RemoteStartTransaction arrived (normal order)", async () => {
    const cp = newChargePoint("CP-RACE-START-OK");
    const connector = cp.getConnector(1)!;
    const logs: Array<{ message: string; level?: string }> = [];

    const callbacks = createScenarioExecutorCallbacks({
      chargePoint: cp,
      connector,
      hooks: { log: (message, level) => logs.push({ message, level }) },
    });
    const wait = callbacks.onWaitForRemoteStart!(0);
    expect(cp.isScenarioHandled(1)).toBe(true);

    new RemoteStartTransactionHandler().handle(
      { idTag: "NORMAL-TAG", connectorId: 1 },
      { chargePoint: cp, logger: cp.logger } satisfies HandlerContext,
    );

    const result = await wait;
    expect(typeof result === "string" ? result : result.tagId).toBe(
      "NORMAL-TAG",
    );
    expect(
      logs.some((l) => l.level === "warn" && l.message.includes("race")),
    ).toBe(false);
  });

  it("does NOT warn about a bypass that predates this run (stale/unrelated)", async () => {
    const cp = newChargePoint("CP-RACE-START-STALE");
    const connector = cp.getConnector(1)!;
    const logs: Array<{ message: string; level?: string }> = [];

    // A RemoteStartTransaction is bypassed well before anything about a new
    // scenario run exists yet — e.g. a leftover from a previous, unrelated
    // run on this same connector.
    new RemoteStartTransactionHandler().handle(
      { idTag: "OLD-TAG", connectorId: 1 },
      { chargePoint: cp, logger: cp.logger } satisfies HandlerContext,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Only now does the (new, unrelated) run's callbacks get built and its
    // trigger node arm — createScenarioExecutorCallbacks captures its own
    // runStartedAt at this point, strictly after the stale bypass above.
    const callbacks = createScenarioExecutorCallbacks({
      chargePoint: cp,
      connector,
      hooks: { log: (message, level) => logs.push({ message, level }) },
    });
    const wait = callbacks.onWaitForRemoteStart!(0);

    expect(
      logs.some((l) => l.level === "warn" && l.message.includes("race")),
    ).toBe(false);

    wait.cancel?.();
  });

  it("warns when RemoteStopTransaction bypasses the scenario before the trigger node arms", async () => {
    const cp = newChargePoint("CP-RACE-STOP");
    const connector = cp.getConnector(1)!;
    const logs: Array<{ message: string; level?: string }> = [];

    await cp.startTransaction("RACE-TAG", 1, undefined, undefined, {
      triggerReason: "RemoteStart",
    });
    const txId = connector.transaction!.id;

    // See the RemoteStart test above: callbacks (and runStartedAt) must
    // exist before the bypass, mirroring run_scenario building them at run
    // start, well before the trigger node actually arms.
    const callbacks = createScenarioExecutorCallbacks({
      chargePoint: cp,
      connector,
      hooks: { log: (message, level) => logs.push({ message, level }) },
    });

    expect(cp.isScenarioStopHandled(1)).toBe(false);
    new RemoteStopTransactionHandler().handle({ transactionId: txId }, {
      chargePoint: cp,
      logger: cp.logger,
    } satisfies HandlerContext);
    expect(connector.transaction).toBeNull();

    const wait = callbacks.onWaitForRemoteStop!(0);

    const warning = logs.find(
      (l) => l.level === "warn" && l.message.includes("RemoteStopTransaction"),
    );
    expect(warning).toBeDefined();
    expect(warning!.message).toMatch(/handled OUTSIDE this scenario/);

    wait.cancel?.();
  });
});
