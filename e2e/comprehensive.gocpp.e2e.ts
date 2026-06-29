import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ChargePoint } from "../src/cp/domain/charge-point/ChargePoint";
import {
  DefaultBootNotification,
  OCPPStatus,
} from "../src/cp/domain/types/OcppTypes";
import type { ScenarioDefinition } from "../src/cp/application/scenario/ScenarioTypes";
import {
  startCsms,
  stopAllCsms,
  type CommandResponse,
  type CsmsHandle,
} from "./support/gocppCsms";
import type { Frame } from "./support/frameLog";
import { runScenario, waitUntil } from "./support/scenarioRunner";

type OcppVersion = "OCPP-1.6J" | "OCPP-2.0.1" | "OCPP-2.1";

interface VersionCase {
  version: OcppVersion;
  label: string;
  cpPrefix: string;
}

const WAIT_TIMEOUT_MS = 12_000;
const TEST_TIMEOUT_MS = 60_000;
const SCENARIO_TIMEOUT_MS = 45_000;
const REMOTE_TAG = "ALLCASES-REMOTE-TAG";
const CSMS_RESERVATION_ID = 7777;
const SCENARIO_FILE = `${import.meta.dir}/../docs/examples/scenarios/all-cases.json`;

const VERSION_CASES: VersionCase[] = [
  { version: "OCPP-1.6J", label: "1.6", cpPrefix: "cp16" },
  { version: "OCPP-2.0.1", label: "2.0.1", cpPrefix: "cp201" },
  { version: "OCPP-2.1", label: "2.1", cpPrefix: "cp21" },
];

const csmsByVersion = new Map<OcppVersion, CsmsHandle>();

function loadScenario(): ScenarioDefinition {
  // Parse fresh per run so sequential versions never share mutable state, and
  // so this exercises the same JSON the daemon loads via
  // --scenario-template-file.
  return JSON.parse(readFileSync(SCENARIO_FILE, "utf-8")) as ScenarioDefinition;
}

beforeAll(async () => {
  for (const { version } of VERSION_CASES) {
    csmsByVersion.set(version, await startCsms(version));
  }
});

afterAll(async () => {
  await stopAllCsms();
});

describe("all-cases scenario covers every node type across versions", () => {
  for (const versionCase of VERSION_CASES) {
    test(
      `all-cases.json runs to completion on OCPP ${versionCase.label}`,
      async () => {
        const csms = getCsms(versionCase.version);
        const cpId = `${versionCase.cpPrefix}-all-cases`;
        const cp = makeChargePoint(cpId, versionCase.version, csms);
        let reserveDriven = false;
        let startDriven = false;
        let stopDriven = false;

        try {
          await connectBootReady(cp, cpId, csms, versionCase.version);
          const sinceSeq = lastSeq(csms, cpId);

          const result = await runScenario(cp, loadScenario(), {
            timeoutMs: SCENARIO_TIMEOUT_MS,
            // reservationTrigger has no park flag — drive the CSMS ReserveNow
            // when the executor reaches that node.
            onNodeExecute: async (_nodeId, nodeType) => {
              if (nodeType !== "reservationTrigger") return;
              reserveDriven = true;
              assertCommandResult(
                await sendReserveNow(csms, cpId, versionCase.version),
              );
            },
            onParkStart: async () => {
              startDriven = true;
              const res = assertCommandResult(
                await sendRemoteStart(csms, cpId, versionCase.version),
              );
              expect(res).toMatchObject({ status: "Accepted" });
            },
            onParkStop: async () => {
              const transactionId =
                versionCase.version === "OCPP-1.6J"
                  ? await waitForNumericTransactionId(cp, 1)
                  : transactionIdOf(
                      await waitForTransactionEvent(
                        csms,
                        cpId,
                        "Started",
                        sinceSeq,
                      ),
                    );
              stopDriven = true;
              const res = assertCommandResult(
                await sendRemoteStop(
                  csms,
                  cpId,
                  versionCase.version,
                  transactionId,
                ),
              );
              expect(res).toMatchObject({ status: "Accepted" });
            },
          });

          // Completion proves every node on the linear path executed through to
          // the `end` node without erroring.
          expect(result.errored).toBe(false);
          expect(result.completed).toBe(true);
          expect(reserveDriven).toBe(true);
          expect(startDriven).toBe(true);
          expect(stopDriven).toBe(true);

          // Common to all versions.
          await waitForAction(csms, cpId, "Heartbeat", sinceSeq);
          const dataTransfer = await waitForPayload(
            csms,
            cpId,
            "DataTransfer",
            (p) => p.vendorId === "com.example.vendor",
            sinceSeq,
          );
          expect(payloadOf(dataTransfer)).toMatchObject({
            vendorId: "com.example.vendor",
            messageId: "DiagnosticsPing",
          });

          if (versionCase.version === "OCPP-1.6J") {
            await assert16(csms, cpId, sinceSeq);
          } else {
            await assert2x(csms, cpId, sinceSeq);
          }
        } finally {
          await cp.disconnect();
        }
      },
      TEST_TIMEOUT_MS,
    );
  }
});

async function assert16(
  csms: CsmsHandle,
  cpId: string,
  sinceSeq: number,
): Promise<void> {
  const start = await waitForPayload(
    csms,
    cpId,
    "StartTransaction",
    (p) => p.idTag === REMOTE_TAG,
    sinceSeq,
  );
  await waitForPayload(
    csms,
    cpId,
    "MeterValues",
    (p) => typeof p.transactionId === "number",
    start.seq,
  );
  await waitForPayload(
    csms,
    cpId,
    "StopTransaction",
    (p) => p.reason === "Remote",
    start.seq,
  );
  // 1.6 StatusNotification carries the full fault context on the wire.
  const fault = await waitForPayload(
    csms,
    cpId,
    "StatusNotification",
    (p) => p.status === "Faulted",
    sinceSeq,
  );
  expect(payloadOf(fault)).toMatchObject({
    status: "Faulted",
    errorCode: "GroundFailure",
    vendorErrorCode: "GF-001",
  });
}

async function assert2x(
  csms: CsmsHandle,
  cpId: string,
  sinceSeq: number,
): Promise<void> {
  const started = await waitForTransactionEvent(
    csms,
    cpId,
    "Started",
    sinceSeq,
  );
  expect(payloadOf(started)).toMatchObject({
    eventType: "Started",
    triggerReason: "RemoteStart",
    idToken: { idToken: REMOTE_TAG },
  });
  const transactionId = transactionIdOf(started);
  await waitForPayload(
    csms,
    cpId,
    "MeterValues",
    (p) => p.evseId === 1,
    started.seq,
  );
  await waitForPayload(
    csms,
    cpId,
    "TransactionEvent",
    (p) =>
      p.eventType === "Ended" &&
      isRecord(p.transactionInfo) &&
      p.transactionInfo.transactionId === transactionId,
    started.seq,
  );
  // 2.x StatusNotification has no errorCode field — the fault context is
  // dropped; only the mapped connectorStatus is sent.
  const fault = await waitForPayload(
    csms,
    cpId,
    "StatusNotification",
    (p) => p.connectorStatus === "Faulted",
    sinceSeq,
  );
  const faultPayload = payloadOf(fault);
  expect(faultPayload).toMatchObject({ connectorStatus: "Faulted", evseId: 1 });
  expect(faultPayload.errorCode).toBeUndefined();
  expect(faultPayload.vendorErrorCode).toBeUndefined();
}

function makeChargePoint(
  cpId: string,
  version: OcppVersion,
  csms: CsmsHandle,
): ChargePoint {
  const cp = new ChargePoint(
    cpId,
    DefaultBootNotification,
    1,
    csms.ocppUrl,
    null,
    null,
    null,
    {},
    [],
    version,
  );
  cp.logger.setEnabledTypes();
  cp.events.on("error", () => undefined);
  cp.connectors.forEach((connector) => {
    connector.setOnMeterValueSend((connectorId) => {
      cp.sendMeterValue(connectorId);
    });
  });
  return cp;
}

async function connectBootReady(
  cp: ChargePoint,
  cpId: string,
  csms: CsmsHandle,
  version: OcppVersion,
): Promise<void> {
  await cp.connect();
  const boot = await csms.frames.waitForCall("BootNotification", {
    cpId,
    timeoutMs: WAIT_TIMEOUT_MS,
  });
  if (version !== "OCPP-1.6J") {
    await waitForPayload(
      csms,
      cpId,
      "StatusNotification",
      (p) => p.connectorStatus === "Available",
      boot.seq,
    );
  }
  await waitUntil(() => cp.getConnector(1)?.status === OCPPStatus.Available);
}

function getCsms(version: OcppVersion): CsmsHandle {
  const csms = csmsByVersion.get(version);
  if (!csms) throw new Error(`CSMS not started for ${version}`);
  return csms;
}

function lastSeq(csms: CsmsHandle, cpId: string): number {
  const frames = csms.frames.byCp(cpId);
  return frames.length === 0 ? 0 : frames[frames.length - 1]!.seq;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function payloadOf(frame: Frame): Record<string, unknown> {
  if (!isRecord(frame.payload)) {
    throw new Error(`Expected ${frame.action} payload to be an object`);
  }
  return frame.payload;
}

async function waitForPayload(
  csms: CsmsHandle,
  cpId: string,
  action: string,
  pred: (payload: Record<string, unknown>) => boolean,
  sinceSeq: number,
): Promise<Frame> {
  return csms.frames.waitForFrame(
    (frame) =>
      frame.cpId === cpId &&
      frame.action === action &&
      frame.seq > sinceSeq &&
      isRecord(frame.payload) &&
      pred(frame.payload),
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
}

async function waitForAction(
  csms: CsmsHandle,
  cpId: string,
  action: string,
  sinceSeq: number,
): Promise<Frame> {
  return csms.frames.waitForFrame(
    (frame) =>
      frame.cpId === cpId && frame.action === action && frame.seq > sinceSeq,
    { timeoutMs: WAIT_TIMEOUT_MS },
  );
}

async function waitForTransactionEvent(
  csms: CsmsHandle,
  cpId: string,
  eventType: string,
  sinceSeq: number,
): Promise<Frame> {
  return waitForPayload(
    csms,
    cpId,
    "TransactionEvent",
    (p) => p.eventType === eventType,
    sinceSeq,
  );
}

function transactionIdOf(frame: Frame): string {
  const payload = payloadOf(frame);
  if (!isRecord(payload.transactionInfo)) {
    throw new Error("Expected transactionInfo to be an object");
  }
  const transactionId = payload.transactionInfo.transactionId;
  if (typeof transactionId !== "string" || transactionId.length === 0) {
    throw new Error("Expected transactionInfo.transactionId to be a string");
  }
  return transactionId;
}

async function waitForNumericTransactionId(
  cp: ChargePoint,
  connectorId: number,
): Promise<number> {
  let transactionId = 0;
  await waitUntil(() => {
    const id = cp.getConnector(connectorId)?.transaction?.id;
    if (typeof id === "number" && id > 0) {
      transactionId = id;
      return true;
    }
    return false;
  });
  return transactionId;
}

function assertCommandResult(
  response: CommandResponse,
): Record<string, unknown> {
  if (!response.ok) {
    throw new Error(response.error ?? "CSMS command failed");
  }
  const result = response.result;
  if (!isRecord(result)) {
    throw new Error("Expected CSMS command result to be an object");
  }
  return result;
}

function sendReserveNow(
  csms: CsmsHandle,
  cpId: string,
  version: OcppVersion,
): Promise<CommandResponse> {
  const expiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  if (version === "OCPP-1.6J") {
    return csms.command({
      cpId,
      action: "ReserveNow",
      connectorId: 1,
      expiryDate: expiry,
      idTag: REMOTE_TAG,
      reservationId: CSMS_RESERVATION_ID,
    });
  }
  return csms.command({
    cpId,
    action: "ReserveNow",
    evseId: 1,
    expiryDateTime: expiry,
    id: CSMS_RESERVATION_ID,
    idToken: { idToken: REMOTE_TAG, type: "ISO14443" },
  });
}

function sendRemoteStart(
  csms: CsmsHandle,
  cpId: string,
  version: OcppVersion,
): Promise<CommandResponse> {
  if (version === "OCPP-1.6J") {
    return csms.command({
      cpId,
      action: "RemoteStartTransaction",
      idTag: REMOTE_TAG,
      connectorId: 1,
    });
  }
  return csms.command({
    cpId,
    action: "RequestStartTransaction",
    idToken: { idToken: REMOTE_TAG, type: "ISO14443" },
    evseId: 1,
  });
}

function sendRemoteStop(
  csms: CsmsHandle,
  cpId: string,
  version: OcppVersion,
  transactionId: number | string,
): Promise<CommandResponse> {
  if (version === "OCPP-1.6J") {
    return csms.command({
      cpId,
      action: "RemoteStopTransaction",
      transactionId,
    });
  }
  return csms.command({
    cpId,
    action: "RequestStopTransaction",
    transactionId,
  });
}
