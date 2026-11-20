import { afterEach, describe, expect, it } from "bun:test";
import { CLIChargePointService } from "../service";
import { ScenarioNodeType } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import {
  startMockCsms,
  type MockCsms,
} from "@ocpp-cp-simulator/core/cp/infrastructure/transport/__tests__/mockCsms";
import { testCpInit } from "./testCpInit";

/**
 * The frames the last node of a run causes must be in the run's transcript:
 * the DataTransfer node is fire-and-forget and the 1.6 serial queue holds the
 * CALL behind one the CSMS has not answered yet, so it goes out after the
 * `end` node. The run is not complete (and its transcript not closed) until
 * the wire is quiet.
 */
function dataTransferScenario(): ScenarioDefinition {
  return {
    id: "transcript-tail",
    name: "Transcript tail",
    targetType: "connector",
    targetId: 1,
    nodes: [
      {
        id: "start-1",
        type: ScenarioNodeType.START,
        position: { x: 0, y: 0 },
        data: { label: "S" },
      },
      {
        id: "probe",
        type: ScenarioNodeType.DATA_TRANSFER,
        position: { x: 0, y: 1 },
        data: {
          label: "Probe",
          vendorId: "org.example.tail",
          messageId: "tail-probe",
        },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 2 },
        data: { label: "E" },
      },
    ],
    edges: [
      { id: "e1", source: "start-1", target: "probe" },
      { id: "e2", source: "probe", target: "end-1" },
    ],
    createdAt: "2026-07-13T00:00:00Z",
    updatedAt: "2026-07-13T00:00:00Z",
    assertions: [
      {
        id: "probe-sent",
        type: "payload_match",
        action: "DataTransfer",
        payload: { vendorId: "org.example.tail", messageId: "tail-probe" },
      },
    ],
  } as ScenarioDefinition;
}

let csms: MockCsms | null = null;
let svc: CLIChargePointService | null = null;

afterEach(async () => {
  svc?.cleanup();
  svc = null;
  await csms?.stop();
  csms = null;
});

describe("scenario transcript tail", () => {
  it("includes a CALL that is sent after the last node returned", async () => {
    csms = startMockCsms();
    svc = new CLIChargePointService(
      testCpInit({ cpId: "cp-tail", wsUrl: csms.url }),
      null,
    );
    await svc.connect();
    const boot = await csms.waitForCall("BootNotification");
    csms.replyCallResult(boot.messageId, {
      currentTime: "2026-01-01T00:00:00Z",
      interval: 300,
      status: "Accepted",
    });
    // Hold the 1.6 queue: the first StatusNotification stays unanswered.
    const status = await csms.waitForCall("StatusNotification");

    const id = svc.loadScenario(1, dataTransferScenario());
    await Bun.sleep(100);
    expect(svc.getScenarioRunResult(id)).toBeNull();

    csms.replyCallResult(status.messageId, {});
    // Answer whatever else the station sends (the held DataTransfer included).
    const answered = new Set<string>([status.messageId, boot.messageId]);
    const answerRest = (async () => {
      for (let i = 0; i < 100; i++) {
        for (const frame of [...csms!.received]) {
          const [type, callId, action] = frame as [number, string, string];
          if (type !== 2 || answered.has(callId)) continue;
          answered.add(callId);
          csms!.replyCallResult(
            callId,
            action === "DataTransfer" ? { status: "Accepted" } : {},
          );
        }
        if (svc?.getScenarioRunResult(id) !== null) return;
        await Bun.sleep(20);
      }
    })();

    for (let i = 0; i < 100 && !svc.getScenarioRunResult(id); i++) {
      await Bun.sleep(50);
    }
    await answerRest;
    const result = svc.getScenarioRunResult(id);
    expect(result).not.toBeNull();
    expect(result!.assertions[0]).toMatchObject({
      id: "probe-sent",
      status: "passed",
    });
  }, 20_000);
});
