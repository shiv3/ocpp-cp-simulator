import { describe, it, expect } from "bun:test";
import { CLIChargePointService, type CLIEvent } from "../service";
import { BunSqliteDatabase as BunDb } from "../../cp/domain/persistence/BunSqliteDatabase";
import { parkingScenario } from "./parkingScenario";
import { testCpInit } from "./testCpInit";

/**
 * #240: extend / retry / continue on a run parked on a CSMS-call trigger,
 * recorded in the run report and announced with scenario_wait_changed.
 */
const waitingOn = (timeout: number) =>
  parkingScenario(`wait-controls-${timeout}`, { timeout });

function newService(): CLIChargePointService {
  const db = BunDb.open(":memory:");
  return new CLIChargePointService(testCpInit({ cpId: "test-cp" }), db);
}

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe("#240: wait controls on the daemon service", () => {
  it("extends the deadline reported by scenario_status", async () => {
    const svc = newService();
    const id = svc.loadScenario(1, waitingOn(60));
    svc.runScenario(1, id);
    await svc.waitForScenarioArmed(id);

    const before = svc.getScenarioStatus(1, id)!.waitDeadlineAt!;
    expect(typeof before).toBe("number");

    svc.extendScenarioWait(1, id, 30);

    expect(svc.getScenarioStatus(1, id)!.waitDeadlineAt).toBe(before + 30_000);
    svc.stopScenario(1, id);
    await settle();
  });

  it("continues past the wait and records every intervention in the report", async () => {
    const svc = newService();
    const id = svc.loadScenario(1, waitingOn(60));
    const events: CLIEvent[] = [];
    svc.onEvent((ev) => events.push(ev));

    svc.runScenario(1, id);
    await svc.waitForScenarioArmed(id);
    const runId = svc.getScenarioStatus(1, id)!.runId!;

    svc.extendScenarioWait(1, id, 30);
    svc.retryScenarioWait(1, id);
    await settle();
    svc.continueScenarioWait(1, id);
    await settle();

    expect(svc.getScenarioStatus(1, id)!.state).toBe("completed");

    const report = svc.getScenarioRunResult(id)!;
    expect(report.executionState).toBe("completed");
    expect(report.verdict).not.toBe("BLOCKED");
    expect(report.interventions.map((i) => [i.kind, i.nodeId])).toEqual([
      ["extend", "wait-cfg"],
      ["retry", "wait-cfg"],
      ["continue", "wait-cfg"],
    ]);
    expect(report.interventions[0]!.seconds).toBe(30);

    const changes = events.filter((ev) => ev.event === "scenario_wait_changed");
    expect(changes.map((ev) => ev.data)).toEqual([
      {
        connectorId: 1,
        scenarioId: id,
        runId,
        nodeId: "wait-cfg",
        kind: "extend",
      },
      {
        connectorId: 1,
        scenarioId: id,
        runId,
        nodeId: "wait-cfg",
        kind: "retry",
      },
      {
        connectorId: 1,
        scenarioId: id,
        runId,
        nodeId: "wait-cfg",
        kind: "continue",
      },
    ]);
  });

  it("drops the wait deadline from the terminal status of a run stopped mid-wait", async () => {
    const svc = newService();
    const id = svc.loadScenario(1, waitingOn(60));
    svc.runScenario(1, id);
    await svc.waitForScenarioArmed(id);
    expect(svc.getScenarioStatus(1, id)!.waitDeadlineAt).toBeNumber();

    svc.stopScenario(1, id);
    await settle();

    const status = svc.getScenarioStatus(1, id)!;
    expect(status.state).not.toBe("waiting");
    expect(status.waitDeadlineAt ?? null).toBeNull();
  });

  it("reports no interventions for an untouched run", async () => {
    const svc = newService();
    const id = svc.loadScenario(1, waitingOn(0));
    svc.runScenario(1, id);
    await svc.waitForScenarioArmed(id);
    svc.stopScenario(1, id);
    await settle();

    expect(svc.getScenarioRunResult(id)!.interventions).toEqual([]);
  });

  it("refuses controls when the scenario is not running or not waiting", async () => {
    const svc = newService();
    const id = svc.loadScenario(1, waitingOn(0));

    expect(() => svc.continueScenarioWait(1, id)).toThrow(/is not running/);
    expect(() => svc.retryScenarioWait(2, id)).toThrow(
      /not loaded for connector 2/,
    );

    svc.runScenario(1, id);
    await svc.waitForScenarioArmed(id);
    expect(() => svc.extendScenarioWait(1, id, 30)).toThrow(/no timeout/);

    svc.stopScenario(1, id);
    await settle();
  });
});
