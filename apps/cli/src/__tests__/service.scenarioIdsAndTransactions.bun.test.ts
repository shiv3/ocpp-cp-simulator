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
 * Two small ergonomics of a headless run: the id `run_scenario_template`
 * answers with (`<templateId>-c<connector>`) is not the only one the scenario
 * commands accept (the template id and the connector name it too), and the
 * status and report carry the transaction ids the run started so a harness
 * does not have to dig them out of the transcript.
 */
const TRANSACTION_ID = 4242;

let csms: MockCsms | null = null;
let svc: CLIChargePointService | null = null;
let answering = false;

afterEach(async () => {
  answering = false;
  svc?.cleanup();
  svc = null;
  await csms?.stop();
  csms = null;
});

/** Answer every CALL the station sends the way a CSMS that accepts all would. */
async function startAnswering(server: MockCsms): Promise<void> {
  answering = true;
  const answered = new Set<string>();
  void (async () => {
    while (answering) {
      for (const frame of [...server.received]) {
        const [type, id, action] = frame as [number, string, string];
        if (type !== 2 || answered.has(id)) continue;
        answered.add(id);
        const payload =
          action === "BootNotification"
            ? {
                currentTime: "2026-01-01T00:00:00Z",
                interval: 300,
                status: "Accepted",
              }
            : action === "StartTransaction"
              ? {
                  transactionId: TRANSACTION_ID,
                  idTagInfo: { status: "Accepted" },
                }
              : action === "Authorize" || action === "StopTransaction"
                ? { idTagInfo: { status: "Accepted" } }
                : action === "DataTransfer"
                  ? { status: "Accepted" }
                  : {};
        server.replyCallResult(id, payload);
      }
      await Bun.sleep(10);
    }
  })();
}

async function connected(cpId: string): Promise<CLIChargePointService> {
  csms = startMockCsms();
  svc = new CLIChargePointService(testCpInit({ cpId, wsUrl: csms.url }), null);
  await startAnswering(csms);
  await svc.connect();
  await csms.waitForCall("BootNotification");
  await Bun.sleep(300);
  return svc;
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  for (let i = 0; i < ms / 20 && !check(); i++) await Bun.sleep(20);
  expect(check()).toBe(true);
}

function session(): ScenarioDefinition {
  const at = (y: number) => ({ x: 0, y });
  return {
    id: "tx-session",
    name: "Session",
    targetType: "connector",
    targetId: 1,
    nodes: [
      {
        id: "start-1",
        type: ScenarioNodeType.START,
        position: at(0),
        data: { label: "S" },
      },
      {
        id: "tx-start",
        type: ScenarioNodeType.TRANSACTION,
        position: at(1),
        data: { label: "Start", action: "start", tagId: "TX-TAG" },
      },
      {
        id: "hold",
        type: ScenarioNodeType.DELAY,
        position: at(2),
        data: { label: "Hold", delaySeconds: 2 },
      },
      {
        id: "tx-stop",
        type: ScenarioNodeType.TRANSACTION,
        position: at(3),
        data: { label: "Stop", action: "stop" },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: at(4),
        data: { label: "E" },
      },
    ],
    edges: [
      { id: "e1", source: "start-1", target: "tx-start" },
      { id: "e2", source: "tx-start", target: "hold" },
      { id: "e3", source: "hold", target: "tx-stop" },
      { id: "e4", source: "tx-stop", target: "end-1" },
    ],
    createdAt: "2026-11-21T00:00:00Z",
    updatedAt: "2026-11-21T00:00:00Z",
  } as ScenarioDefinition;
}

describe("scenario_status and the report carry the transaction ids", () => {
  it("shows the running transaction, then the one the finished run started", async () => {
    const service = await connected("cp-tx-ids");
    const id = service.loadScenario(1, session(), { autoStart: false });
    service.runScenario(1, id);

    await until(
      () => service.getScenarioStatus(1, id)?.transactionId === TRANSACTION_ID,
    );
    expect(service.getScenarioStatus(1, id)).toMatchObject({
      state: expect.stringMatching(/running|waiting/),
      transactionIds: [TRANSACTION_ID],
    });

    await until(() => service.getScenarioStatus(1, id)?.state === "completed");
    expect(service.getScenarioStatus(1, id)).toMatchObject({
      state: "completed",
      transactionId: TRANSACTION_ID,
      transactionIds: [TRANSACTION_ID],
    });
    await until(() => service.getScenarioRunResult(id) !== null);
    expect(service.getScenarioRunResult(id)?.transactionIds).toEqual([
      TRANSACTION_ID,
    ]);
  }, 30_000);

  it("is null before any transaction", async () => {
    const service = await connected("cp-tx-none");
    const id = service.loadScenarioTemplate(
      "cert16-tc064-data-transfer",
      1,
      undefined,
      {
        autoStart: false,
      },
    );
    service.runScenario(1, id);
    await until(() => service.getScenarioStatus(1, id)?.state === "completed");
    expect(service.getScenarioStatus(1, id)).toMatchObject({
      transactionId: null,
      transactionIds: [],
    });
  }, 30_000);
});

describe("the template id and the connector name the instance", () => {
  it("status, report, get and run accept the template id", async () => {
    const service = await connected("cp-template-ids");
    const templateId = "cert16-tc064-data-transfer";
    const instance = service.loadScenarioTemplate(templateId, 1, undefined, {
      autoStart: false,
    });
    expect(instance).toBe(`${templateId}-c1`);

    expect(service.getScenario(1, templateId)?.id).toBe(instance);
    service.runScenario(1, templateId);
    await until(() => service.getScenarioStatus(1, templateId) !== null);
    expect(service.getScenarioStatus(1, templateId)?.scenarioId).toBe(instance);
    await until(
      () => service.getScenarioStatus(1, templateId)?.state === "completed",
    );
    await until(() => service.getScenarioReport(1, templateId) !== null);
    expect(service.getScenarioReport(1, templateId)?.scenarioId).toBe(instance);
    expect(service.getScenarioReport(1, instance)?.runId).toBe(
      service.getScenarioReport(1, templateId)?.runId,
    );
  }, 30_000);

  it("another connector's instance and an unknown id are not guessed", async () => {
    const service = await connected("cp-template-ids-2");
    service.loadScenarioTemplate("cert16-tc064-data-transfer", 1, undefined, {
      autoStart: false,
    });
    expect(service.getScenarioStatus(1, "no-such-scenario")).toBeNull();
    expect(service.getScenario(1, "no-such-scenario")).toBeNull();
    // Same template, but loaded on connector 1 only: nothing for connector 2.
    expect(service.getScenario(2, "cert16-tc064-data-transfer")).toBeNull();
  }, 30_000);
});

describe("the maxDurationSeconds override of a template load", () => {
  it("sets the bound, and 0 removes the template's own", async () => {
    const service = await connected("cp-max-duration");
    const a = service.loadScenarioTemplate(
      "status-triggered-actions",
      1,
      undefined,
      {
        autoStart: false,
        maxDurationSeconds: 7,
      },
    );
    expect(service.getScenario(1, a)?.maxDurationSeconds).toBe(7);
    const b = service.loadScenarioTemplate(
      "status-triggered-actions",
      1,
      undefined,
      {
        autoStart: false,
        maxDurationSeconds: 0,
      },
    );
    expect(service.getScenario(1, b)?.maxDurationSeconds).toBeUndefined();
    const c = service.loadScenarioTemplate(
      "status-triggered-actions",
      1,
      undefined,
      {
        autoStart: false,
      },
    );
    expect(service.getScenario(1, c)?.maxDurationSeconds).toBe(60);
  }, 30_000);
});
