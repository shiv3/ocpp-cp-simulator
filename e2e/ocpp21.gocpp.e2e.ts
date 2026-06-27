import { afterAll, beforeAll, expect, test } from "bun:test";
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

const OCPP_VERSION = "OCPP-2.1";
const WAIT_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 30_000;

let csms: CsmsHandle;

beforeAll(async () => {
  csms = await startCsms(OCPP_VERSION);
});

afterAll(async () => {
  await stopAllCsms();
});

function makeChargePoint(cpId: string): ChargePoint {
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
    OCPP_VERSION,
  );
  cp.logger.setEnabledTypes();
  cp.events.on("error", () => undefined);
  return cp;
}

async function connectBootReady(
  cp: ChargePoint,
  cpId: string,
): Promise<{ boot: Frame; available: Frame }> {
  await cp.connect();
  const boot = await csms.frames.waitForCall("BootNotification", {
    cpId,
    timeoutMs: WAIT_TIMEOUT_MS,
  });
  const available = await waitForStatusNotification(
    cpId,
    "Available",
    boot.seq,
  );
  await waitForConnectorStatus(cp, 1, OCPPStatus.Available);
  return { boot, available };
}

async function waitForConnectorStatus(
  cp: ChargePoint,
  connectorId: number,
  status: OCPPStatus,
): Promise<void> {
  await waitUntil(() => cp.getConnector(connectorId)?.status === status);
}

async function waitUntil(
  pred: () => boolean,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (pred()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function lastSeq(cpId: string): number {
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

async function waitForPayload(
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

async function waitForStatusNotification(
  cpId: string,
  connectorStatus: string,
  sinceSeq: number,
): Promise<Frame> {
  return waitForPayload(
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
  cpId: string,
  eventType: string,
  sinceSeq: number,
): Promise<Frame> {
  return waitForPayload(
    cpId,
    "TransactionEvent",
    (payload) => payload.eventType === eventType,
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

test(
  "boot handshake records BootNotification and connector Available",
  async () => {
    const cpId = "cp21-boot";
    const cp = makeChargePoint(cpId);

    try {
      const { boot, available } = await connectBootReady(cp, cpId);
      const payload = payloadOf(boot);

      expect(payload).toMatchObject({
        chargingStation: {
          vendorName: DefaultBootNotification.chargePointVendor,
          model: DefaultBootNotification.chargePointModel,
        },
      });
      expect(payloadOf(available)).toMatchObject({
        evseId: 1,
        connectorId: 1,
        connectorStatus: "Available",
      });
      expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Available);
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "CP transaction records Started, MeterValues, and Ended",
  async () => {
    const cpId = "cp21-tx";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);
      const sinceSeq = lastSeq(cpId);

      cp.startTransaction("TAG-OK", 1);
      const started = await waitForTransactionEvent(cpId, "Started", sinceSeq);
      const transactionId = transactionIdOf(started);

      cp.sendMeterValue(1);
      const meter = await waitForPayload(
        cpId,
        "MeterValues",
        (payload) => payload.evseId === 1,
        started.seq,
      );

      cp.stopTransaction(1);
      const ended = await waitForPayload(
        cpId,
        "TransactionEvent",
        (payload) =>
          payload.eventType === "Ended" &&
          isRecord(payload.transactionInfo) &&
          payload.transactionInfo.transactionId === transactionId,
        meter.seq,
      );

      expect(payloadOf(started)).toMatchObject({
        eventType: "Started",
        idToken: { idToken: "TAG-OK", type: "ISO14443" },
        evse: { id: 1, connectorId: 1 },
      });
      expect(payloadOf(meter)).toMatchObject({ evseId: 1 });
      expect(payloadOf(ended)).toMatchObject({
        eventType: "Ended",
        transactionInfo: { transactionId },
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
  "CSMS RequestStartTransaction and RequestStopTransaction control the transaction",
  async () => {
    const cpId = "cp21-request-start-stop";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);
      const sinceSeq = lastSeq(cpId);

      const startResult = assertCommandResult(
        await csms.command({
          cpId,
          action: "RequestStartTransaction",
          idToken: { idToken: "REMOTE-TAG", type: "ISO14443" },
          evseId: 1,
        }),
      );
      const started = await waitForTransactionEvent(cpId, "Started", sinceSeq);
      const transactionId = transactionIdOf(started);

      const stopResult = assertCommandResult(
        await csms.command({
          cpId,
          action: "RequestStopTransaction",
          transactionId,
        }),
      );
      const ended = await waitForPayload(
        cpId,
        "TransactionEvent",
        (payload) =>
          payload.eventType === "Ended" &&
          isRecord(payload.transactionInfo) &&
          payload.transactionInfo.transactionId === transactionId,
        started.seq,
      );

      expect(startResult).toMatchObject({ status: "Accepted" });
      expect(payloadOf(started)).toMatchObject({
        eventType: "Started",
        idToken: { idToken: "REMOTE-TAG", type: "ISO14443" },
        evse: { id: 1, connectorId: 1 },
      });
      expect(stopResult).toMatchObject({ status: "Accepted" });
      expect(payloadOf(ended)).toMatchObject({
        eventType: "Ended",
        transactionInfo: { transactionId, stoppedReason: "Remote" },
      });
      expect(started.seq).toBeLessThan(ended.seq);
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "UsePriorityCharging returns NoProfile for the recorded transaction id",
  async () => {
    const cpId = "cp21-use-priority-charging";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);
      const sinceSeq = lastSeq(cpId);

      cp.startTransaction("TAG-OK", 1);
      const started = await waitForTransactionEvent(cpId, "Started", sinceSeq);
      const transactionId = transactionIdOf(started);

      const result = assertCommandResult(
        await csms.command({
          cpId,
          action: "UsePriorityCharging",
          transactionId,
          activate: true,
        }),
      );

      expect(payloadOf(started)).toMatchObject({
        eventType: "Started",
        transactionInfo: { transactionId },
      });
      expect(result).toMatchObject({ status: "NoProfile" });
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);
