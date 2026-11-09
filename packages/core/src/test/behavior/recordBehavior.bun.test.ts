// Record a behavior run as a scenario (#654, step 2).
import { afterEach, describe, expect, test } from "bun:test";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { validateScenarioSchema } from "../../scenario/scenarioSchemaValidator";
import { validateScenarioGraph } from "../../scenario/scenarioGraphValidator";
import { recordBehavior } from "./recordBehavior";
import { runBehavior, type BehaviorRun } from "./runBehavior";
import { startScenario } from "./runScenario";

let run: BehaviorRun | undefined;
afterEach(async () => {
  await run?.dispose();
  run = undefined;
});

const fw = {
  location: "http://fw.example/f.bin",
  retrieveDate: "2020-01-01T00:00:00.000Z",
};
const stamp = { commit: "abc1234", simulatorVersion: "0.0.0-test" };

const types = (r: { scenario: { nodes: Array<{ type?: string }> } }) =>
  r.scenario.nodes.map((n) => n.type);

describe("recordBehavior", () => {
  test("default.firmware: a run becomes csmsCallTrigger, callResponse, delay and notify nodes", async () => {
    const rec = await recordBehavior({
      behavior: "default.firmware",
      version: "1.6",
      trigger: { action: "UpdateFirmware", payload: fw },
      params: { stepMs: 3000, failAt: "InstallationFailed" },
      seed: "s1",
      ...stamp,
    });
    expect(types(rec)).toEqual([
      "start",
      "csmsCallTrigger",
      "callResponse",
      "notify",
      "delay",
      "notify",
      "delay",
      "notify",
      "delay",
      "notify",
      "end",
    ]);
    const data = rec.scenario.nodes.map(
      (n) => n.data as unknown as Record<string, unknown>,
    );
    expect(data[1]).toMatchObject({
      action: "UpdateFirmware",
      behavior: "replace",
    });
    // OCPP 1.6 section 6.19: the answer to UpdateFirmware is empty.
    expect(data[2]).toMatchObject({ kind: "accepted" });
    expect(
      data.filter((d) => d.kind === "firmwareStatus").map((d) => d.status),
    ).toEqual([
      "Downloading",
      "Downloaded",
      "Installing",
      "InstallationFailed",
    ]);
    expect(
      data
        .filter((d) => d.delaySeconds !== undefined)
        .map((d) => d.delaySeconds),
    ).toEqual([3, 3, 3]);
    expect(rec.scenario.recordedFrom).toEqual({
      behaviorId: "default.firmware",
      commit: "abc1234",
      seed: "s1",
      version: "0.0.0-test",
    });
    expect(rec.diagram).toContain("sequenceDiagram");
    expect(rec.diagram).toContain(
      "FirmwareStatusNotification InstallationFailed",
    );
    // The output is a valid scenario file and a valid graph.
    expect(validateScenarioSchema(rec.scenario).errors).toEqual([]);
    expect(validateScenarioGraph(rec.scenario)).toEqual([]);
  }, 60_000);

  test("the recording replays to the same wire as the behavior", async () => {
    const rec = await recordBehavior({
      behavior: "default.firmware",
      version: "1.6",
      trigger: { action: "UpdateFirmware", payload: fw },
      params: { stepMs: 5000 },
      ...stamp,
    });
    run = await runBehavior({ version: "1.6" });
    // Only the scenario answers and paces: 5 s steps, where the default
    // behavior would have finished its 2 s steps by now.
    startScenario(run, rec.scenario);
    await run.settle();
    const answer = await run.call("UpdateFirmware", fw);
    expect(answer.payload).toEqual({});
    const statuses = (): string[] =>
      run!
        .callsOf("FirmwareStatusNotification")
        .map((f) => (f.payload as { status: string }).status);
    await run.advanceInSteps(6000, 250);
    expect(statuses()).toEqual(["Downloading", "Downloaded"]);
    await run.advanceInSteps(20_000, 250);
    expect(statuses()).toEqual([
      "Downloading",
      "Downloaded",
      "Installing",
      "Installed",
    ]);
  }, 60_000);

  test("the same seed records the same scenario, another seed another delay", async () => {
    const record = (seed: string) =>
      recordBehavior({
        behavior: "default.firmware",
        version: "1.6",
        trigger: { action: "UpdateFirmware", payload: fw },
        params: { stepMs: 1000, jitterMs: 2000 },
        seed,
        stepMs: 50,
        ...stamp,
      });
    const [a, b, c] = [await record("x"), await record("x"), await record("y")];
    expect(b.scenario).toEqual(a.scenario);
    expect(c.scenario.nodes).not.toEqual(a.scenario.nodes);
  }, 120_000);

  test("a code behavior: a requestId copied from the CALL becomes a $from, a rejected answer is rejected", async () => {
    const b: Behavior = {
      api: 1,
      id: "mine",
      onCall: {
        GetLog: {
          mode: "replace",
          handle: (req, ctx) => ({
            response: { status: "Accepted" },
            after: async () => {
              const requestId = (req as { requestId: number }).requestId;
              ctx.notify.logStatus("Uploading", { requestId });
              await ctx.sleep(5000);
              ctx.notify.logStatus("Uploaded", { requestId });
            },
          }),
        },
        Reset: {
          mode: "replace",
          handle: (_req, ctx) => ({ response: ctx.rejected("Reset") }),
        },
      },
    };
    const log = await recordBehavior({
      behavior: b,
      version: "2.0.1",
      trigger: {
        action: "GetLog",
        payload: {
          logType: "DiagnosticsLog",
          requestId: 7,
          log: { remoteLocation: "http://x/" },
        },
      },
      ...stamp,
    });
    const notify = log.scenario.nodes
      .filter((n) => n.type === "notify")
      .map((n) => n.data as unknown as Record<string, unknown>);
    expect(notify[0]).toMatchObject({
      kind: "logStatus",
      status: "Uploading",
      requestId: { $from: "call.payload.requestId" },
    });
    const reset = await recordBehavior({
      behavior: b,
      version: "1.6",
      trigger: { action: "Reset", payload: { type: "Soft" } },
      ...stamp,
    });
    expect(
      reset.scenario.nodes.find((n) => n.type === "callResponse")?.data,
    ).toMatchObject({ kind: "rejected" });
  }, 60_000);
});
