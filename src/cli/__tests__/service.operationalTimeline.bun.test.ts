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
  it("records a run's start and completion with its runId", async () => {
    const svc = new CLIChargePointService(testCpInit({ cpId: "cp-a" }));
    const id = svc.loadScenario(1, completingScenario("timeline-1"));

    svc.runScenario(1, id);
    await settle();

    const entries = svc.getOperationalTimeline({
      kinds: ["scenario_started", "scenario_completed"],
    }).entries;
    expect(entries.map((e) => e.kind)).toEqual([
      "scenario_started",
      "scenario_completed",
    ]);
    const runId = entries[0]!.runId;
    expect(runId).toEqual(expect.stringContaining(`${id}#`));
    for (const entry of entries) {
      expect(entry).toMatchObject({
        cpId: "cp-a",
        connectorId: 1,
        runId,
        data: { scenarioId: id },
      });
    }
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
    expect(svc.getOperationalTimeline({ runId }).entries.at(-1)?.kind).toBe(
      "scenario_completed",
    );
  });
});
