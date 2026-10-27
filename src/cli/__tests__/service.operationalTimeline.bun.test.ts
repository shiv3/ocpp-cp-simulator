import { describe, it, expect } from "bun:test";
import { CLIChargePointService } from "../service";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import { completingScenario } from "./completingScenario";
import { parkingScenario } from "./parkingScenario";
import { testCpInit } from "./testCpInit";

/**
 * #448: scenario runs are minted by the daemon service, so it is the service
 * that records their lifecycle on the operational timeline and attributes the
 * connector's entries to the run in progress.
 */

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

describe("#448: scenario runs on the operational timeline", () => {
  it("records a run's start and its outcome with its runId", async () => {
    const svc = new CLIChargePointService(testCpInit({ cpId: "cp-a" }));
    const id = svc.loadScenario(1, completingScenario("timeline-1"));

    svc.runScenario(1, id);
    await settle();

    const entries = svc.getOperationalTimeline({
      kinds: ["scenario_started", "scenario_finished"],
    }).entries;
    expect(entries.map((e) => e.kind)).toEqual([
      "scenario_started",
      "scenario_finished",
    ]);
    const runId = entries[0]!.runId;
    expect(runId).toEqual(expect.stringContaining(`${id}#`));
    for (const entry of entries) {
      expect(entry).toMatchObject({
        cpId: "cp-a",
        connectorId: 1,
        runId,
        data: expect.objectContaining({ scenarioId: id }),
      });
    }
    expect(entries[1]!.data).toEqual({
      scenarioId: id,
      verdict: svc.getScenarioReport(1, id)!.verdict,
      executionState: "completed",
      stopped: false,
    });
  });

  it("pushes every entry as a timeline_entry event", async () => {
    const svc = new CLIChargePointService(testCpInit({ cpId: "cp-a" }));
    const pushed: unknown[] = [];
    svc.onEvent((ev) => {
      if (ev.event === "timeline_entry") pushed.push(ev.data);
    });
    const id = svc.loadScenario(1, completingScenario("timeline-push"));

    svc.runScenario(1, id);
    await settle();

    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed).toEqual(svc.getOperationalTimeline().entries);
  });

  it("attributes connector entries to the run until it ends", async () => {
    const svc = new CLIChargePointService(testCpInit({ cpId: "cp-a" }));
    const id = svc.loadScenario(1, parkingScenario("timeline-park"));
    svc.runScenario(1, id);
    await svc.waitForScenarioArmed(id);
    const runId = svc.getScenarioStatus(1, id)!.runId!;

    svc.updateConnectorStatus(1, OCPPStatus.Preparing);
    svc.stopScenario(1, id);
    await settle(50);
    svc.updateConnectorStatus(1, OCPPStatus.Available);

    const statuses = svc.getOperationalTimeline({
      kinds: ["connector_status"],
    }).entries;
    expect(statuses.map((e) => [e.data.to, e.runId])).toEqual([
      [OCPPStatus.Preparing, runId],
      [OCPPStatus.Available, undefined],
    ]);
    // A manual stop is reported as one, not as a completed run.
    expect(svc.getOperationalTimeline({ runId }).entries.at(-1)).toMatchObject({
      kind: "scenario_finished",
      data: { stopped: true },
    });
    expect(
      svc.getOperationalTimeline({ kinds: ["scenario_finished"] }).total,
    ).toBe(1);
  });
});
