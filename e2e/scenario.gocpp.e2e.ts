import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ChargePoint } from "../src/cp/domain/charge-point/ChargePoint";
import {
  DefaultBootNotification,
  OCPPStatus,
} from "../src/cp/domain/types/OcppTypes";
import {
  startCsms,
  stopAllCsms,
  type CommandResponse,
  type CsmsHandle,
} from "./support/gocppCsms";
import type { Frame } from "./support/frameLog";
import { runScenario, waitUntil } from "./support/scenarioRunner";
import { makeRemoteSession } from "./scenarios/remoteSession";
import { makeAutonomousCharge } from "./scenarios/autonomousCharge";
import {
  HEARTBEAT_INTERVAL_VALUE,
  makeConfigSetScenario,
} from "./scenarios/configSetScenario";
import { makeStatusWalk2x } from "./scenarios/statusWalk2x";
import { makeAutoMeterFullCycle2x } from "./scenarios/autoMeterFullCycle2x";
import { makeMultiTransaction2x } from "./scenarios/multiTransaction2x";
import { makeReservationNode2x } from "./scenarios/reservationNode2x";
import {
  DATA_TRANSFER_MESSAGE_ID,
  DATA_TRANSFER_PAYLOAD,
  DATA_TRANSFER_VENDOR_ID,
  makeDataTransferNode2x,
} from "./scenarios/dataTransferNode2x";

type OcppVersion = "OCPP-1.6J" | "OCPP-2.0.1" | "OCPP-2.1";

interface VersionCase {
  version: OcppVersion;
  label: string;
  cpPrefix: string;
}

const WAIT_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 30_000;
const REMOTE_TAG = "REMOTE-SCENARIO-TAG";

const VERSION_CASES: VersionCase[] = [
  { version: "OCPP-1.6J", label: "1.6", cpPrefix: "cp16" },
  { version: "OCPP-2.0.1", label: "2.0.1", cpPrefix: "cp201" },
  { version: "OCPP-2.1", label: "2.1", cpPrefix: "cp21" },
];
const TWO_X_VERSION_CASES = VERSION_CASES.filter(
  ({ version }) => version !== "OCPP-1.6J",
);

const csmsByVersion = new Map<OcppVersion, CsmsHandle>();

beforeAll(async () => {
  for (const { version } of VERSION_CASES) {
    csmsByVersion.set(version, await startCsms(version));
  }
});

afterAll(async () => {
  await stopAllCsms();
});

describe("scenario-driven gocpp e2e", () => {
  for (const versionCase of VERSION_CASES) {
    test(
      `remoteSession parks for CSMS RemoteStart/RemoteStop on OCPP ${versionCase.label}`,
      async () => {
        const csms = getCsms(versionCase.version);
        const cpId = `${versionCase.cpPrefix}-scenario-remote`;
        const cp = makeChargePoint(cpId, versionCase.version, csms);
        let startCommandSeq: number | null = null;
        let stopCommandSeq: number | null = null;

        try {
          await connectBootReady(cp, cpId, csms, versionCase.version);
          const sinceSeq = lastSeq(csms, cpId);

          const result = await runScenario(cp, makeRemoteSession(), {
            timeoutMs: 20_000,
            onParkStart: async () => {
              startCommandSeq = lastSeq(csms, cpId);
              const result = assertCommandResult(
                await sendRemoteStart(csms, cpId, versionCase.version),
              );
              expect(result).toMatchObject({ status: "Accepted" });
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
              stopCommandSeq = lastSeq(csms, cpId);
              const result = assertCommandResult(
                await sendRemoteStop(
                  csms,
                  cpId,
                  versionCase.version,
                  transactionId,
                ),
              );
              expect(result).toMatchObject({ status: "Accepted" });
            },
          });

          expect(result.completed).toBe(true);
          expect(result.errored).toBe(false);
          if (startCommandSeq === null) {
            throw new Error("RemoteStart park callback was not fired");
          }
          if (stopCommandSeq === null) {
            throw new Error("RemoteStop park callback was not fired");
          }

          assertNoTransactionStartBefore(
            csms,
            cpId,
            versionCase.version,
            sinceSeq,
            startCommandSeq,
          );
          assertNoTransactionStopBefore(
            csms,
            cpId,
            versionCase.version,
            sinceSeq,
            stopCommandSeq,
          );

          if (versionCase.version === "OCPP-1.6J") {
            await assertRemoteSession16(
              csms,
              cpId,
              sinceSeq,
              startCommandSeq,
              stopCommandSeq,
            );
          } else {
            await assertRemoteSession2x(
              csms,
              cpId,
              sinceSeq,
              startCommandSeq,
              stopCommandSeq,
            );
          }
        } finally {
          await cp.disconnect();
        }
      },
      TEST_TIMEOUT_MS,
    );
  }

  test(
    "autonomousCharge completes on OCPP 2.0.1 without CSMS commands",
    async () => {
      const version: OcppVersion = "OCPP-2.0.1";
      const csms = getCsms(version);
      const cpId = "cp201-scenario-autonomous";
      const cp = makeChargePoint(cpId, version, csms);

      try {
        await connectBootReady(cp, cpId, csms, version);
        const sinceSeq = lastSeq(csms, cpId);

        const result = await runScenario(cp, makeAutonomousCharge(), {
          timeoutMs: 20_000,
        });

        expect(result.completed).toBe(true);
        expect(result.errored).toBe(false);
        const started = await waitForTransactionEvent(
          csms,
          cpId,
          "Started",
          sinceSeq,
        );
        const transactionId = transactionIdOf(started);
        const meter = await waitForPayload(
          csms,
          cpId,
          "MeterValues",
          (payload) => payload.evseId === 1,
          started.seq,
        );
        const ended = await waitForTransactionEnded(
          csms,
          cpId,
          transactionId,
          meter.seq,
        );

        expect(payloadOf(started)).toMatchObject({
          eventType: "Started",
          idToken: { idToken: "AUTO-TAG", type: "ISO14443" },
          evse: { id: 1, connectorId: 1 },
        });
        expect(started.seq).toBeLessThan(meter.seq);
        expect(meter.seq).toBeLessThan(ended.seq);
      } finally {
        await cp.disconnect();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "configSet scenario updates HeartbeatInterval observable via GetVariables",
    async () => {
      const version: OcppVersion = "OCPP-2.0.1";
      const csms = getCsms(version);
      const cpId = "cp201-scenario-config-set";
      const cp = makeChargePoint(cpId, version, csms);

      try {
        await connectBootReady(cp, cpId, csms, version);

        const result = await runScenario(cp, makeConfigSetScenario(), {
          timeoutMs: 20_000,
        });
        expect(result.completed).toBe(true);
        expect(result.errored).toBe(false);

        const commandResult = assertCommandResult(
          await csms.command({
            cpId,
            action: "GetVariables",
            getVariableData: [
              {
                component: { name: "OCPPCommCtrlr" },
                variable: { name: "HeartbeatInterval" },
              },
            ],
          }),
        );
        const first = firstRecordFromArray(
          commandResult.getVariableResult,
          "getVariableResult",
        );

        expect(first).toMatchObject({
          attributeStatus: "Accepted",
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "HeartbeatInterval" },
          attributeValue: HEARTBEAT_INTERVAL_VALUE,
        });
      } finally {
        await cp.disconnect();
      }
    },
    TEST_TIMEOUT_MS,
  );

  for (const versionCase of TWO_X_VERSION_CASES) {
    test(
      `statusWalk maps 2.x connector statuses on OCPP ${versionCase.label}`,
      async () => {
        const csms = getCsms(versionCase.version);
        const cpId = `${versionCase.cpPrefix}-scenario-status-walk`;
        const cp = makeChargePoint(cpId, versionCase.version, csms);

        try {
          await connectBootReady(cp, cpId, csms, versionCase.version);
          const sinceSeq = lastSeq(csms, cpId);

          const result = await runScenario(cp, makeStatusWalk2x(), {
            timeoutMs: 20_000,
          });
          expect(result.completed).toBe(true);
          expect(result.errored).toBe(false);

          const expectedStatuses = [
            "Available",
            "Occupied",
            "Occupied",
            "Occupied",
            "Occupied",
            "Occupied",
            "Available",
          ];
          const statuses = await waitForActionFrames(
            csms,
            cpId,
            "StatusNotification",
            sinceSeq,
            expectedStatuses.length,
          );

          expect(
            statuses.map((frame) => payloadOf(frame).connectorStatus),
          ).toEqual(expectedStatuses);
          for (const frame of statuses) {
            expect(payloadOf(frame)).toMatchObject({
              evseId: 1,
              connectorId: 1,
            });
          }
        } finally {
          await cp.disconnect();
        }
      },
      TEST_TIMEOUT_MS,
    );
  }

  for (const versionCase of TWO_X_VERSION_CASES) {
    test(
      `autoMeter full cycle sends two MeterValues on OCPP ${versionCase.label}`,
      async () => {
        const csms = getCsms(versionCase.version);
        const cpId = `${versionCase.cpPrefix}-scenario-auto-meter`;
        const cp = makeChargePoint(cpId, versionCase.version, csms);

        try {
          await connectBootReady(cp, cpId, csms, versionCase.version);
          const sinceSeq = lastSeq(csms, cpId);

          const result = await runScenario(cp, makeAutoMeterFullCycle2x(), {
            timeoutMs: 20_000,
          });
          expect(result.completed).toBe(true);
          expect(result.errored).toBe(false);

          await waitUntil(
            () =>
              transactionEventFramesSince(csms, cpId, sinceSeq).length >= 2 &&
              actionFramesSince(csms, cpId, "MeterValues", sinceSeq).length >=
                2,
            WAIT_TIMEOUT_MS,
          );

          const txEvents = transactionEventFramesSince(csms, cpId, sinceSeq);
          const meterValues = actionFramesSince(
            csms,
            cpId,
            "MeterValues",
            sinceSeq,
          );
          const started = txEvents.find(
            (frame) => payloadOf(frame).eventType === "Started",
          );
          if (!started) throw new Error("Expected TransactionEvent Started");
          const transactionId = transactionIdOf(started);
          const ended = txEvents.find(
            (frame) =>
              payloadOf(frame).eventType === "Ended" &&
              transactionIdOf(frame) === transactionId,
          );
          if (!ended)
            throw new Error("Expected matching TransactionEvent Ended");

          expect(meterValues).toHaveLength(2);
          expect(meterValues.map(energyValueFromMeterValues)).toEqual([
            100, 200,
          ]);
          for (const meterValue of meterValues) {
            expect(payloadOf(meterValue)).toMatchObject({ evseId: 1 });
          }
          expect(started.seq).toBeLessThan(meterValues[0]!.seq);
          expect(meterValues[0]!.seq).toBeLessThan(meterValues[1]!.seq);
          expect(meterValues[1]!.seq).toBeLessThan(ended.seq);
        } finally {
          await cp.disconnect();
        }
      },
      TEST_TIMEOUT_MS,
    );
  }

  test(
    "multiTransaction emits distinct paired TransactionEvents on OCPP 2.0.1",
    async () => {
      const version: OcppVersion = "OCPP-2.0.1";
      const csms = getCsms(version);
      const cpId = "cp201-scenario-multi-transaction";
      const cp = makeChargePoint(cpId, version, csms);

      try {
        await connectBootReady(cp, cpId, csms, version);
        const sinceSeq = lastSeq(csms, cpId);

        const result = await runScenario(cp, makeMultiTransaction2x(), {
          timeoutMs: 20_000,
        });
        expect(result.completed).toBe(true);
        expect(result.errored).toBe(false);

        const txEvents = await waitForTransactionEventCount(
          csms,
          cpId,
          sinceSeq,
          4,
        );
        expect(txEvents.map((frame) => payloadOf(frame).eventType)).toEqual([
          "Started",
          "Ended",
          "Started",
          "Ended",
        ]);

        const firstTransactionId = transactionIdOf(txEvents[0]!);
        const secondTransactionId = transactionIdOf(txEvents[2]!);
        expect(firstTransactionId).not.toBe(secondTransactionId);
        expect(transactionIdOf(txEvents[1]!)).toBe(firstTransactionId);
        expect(transactionIdOf(txEvents[3]!)).toBe(secondTransactionId);
        expect(txEvents[0]!.seq).toBeLessThan(txEvents[1]!.seq);
        expect(txEvents[1]!.seq).toBeLessThan(txEvents[2]!.seq);
        expect(txEvents[2]!.seq).toBeLessThan(txEvents[3]!.seq);
      } finally {
        await cp.disconnect();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "reservation scenario node emits Reserved then Available on OCPP 2.0.1",
    async () => {
      const version: OcppVersion = "OCPP-2.0.1";
      const csms = getCsms(version);
      const cpId = "cp201-scenario-reservation-node";
      const cp = makeChargePoint(cpId, version, csms);

      try {
        await connectBootReady(cp, cpId, csms, version);
        const sinceSeq = lastSeq(csms, cpId);

        const result = await runScenario(cp, makeReservationNode2x(), {
          timeoutMs: 20_000,
        });
        expect(result.completed).toBe(true);
        expect(result.errored).toBe(false);

        const statuses = await waitForActionFrames(
          csms,
          cpId,
          "StatusNotification",
          sinceSeq,
          2,
        );
        expect(
          statuses.map((frame) => payloadOf(frame).connectorStatus),
        ).toEqual(["Reserved", "Available"]);
      } finally {
        await cp.disconnect();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "dataTransfer scenario node sends DataTransfer on OCPP 2.0.1",
    async () => {
      const version: OcppVersion = "OCPP-2.0.1";
      const csms = getCsms(version);
      const cpId = "cp201-scenario-data-transfer-node";
      const cp = makeChargePoint(cpId, version, csms);

      try {
        await connectBootReady(cp, cpId, csms, version);
        const sinceSeq = lastSeq(csms, cpId);

        const result = await runScenario(cp, makeDataTransferNode2x(), {
          timeoutMs: 20_000,
        });
        expect(result.completed).toBe(true);
        expect(result.errored).toBe(false);

        const dataTransfer = await waitForPayload(
          csms,
          cpId,
          "DataTransfer",
          (payload) => payload.vendorId === DATA_TRANSFER_VENDOR_ID,
          sinceSeq,
        );
        expect(payloadOf(dataTransfer)).toMatchObject({
          vendorId: DATA_TRANSFER_VENDOR_ID,
          messageId: DATA_TRANSFER_MESSAGE_ID,
          data: DATA_TRANSFER_PAYLOAD,
        });
      } finally {
        await cp.disconnect();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

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
    {},
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
    await waitForStatusNotification(csms, cpId, "Available", boot.seq);
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
  return frames.length === 0 ? 0 : frames[frames.length - 1].seq;
}

function payloadOf(frame: Frame): Record<string, unknown> {
  if (!isRecord(frame.payload)) {
    throw new Error(`Expected ${frame.action} payload to be an object`);
  }
  return frame.payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordField(
  value: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const child = value[field];
  if (!isRecord(child)) {
    throw new Error(`Expected field ${field} to be an object`);
  }
  return child;
}

function firstRecordFromArray(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Expected ${label} to be a non-empty array`);
  }
  const first = value[0];
  if (!isRecord(first)) {
    throw new Error(`Expected first ${label} entry to be an object`);
  }
  return first;
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

function actionFramesSince(
  csms: CsmsHandle,
  cpId: string,
  action: string,
  sinceSeq: number,
): Frame[] {
  return csms.frames
    .byCp(cpId)
    .filter((frame) => frame.seq > sinceSeq && frame.action === action);
}

async function waitForActionFrames(
  csms: CsmsHandle,
  cpId: string,
  action: string,
  sinceSeq: number,
  count: number,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<Frame[]> {
  await waitUntil(
    () => actionFramesSince(csms, cpId, action, sinceSeq).length >= count,
    timeoutMs,
  );
  return actionFramesSince(csms, cpId, action, sinceSeq);
}

function transactionEventFramesSince(
  csms: CsmsHandle,
  cpId: string,
  sinceSeq: number,
): Frame[] {
  return actionFramesSince(csms, cpId, "TransactionEvent", sinceSeq).filter(
    (frame) =>
      isRecord(frame.payload) && typeof frame.payload.eventType === "string",
  );
}

async function waitForTransactionEventCount(
  csms: CsmsHandle,
  cpId: string,
  sinceSeq: number,
  count: number,
): Promise<Frame[]> {
  await waitUntil(
    () => transactionEventFramesSince(csms, cpId, sinceSeq).length >= count,
    WAIT_TIMEOUT_MS,
  );
  return transactionEventFramesSince(csms, cpId, sinceSeq);
}

function energyValueFromMeterValues(frame: Frame): number {
  const payload = payloadOf(frame);
  const firstMeterValue = firstRecordFromArray(
    payload.meterValue,
    "meterValue",
  );
  const sampledValues = firstMeterValue.sampledValue;
  if (!Array.isArray(sampledValues)) {
    throw new Error("Expected meterValue.sampledValue to be an array");
  }
  const energySample = sampledValues.find(
    (sample): sample is Record<string, unknown> =>
      isRecord(sample) &&
      (sample.measurand === "Energy.Active.Import.Register" ||
        sample.measurand === undefined),
  );
  if (!energySample) {
    throw new Error("Expected an energy sampledValue");
  }
  const value = energySample.value;
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error("Expected sampledValue.value to be numeric");
}

async function waitForStatusNotification(
  csms: CsmsHandle,
  cpId: string,
  connectorStatus: string,
  sinceSeq: number,
): Promise<Frame> {
  return waitForPayload(
    csms,
    cpId,
    "StatusNotification",
    (payload) =>
      payload.evseId === 1 &&
      payload.connectorId === 1 &&
      payload.connectorStatus === connectorStatus,
    sinceSeq,
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
    (payload) => payload.eventType === eventType,
    sinceSeq,
  );
}

async function waitForTransactionEnded(
  csms: CsmsHandle,
  cpId: string,
  transactionId: string,
  sinceSeq: number,
): Promise<Frame> {
  return waitForPayload(
    csms,
    cpId,
    "TransactionEvent",
    (payload) =>
      payload.eventType === "Ended" &&
      isRecord(payload.transactionInfo) &&
      payload.transactionInfo.transactionId === transactionId,
    sinceSeq,
  );
}

function transactionIdOf(frame: Frame): string {
  const transactionInfo = recordField(payloadOf(frame), "transactionInfo");
  const transactionId = transactionInfo.transactionId;
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

function assertCommandOk(response: CommandResponse): unknown {
  if (!response.ok) {
    throw new Error(response.error ?? "CSMS command failed");
  }
  return response.result;
}

function assertCommandResult(
  response: CommandResponse,
): Record<string, unknown> {
  const result = assertCommandOk(response);
  if (!isRecord(result)) {
    throw new Error("Expected CSMS command result to be an object");
  }
  return result;
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

async function assertRemoteSession16(
  csms: CsmsHandle,
  cpId: string,
  sinceSeq: number,
  startCommandSeq: number,
  stopCommandSeq: number,
): Promise<void> {
  const start = await waitForPayload(
    csms,
    cpId,
    "StartTransaction",
    (payload) => payload.idTag === REMOTE_TAG,
    sinceSeq,
  );
  const meter = await waitForPayload(
    csms,
    cpId,
    "MeterValues",
    (payload) =>
      payload.connectorId === 1 && typeof payload.transactionId === "number",
    start.seq,
  );
  const stop = await waitForPayload(
    csms,
    cpId,
    "StopTransaction",
    (payload) =>
      payload.transactionId === payloadOf(meter).transactionId &&
      payload.reason === "Remote",
    meter.seq,
  );

  expect(start.seq).toBeGreaterThan(startCommandSeq);
  expect(stop.seq).toBeGreaterThan(stopCommandSeq);
  expect(start.seq).toBeLessThan(meter.seq);
  expect(meter.seq).toBeLessThan(stop.seq);
  expect(payloadOf(start)).toMatchObject({
    connectorId: 1,
    idTag: REMOTE_TAG,
  });
  expect(payloadOf(stop)).toMatchObject({ reason: "Remote" });
}

async function assertRemoteSession2x(
  csms: CsmsHandle,
  cpId: string,
  sinceSeq: number,
  startCommandSeq: number,
  stopCommandSeq: number,
): Promise<void> {
  const started = await waitForTransactionEvent(
    csms,
    cpId,
    "Started",
    sinceSeq,
  );
  const transactionId = transactionIdOf(started);
  const meter = await waitForPayload(
    csms,
    cpId,
    "MeterValues",
    (payload) => payload.evseId === 1,
    started.seq,
  );
  const ended = await waitForTransactionEnded(
    csms,
    cpId,
    transactionId,
    meter.seq,
  );

  expect(started.seq).toBeGreaterThan(startCommandSeq);
  expect(ended.seq).toBeGreaterThan(stopCommandSeq);
  expect(started.seq).toBeLessThan(meter.seq);
  expect(meter.seq).toBeLessThan(ended.seq);
  expect(payloadOf(started)).toMatchObject({
    eventType: "Started",
    triggerReason: "RemoteStart",
    idToken: { idToken: REMOTE_TAG, type: "ISO14443" },
    transactionInfo: { remoteStartId: expect.any(Number) },
    evse: { id: 1, connectorId: 1 },
  });
  expect(payloadOf(ended)).toMatchObject({
    eventType: "Ended",
    triggerReason: "RemoteStop",
    idToken: { idToken: REMOTE_TAG, type: "ISO14443" },
    transactionInfo: { transactionId, stoppedReason: "Remote" },
  });
}

function assertNoTransactionStartBefore(
  csms: CsmsHandle,
  cpId: string,
  version: OcppVersion,
  sinceSeq: number,
  commandSeq: number,
): void {
  const starts = csms.frames.byCp(cpId).filter((frame) => {
    if (frame.seq <= sinceSeq || frame.seq > commandSeq) return false;
    if (version === "OCPP-1.6J") return frame.action === "StartTransaction";
    return (
      frame.action === "TransactionEvent" &&
      isRecord(frame.payload) &&
      frame.payload.eventType === "Started"
    );
  });
  expect(starts).toHaveLength(0);
}

function assertNoTransactionStopBefore(
  csms: CsmsHandle,
  cpId: string,
  version: OcppVersion,
  sinceSeq: number,
  commandSeq: number,
): void {
  const stops = csms.frames.byCp(cpId).filter((frame) => {
    if (frame.seq <= sinceSeq || frame.seq > commandSeq) return false;
    if (version === "OCPP-1.6J") return frame.action === "StopTransaction";
    return (
      frame.action === "TransactionEvent" &&
      isRecord(frame.payload) &&
      frame.payload.eventType === "Ended"
    );
  });
  expect(stops).toHaveLength(0);
}
