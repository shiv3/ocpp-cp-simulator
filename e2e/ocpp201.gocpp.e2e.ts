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

const OCPP_VERSION = "OCPP-2.0.1";
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
    {},
  );
  cp.logger.setEnabledTypes();
  cp.events.on("error", () => undefined);
  return cp;
}

async function connectBootReady(
  cp: ChargePoint,
  cpId: string,
  sinceSeq?: number,
): Promise<{ boot: Frame; available: Frame }> {
  await cp.connect();
  return waitForBootReady(cp, cpId, sinceSeq);
}

async function waitForBootReady(
  cp: ChargePoint,
  cpId: string,
  sinceSeq?: number,
): Promise<{ boot: Frame; available: Frame }> {
  const boot = await csms.frames.waitForCall("BootNotification", {
    cpId,
    sinceSeq,
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

async function waitForChargingStateUpdated(
  cpId: string,
  transactionId: string,
  chargingState: string,
  sinceSeq: number,
): Promise<Frame> {
  return waitForPayload(
    cpId,
    "TransactionEvent",
    (payload) =>
      payload.eventType === "Updated" &&
      payload.triggerReason === "ChargingStateChanged" &&
      isRecord(payload.transactionInfo) &&
      payload.transactionInfo.transactionId === transactionId &&
      payload.transactionInfo.chargingState === chargingState,
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
    const cpId = "cp201-boot";
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
  "StatusNotification records the requested connector status",
  async () => {
    const cpId = "cp201-status";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);
      const sinceSeq = lastSeq(cpId);

      cp.updateConnectorStatus(1, OCPPStatus.Charging);
      const status = await waitForStatusNotification(
        cpId,
        "Occupied",
        sinceSeq,
      );

      expect(payloadOf(status)).toMatchObject({
        evseId: 1,
        connectorId: 1,
        connectorStatus: "Occupied",
      });
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "Authorize records the idToken sent by the charge point",
  async () => {
    const cpId = "cp201-authorize";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);
      const sinceSeq = lastSeq(cpId);

      cp.authorize("TAG-OK");
      const authorize = await waitForPayload(
        cpId,
        "Authorize",
        (payload) =>
          isRecord(payload.idToken) &&
          payload.idToken.idToken === "TAG-OK" &&
          payload.idToken.type === "ISO14443",
        sinceSeq,
      );

      expect(payloadOf(authorize)).toMatchObject({
        idToken: { idToken: "TAG-OK", type: "ISO14443" },
      });
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "CP transaction records Started, MeterValues, and Ended without Updated",
  async () => {
    const cpId = "cp201-tx";
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

      const relevantFrames = csms.frames
        .byCp(cpId)
        .filter(
          (frame) =>
            frame.seq > sinceSeq &&
            (frame.action === "TransactionEvent" ||
              frame.action === "MeterValues"),
        );
      expect(
        relevantFrames.map((frame) =>
          frame.action === "TransactionEvent"
            ? `TransactionEvent:${payloadOf(frame).eventType}`
            : "MeterValues",
        ),
      ).toEqual([
        "TransactionEvent:Started",
        "MeterValues",
        "TransactionEvent:Ended",
      ]);
      expect(started.seq).toBeLessThan(meter.seq);
      expect(meter.seq).toBeLessThan(ended.seq);
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "CP transaction records chargingState Updated on active suspend and resume",
  async () => {
    const cpId = "cp201-tx-charging-state";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);
      const sinceSeq = lastSeq(cpId);

      cp.startTransaction("TAG-OK", 1);
      const started = await waitForTransactionEvent(cpId, "Started", sinceSeq);
      const transactionId = transactionIdOf(started);

      cp.updateConnectorStatus(1, OCPPStatus.SuspendedEVSE);
      const suspended = await waitForChargingStateUpdated(
        cpId,
        transactionId,
        "SuspendedEVSE",
        started.seq,
      );

      cp.updateConnectorStatus(1, OCPPStatus.Charging);
      const resumed = await waitForChargingStateUpdated(
        cpId,
        transactionId,
        "Charging",
        suspended.seq,
      );

      cp.stopTransaction(1);
      const ended = await waitForPayload(
        cpId,
        "TransactionEvent",
        (payload) =>
          payload.eventType === "Ended" &&
          isRecord(payload.transactionInfo) &&
          payload.transactionInfo.transactionId === transactionId,
        resumed.seq,
      );

      expect(payloadOf(started)).toMatchObject({
        eventType: "Started",
        transactionInfo: { transactionId, chargingState: "Charging" },
      });
      expect(payloadOf(suspended)).toMatchObject({
        eventType: "Updated",
        triggerReason: "ChargingStateChanged",
        transactionInfo: { transactionId, chargingState: "SuspendedEVSE" },
      });
      expect(payloadOf(resumed)).toMatchObject({
        eventType: "Updated",
        triggerReason: "ChargingStateChanged",
        transactionInfo: { transactionId, chargingState: "Charging" },
      });
      expect(payloadOf(ended)).toMatchObject({
        eventType: "Ended",
        transactionInfo: { transactionId },
      });

      const payloads = [started, suspended, resumed, ended].map(payloadOf);
      expect(payloads.map((payload) => payload.seqNo)).toEqual([0, 1, 2, 3]);

      const relevantFrames = csms.frames
        .byCp(cpId)
        .filter(
          (frame) =>
            frame.seq > sinceSeq && frame.action === "TransactionEvent",
        );
      expect(
        relevantFrames.map((frame) => {
          const payload = payloadOf(frame);
          const transactionInfo = recordField(payload, "transactionInfo");
          return transactionInfo.chargingState
            ? `TransactionEvent:${payload.eventType}:${transactionInfo.chargingState}`
            : `TransactionEvent:${payload.eventType}`;
        }),
      ).toEqual([
        "TransactionEvent:Started:Charging",
        "TransactionEvent:Updated:SuspendedEVSE",
        "TransactionEvent:Updated:Charging",
        "TransactionEvent:Ended",
      ]);
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "CSMS RequestStartTransaction starts a transaction with the requested idToken",
  async () => {
    const cpId = "cp201-request-start";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);
      const sinceSeq = lastSeq(cpId);

      const result = assertCommandResult(
        await csms.command({
          cpId,
          action: "RequestStartTransaction",
          idToken: { idToken: "REMOTE-TAG", type: "ISO14443" },
          evseId: 1,
        }),
      );
      const started = await waitForTransactionEvent(cpId, "Started", sinceSeq);

      expect(result).toMatchObject({ status: "Accepted" });
      expect(payloadOf(started)).toMatchObject({
        eventType: "Started",
        triggerReason: "RemoteStart",
        idToken: { idToken: "REMOTE-TAG", type: "ISO14443" },
        transactionInfo: { remoteStartId: expect.any(Number) },
        evse: { id: 1, connectorId: 1 },
      });
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "CSMS RequestStopTransaction stops the recorded transaction id",
  async () => {
    const cpId = "cp201-request-stop";
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

      expect(result).toMatchObject({ status: "Accepted" });
      expect(payloadOf(ended)).toMatchObject({
        eventType: "Ended",
        triggerReason: "RemoteStop",
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
  "GetVariables returns the mapped HeartbeatInterval value",
  async () => {
    const cpId = "cp201-get-variables";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);

      const result = assertCommandResult(
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
        result.getVariableResult,
        "getVariableResult",
      );

      expect(first).toMatchObject({
        attributeStatus: "Accepted",
        component: { name: "OCPPCommCtrlr" },
        variable: { name: "HeartbeatInterval" },
      });
      expect(typeof first.attributeValue).toBe("string");
      expect(first.attributeValue).not.toBe("");
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "SetVariables accepts the mapped HeartbeatInterval value",
  async () => {
    const cpId = "cp201-set-variables";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);

      const result = assertCommandResult(
        await csms.command({
          cpId,
          action: "SetVariables",
          setVariableData: [
            {
              component: { name: "OCPPCommCtrlr" },
              variable: { name: "HeartbeatInterval" },
              attributeValue: "120",
            },
          ],
        }),
      );
      const first = firstRecordFromArray(
        result.setVariableResult,
        "setVariableResult",
      );

      expect(first).toMatchObject({
        attributeStatus: "Accepted",
        component: { name: "OCPPCommCtrlr" },
        variable: { name: "HeartbeatInterval" },
      });
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "GetBaseReport returns Accepted and emits NotifyReport",
  async () => {
    const cpId = "cp201-get-base-report";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);
      const sinceSeq = lastSeq(cpId);

      const result = assertCommandResult(
        await csms.command({
          cpId,
          action: "GetBaseReport",
          requestId: 4242,
          reportBase: "FullInventory",
        }),
      );
      const report = await waitForPayload(
        cpId,
        "NotifyReport",
        (payload) => payload.requestId === 4242,
        sinceSeq,
      );

      expect(result).toMatchObject({ status: "Accepted" });
      expect(payloadOf(report)).toMatchObject({
        requestId: 4242,
        seqNo: 0,
      });
      expect(
        Array.isArray(payloadOf(report).reportData) &&
          payloadOf(report).reportData.length > 0,
      ).toBe(true);
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "Reset OnIdle reboots on the same connection",
  async () => {
    const cpId = "cp201-reset";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);
      const sinceSeq = lastSeq(cpId);

      const result = assertCommandResult(
        await csms.command({
          cpId,
          action: "Reset",
          type: "OnIdle",
        }),
      );
      const { boot: secondBoot } = await waitForBootReady(cp, cpId, sinceSeq);

      expect(result).toMatchObject({ status: "Accepted" });
      expect(secondBoot.seq).toBeGreaterThan(sinceSeq);
      expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Available);
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "ChangeAvailability Inoperative records connector Unavailable while idle",
  async () => {
    const cpId = "cp201-change-availability";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);
      const sinceSeq = lastSeq(cpId);

      const result = assertCommandResult(
        await csms.command({
          cpId,
          action: "ChangeAvailability",
          evse: { id: 1 },
          operationalStatus: "Inoperative",
        }),
      );
      const unavailable = await waitForStatusNotification(
        cpId,
        "Unavailable",
        sinceSeq,
      );

      expect(result).toMatchObject({ status: "Accepted" });
      expect(payloadOf(unavailable)).toMatchObject({
        evseId: 1,
        connectorId: 1,
        connectorStatus: "Unavailable",
      });
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "TriggerMessage StatusNotification records a follow-up StatusNotification",
  async () => {
    const cpId = "cp201-trigger-message";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);
      const sinceSeq = lastSeq(cpId);

      const result = assertCommandResult(
        await csms.command({
          cpId,
          action: "TriggerMessage",
          requestedMessage: "StatusNotification",
        }),
      );
      const status = await waitForStatusNotification(
        cpId,
        "Available",
        sinceSeq,
      );

      expect(result).toMatchObject({ status: "Accepted" });
      expect(payloadOf(status)).toMatchObject({
        evseId: 1,
        connectorId: 1,
        connectorStatus: "Available",
      });
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "UnlockConnector returns the idle connector status",
  async () => {
    const cpId = "cp201-unlock";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);

      const result = assertCommandResult(
        await csms.command({
          cpId,
          action: "UnlockConnector",
          evseId: 1,
          connectorId: 1,
        }),
      );

      expect(result).toMatchObject({ status: "Unlocked" });
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "ReserveNow accepts the reservation and records connector Reserved",
  async () => {
    const cpId = "cp201-reserve";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);
      const sinceSeq = lastSeq(cpId);

      const result = assertCommandResult(
        await csms.command({
          cpId,
          action: "ReserveNow",
          id: 9,
          expiryDateTime: new Date(Date.now() + 60_000).toISOString(),
          idToken: { idToken: "RES-TAG", type: "ISO14443" },
          evseId: 1,
        }),
      );
      const reserved = await waitForStatusNotification(
        cpId,
        "Reserved",
        sinceSeq,
      );

      expect(result).toMatchObject({ status: "Accepted" });
      expect(payloadOf(reserved)).toMatchObject({
        evseId: 1,
        connectorId: 1,
        connectorStatus: "Reserved",
      });
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);
