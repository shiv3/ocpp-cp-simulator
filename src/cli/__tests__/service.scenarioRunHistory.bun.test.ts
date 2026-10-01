import { describe, it, expect } from "bun:test";
import { CLIChargePointService, type CLIEvent } from "../service";
import { BunSqliteDatabase as BunDb } from "../../cp/domain/persistence/BunSqliteDatabase";
import { InMemoryScenarioRunRepository } from "../../cp/domain/persistence/ScenarioRunRepository";
import type { ScenarioRunResult } from "../../cp/application/verification/ScenarioAssertions";
import { completingScenario } from "./completingScenario";
import { parkingScenario } from "./parkingScenario";
import { testCpInit } from "./testCpInit";
import { CPRegistry } from "../server/CPRegistry";
import { EventBus } from "../server/eventBus";

/**
 * #388: a finished run lands in the daemon's run history — the store
 * `scenario_report` reads and `scenario.runs.list` pages through — and is
 * announced with `scenario_run_recorded`.
 */

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

async function runToEnd(
  svc: CLIChargePointService,
  scenarioId: string,
): Promise<string> {
  let runId = "";
  const off = svc.onEvent((ev) => {
    if (ev.event === "scenario_started" && ev.data.scenarioId === scenarioId) {
      runId = ev.data.runId;
    }
  });
  svc.runScenario(1, scenarioId);
  await settle();
  off();
  return runId;
}

describe("#388: scenario run history on the daemon service", () => {
  it("records a finished run and announces it once it is readable", async () => {
    const runs = new InMemoryScenarioRunRepository();
    const svc = new CLIChargePointService(
      testCpInit({ cpId: "cp-a" }),
      null,
      runs,
    );
    const id = svc.loadScenario(1, completingScenario("history-1"));
    const recorded: Array<{ data: unknown; stored: ScenarioRunResult | null }> =
      [];
    svc.onEvent((ev: CLIEvent) => {
      if (ev.event !== "scenario_run_recorded") return;
      recorded.push({ data: ev.data, stored: runs.get("cp-a", ev.data.runId) });
    });

    const runId = await runToEnd(svc, id);

    expect(recorded).toHaveLength(1);
    expect(recorded[0].data).toEqual({ connectorId: 1, scenarioId: id, runId });
    // The event fires after the write, so a client refreshing on it sees the run.
    expect(recorded[0].stored?.runId).toBe(runId);
    expect(recorded[0].stored?.stopped).toBe(false);
    expect(runs.list({ cpId: "cp-a" }).runs.map((r) => r.runId)).toEqual([
      runId,
    ]);
  });

  it("marks a run an operator stopped", async () => {
    const runs = new InMemoryScenarioRunRepository();
    const svc = new CLIChargePointService(
      testCpInit({ cpId: "cp-a" }),
      null,
      runs,
    );
    const id = svc.loadScenario(1, parkingScenario("history-stop"));
    svc.runScenario(1, id);
    await svc.waitForScenarioArmed(id);
    const runId = svc.getScenarioStatus(1, id)!.runId!;

    svc.stopScenario(1, id);
    await settle(50);

    expect(runs.get("cp-a", runId)).toMatchObject({
      stopped: true,
      executionState: "completed",
      timeout: { nodeId: "wait-cfg" },
    });
  });

  it("keeps scenario_report's latest / by-runId / mismatch semantics", async () => {
    const svc = new CLIChargePointService(
      testCpInit({ cpId: "cp-a" }),
      BunDb.open(":memory:"),
    );
    const a = svc.loadScenario(1, completingScenario("report-a"));
    const b = svc.loadScenario(1, completingScenario("report-b"));
    const first = await runToEnd(svc, a);
    const second = await runToEnd(svc, a);
    const other = await runToEnd(svc, b);

    expect(svc.getScenarioReport(1, a)?.runId).toBe(second);
    expect(svc.getScenarioReport(1, a, first)?.runId).toBe(first);
    expect(svc.getScenarioRunResult(b)?.runId).toBe(other);
    // A runId from another scenario does not answer for this one.
    expect(svc.getScenarioReport(1, a, other)).toBeNull();
    expect(svc.getScenarioReport(1, a, "unknown")).toBeNull();
    expect(svc.getScenarioReport(1, "never-run")).toBeNull();
  });

  it("does not serve another charge point's run from a shared store", async () => {
    const runs = new InMemoryScenarioRunRepository();
    const cpA = new CLIChargePointService(
      testCpInit({ cpId: "cp-a" }),
      null,
      runs,
    );
    const cpB = new CLIChargePointService(
      testCpInit({ cpId: "cp-b" }),
      null,
      runs,
    );
    const id = completingScenario("shared-id");
    cpA.loadScenario(1, id);
    cpB.loadScenario(1, id);
    const runA = await runToEnd(cpA, id.id);

    expect(cpB.getScenarioReport(1, id.id)).toBeNull();
    expect(cpB.getScenarioReport(1, id.id, runA)).toBeNull();
    expect(cpA.getScenarioReport(1, id.id, runA)?.cpId).toBe("cp-a");
  });

  it("serves the report after a restart on the same state DB", async () => {
    const db = BunDb.open(":memory:");
    const before = new CLIChargePointService(testCpInit({ cpId: "cp-a" }), db);
    const id = before.loadScenario(1, completingScenario("restart"));
    const runId = await runToEnd(before, id);
    before.cleanup();

    const after = new CLIChargePointService(testCpInit({ cpId: "cp-a" }), db);

    expect(after.getScenarioReport(1, id)?.runId).toBe(runId);
    expect(after.getScenarioReport(1, id, runId)?.transcript).toBeDefined();
  });

  it("still ends the run when the history cannot be written", async () => {
    class FailingRuns extends InMemoryScenarioRunRepository {
      override record(): void {
        throw new Error("disk full");
      }
    }
    const svc = new CLIChargePointService(
      testCpInit({ cpId: "cp-a" }),
      null,
      new FailingRuns(),
    );
    const id = svc.loadScenario(1, completingScenario("write-fails"));
    const events: CLIEvent[] = [];
    svc.onEvent((ev) => events.push(ev));

    await runToEnd(svc, id);

    expect(svc.getScenarioStatus(1, id)?.state).toBe("completed");
    const names = events.map((ev) => ev.event);
    expect(names).toContain("scenario_completed");
    expect(names).not.toContain("scenario_run_recorded");
    // The loss is on the charge point's own log (and so in logs.get), not only
    // on the daemon's stderr.
    const logged = events.flatMap((ev) =>
      ev.event === "log" ? [ev.data.message] : [],
    );
    expect(
      logged.some((m) => m.includes("not recorded") && m.includes("disk full")),
    ).toBe(true);
  });
});

describe("#388: the registry's run history", () => {
  it("is shared by every charge point and forgets a deleted one", async () => {
    const registry = new CPRegistry(new EventBus(), null);
    try {
      for (const cpId of ["cp-a", "cp-b"]) {
        registry.create(testCpInit({ cpId }), { seedDefault: false });
      }
      const a = registry.get("cp-a")!;
      const b = registry.get("cp-b")!;
      a.loadScenario(1, completingScenario("fleet"));
      b.loadScenario(1, completingScenario("fleet"));
      await runToEnd(a, "fleet");
      await runToEnd(b, "fleet");

      expect(
        registry.scenarioRuns
          .list({})
          .runs.map((r) => r.cpId)
          .sort(),
      ).toEqual(["cp-a", "cp-b"]);

      registry.remove("cp-a");

      expect(registry.scenarioRuns.list({}).runs.map((r) => r.cpId)).toEqual([
        "cp-b",
      ]);
    } finally {
      registry.shutdownAll();
    }
  });
});
