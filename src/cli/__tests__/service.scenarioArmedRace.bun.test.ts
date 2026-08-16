import { describe, it, expect } from "bun:test";
import { Database as BunSqliteDatabase } from "bun:sqlite";
import { CLIChargePointService } from "../service";
import { BunSqliteDatabase as BunDb } from "../../cp/domain/persistence/BunSqliteDatabase";
import { runMigrations } from "../../cp/domain/persistence/schema";
import {
  ScenarioDefinition,
  ScenarioNodeType,
} from "../../cp/application/scenario/ScenarioTypes";

/**
 * Opt-in companion to the run_scenario / RemoteStartTransaction race fix
 * (see remoteStartRace.test.ts for the visibility half): a caller that
 * passes `awaitArmed` doesn't get the RPC response back until the run has
 * either parked on its first expectation (armed) or ended without ever
 * parking, closing the race entirely instead of just reporting it.
 */
function newService(): CLIChargePointService {
  const raw = new BunSqliteDatabase(":memory:");
  const db = new BunDb(raw);
  runMigrations(db);
  return new CLIChargePointService(
    {
      cpId: "test-cp",
      wsUrl: "ws://127.0.0.1:65534/never",
      connectors: 1,
      vendor: "v",
      model: "m",
    },
    db,
  );
}

/** start -> delay(delaySeconds) -> remoteStartTrigger -> end. Mirrors the
 *  reported graph shape (delay/plug-in nodes before the trigger). */
function delayedRemoteStartScenario(
  connectorId: number,
  delaySeconds: number,
): ScenarioDefinition {
  return {
    id: `delayed-remote-start-${connectorId}`,
    name: "Delayed Remote Start",
    targetType: "connector",
    targetId: connectorId,
    nodes: [
      {
        id: "start-1",
        type: ScenarioNodeType.START,
        position: { x: 0, y: 0 },
        data: { label: "Start" },
      },
      {
        id: "delay-1",
        type: ScenarioNodeType.DELAY,
        position: { x: 0, y: 1 },
        data: { label: "Delay", delaySeconds },
      },
      {
        id: "trigger-remote-start",
        type: ScenarioNodeType.REMOTE_START_TRIGGER,
        position: { x: 0, y: 2 },
        data: { label: "Wait RemoteStart", timeout: 0 },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 3 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e1", source: "start-1", target: "delay-1" },
      { id: "e2", source: "delay-1", target: "trigger-remote-start" },
      { id: "e3", source: "trigger-remote-start", target: "end-1" },
    ],
    createdAt: "2026-08-16T00:00:00Z",
    updatedAt: "2026-08-16T00:00:00Z",
  };
}

/** start -> delay(delaySeconds) -> end. No waiting node at all — exercises
 *  waitForScenarioArmed's bound (a scenario with nothing to arm on must not
 *  hang the caller for the full delay). */
function longDelayNoTriggerScenario(
  connectorId: number,
  delaySeconds: number,
): ScenarioDefinition {
  return {
    id: `long-delay-no-trigger-${connectorId}`,
    name: "Long Delay, No Trigger",
    targetType: "connector",
    targetId: connectorId,
    nodes: [
      {
        id: "start-1",
        type: ScenarioNodeType.START,
        position: { x: 0, y: 0 },
        data: { label: "Start" },
      },
      {
        id: "delay-1",
        type: ScenarioNodeType.DELAY,
        position: { x: 0, y: 1 },
        data: { label: "Delay", delaySeconds },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 2 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e1", source: "start-1", target: "delay-1" },
      { id: "e2", source: "delay-1", target: "end-1" },
    ],
    createdAt: "2026-08-16T00:00:00Z",
    updatedAt: "2026-08-16T00:00:00Z",
  };
}

describe("CLIChargePointService.waitForScenarioArmed", () => {
  it("blocks until the trigger node arms, not just until run_scenario returns", async () => {
    const svc = newService();
    const id = svc.loadScenario(1, delayedRemoteStartScenario(1, 0.3));

    const before = Date.now();
    svc.runScenario(1, id);
    // Fire-and-forget contract is unchanged: runScenario itself is still
    // synchronous void and returns immediately.
    expect(Date.now() - before).toBeLessThan(50);

    await svc.waitForScenarioArmed(id);
    const elapsed = Date.now() - before;

    // Must not have resolved before the delay node let the executor reach
    // the trigger — that's exactly the race this closes.
    expect(elapsed).toBeGreaterThanOrEqual(280);
    const status = svc.getScenarioStatus(1, id);
    expect(status!.state).toBe("waiting");
    expect(status!.expectation).toMatchObject({
      action: "RemoteStartTransaction",
    });

    svc.stopScenario(1, id);
  });

  it("resolves immediately if the run is already armed by the time it's called", async () => {
    const svc = newService();
    const id = svc.loadScenario(1, delayedRemoteStartScenario(1, 0.05));
    svc.runScenario(1, id);

    // Let it actually arm first.
    for (let i = 0; i < 100; i++) {
      if (svc.getScenarioStatus(1, id)?.state === "waiting") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(svc.getScenarioStatus(1, id)!.state).toBe("waiting");

    const before = Date.now();
    await svc.waitForScenarioArmed(id);
    expect(Date.now() - before).toBeLessThan(20);

    svc.stopScenario(1, id);
  });

  it("is bounded by maxWaitMs when the run has no near-term expectation", async () => {
    const svc = newService();
    // 5s delay and no waiting node at all — without a bound this would hang
    // the RPC caller for the whole delay.
    const id = svc.loadScenario(1, longDelayNoTriggerScenario(1, 5));

    const before = Date.now();
    svc.runScenario(1, id);
    await svc.waitForScenarioArmed(id, 100);
    const elapsed = Date.now() - before;

    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(1000);

    svc.stopScenario(1, id);
  });

  it("resolves immediately for an unknown/already-finished scenarioId (never rejects)", async () => {
    const svc = newService();
    await expect(
      svc.waitForScenarioArmed("no-such-scenario", 50),
    ).resolves.toBeUndefined();
  });
});
