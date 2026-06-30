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

const OCPP_VERSION = "OCPP-1.6J";
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
  // Keep e2e output focused on assertions; wire evidence comes from FrameLog.
  cp.logger.setEnabledTypes();
  cp.events.on("error", () => undefined);
  return cp;
}

async function connectBootReady(
  cp: ChargePoint,
  cpId: string,
  sinceSeq?: number,
): Promise<Frame> {
  await cp.connect();
  return waitForBootReady(cp, cpId, sinceSeq);
}

async function waitForBootReady(
  cp: ChargePoint,
  cpId: string,
  sinceSeq?: number,
): Promise<Frame> {
  const boot = await csms.frames.waitForCall("BootNotification", {
    cpId,
    sinceSeq,
    timeoutMs: WAIT_TIMEOUT_MS,
  });
  await waitForConnectorStatus(cp, 1, OCPPStatus.Available);
  return boot;
}

async function waitForConnectorStatus(
  cp: ChargePoint,
  connectorId: number,
  status: OCPPStatus,
): Promise<void> {
  await waitUntil(() => cp.getConnector(connectorId)?.status === status);
}

async function waitForTransactionId(
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

function assertCommandOk(response: CommandResponse): unknown {
  if (!response.ok) {
    throw new Error(response.error ?? "CSMS command failed");
  }
  return response.result;
}

test(
  "boot handshake records BootNotification and makes connector Available",
  async () => {
    const cpId = "cp16-boot";
    const cp = makeChargePoint(cpId);

    try {
      const boot = await connectBootReady(cp, cpId);
      const payload = payloadOf(boot);
      expect(payload.chargePointVendor).toBe(
        DefaultBootNotification.chargePointVendor,
      );
      expect(payload.chargePointModel).toBe(
        DefaultBootNotification.chargePointModel,
      );
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
    const cpId = "cp16-status";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);
      const sinceSeq = lastSeq(cpId);

      cp.updateConnectorStatus(1, OCPPStatus.Charging);
      const status = await waitForPayload(
        cpId,
        "StatusNotification",
        (payload) =>
          payload.connectorId === 1 && payload.status === OCPPStatus.Charging,
        sinceSeq,
      );

      expect(payloadOf(status)).toMatchObject({
        connectorId: 1,
        status: OCPPStatus.Charging,
      });
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "Authorize records the idTag sent by the charge point",
  async () => {
    const cpId = "cp16-authorize";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);
      const sinceSeq = lastSeq(cpId);

      cp.authorize("TAG-OK");
      const authorize = await waitForPayload(
        cpId,
        "Authorize",
        (payload) => payload.idTag === "TAG-OK",
        sinceSeq,
      );

      expect(payloadOf(authorize).idTag).toBe("TAG-OK");
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "CP transaction records StartTransaction, MeterValues, and StopTransaction in order",
  async () => {
    const cpId = "cp16-tx";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);
      const sinceSeq = lastSeq(cpId);

      cp.startTransaction("TAG-OK", 1);
      const start = await waitForPayload(
        cpId,
        "StartTransaction",
        (payload) => payload.idTag === "TAG-OK",
        sinceSeq,
      );

      cp.sendMeterValue(1);
      const meter = await waitForPayload(
        cpId,
        "MeterValues",
        (payload) =>
          payload.connectorId === 1 &&
          typeof payload.transactionId === "number",
        start.seq,
      );

      cp.stopTransaction(1);
      const stop = await waitForPayload(
        cpId,
        "StopTransaction",
        (payload) => typeof payload.transactionId === "number",
        meter.seq,
      );

      expect(payloadOf(start)).toMatchObject({
        connectorId: 1,
        idTag: "TAG-OK",
        meterStart: 0,
      });
      expect(payloadOf(meter).transactionId).toBe(
        payloadOf(stop).transactionId,
      );
      expect(start.seq).toBeLessThan(meter.seq);
      expect(meter.seq).toBeLessThan(stop.seq);
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "CSMS RemoteStartTransaction starts a transaction with the requested idTag",
  async () => {
    const cpId = "cp16-remote-start";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);
      const sinceSeq = lastSeq(cpId);

      assertCommandOk(
        await csms.command({
          cpId,
          action: "RemoteStartTransaction",
          idTag: "REMOTE-TAG",
          connectorId: 1,
        }),
      );
      const start = await waitForPayload(
        cpId,
        "StartTransaction",
        (payload) => payload.idTag === "REMOTE-TAG",
        sinceSeq,
      );

      expect(payloadOf(start)).toMatchObject({
        connectorId: 1,
        idTag: "REMOTE-TAG",
      });
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "CSMS RemoteStopTransaction stops the CSMS-assigned transaction id",
  async () => {
    const cpId = "cp16-remote-stop";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);
      const sinceSeq = lastSeq(cpId);

      cp.startTransaction("TAG-OK", 1);
      const start = await waitForPayload(
        cpId,
        "StartTransaction",
        (payload) => payload.idTag === "TAG-OK",
        sinceSeq,
      );
      const transactionId = await waitForTransactionId(cp, 1);

      assertCommandOk(
        await csms.command({
          cpId,
          action: "RemoteStopTransaction",
          transactionId,
        }),
      );
      const stop = await waitForPayload(
        cpId,
        "StopTransaction",
        (payload) => payload.transactionId === transactionId,
        start.seq,
      );

      expect(payloadOf(stop).transactionId).toBe(transactionId);
      expect(start.seq).toBeLessThan(stop.seq);
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "Heartbeat records a one-shot Heartbeat call",
  async () => {
    const cpId = "cp16-heartbeat";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);
      const sinceSeq = lastSeq(cpId);

      cp.sendHeartbeat();
      const heartbeat = await csms.frames.waitForCall("Heartbeat", {
        cpId,
        sinceSeq,
        timeoutMs: WAIT_TIMEOUT_MS,
      });

      expect(payloadOf(heartbeat)).toEqual({});
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "DataTransfer records vendorId and receives the Accepted response without CP error",
  async () => {
    const cpId = "cp16-data-transfer";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);
      const sinceSeq = lastSeq(cpId);

      cp.sendDataTransfer("VendorX", "MessageA", '{"ok":true}');
      const transfer = await waitForPayload(
        cpId,
        "DataTransfer",
        (payload) => payload.vendorId === "VendorX",
        sinceSeq,
      );

      expect(payloadOf(transfer)).toMatchObject({
        vendorId: "VendorX",
        messageId: "MessageA",
        data: '{"ok":true}',
      });
      await waitUntil(() => cp.error === "");
      expect(cp.error).toBe("");
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "Reset Hard disconnects and reconnects the same charge point",
  async () => {
    const cpId = "cp16-reset";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);
      const sinceSeq = lastSeq(cpId);

      const resetResult = assertCommandOk(
        await csms.command({
          cpId,
          action: "Reset",
          type: "Hard",
        }),
      );
      expect(resetResult).toMatchObject({ status: "Accepted" });

      const secondBoot = await waitForBootReady(cp, cpId, sinceSeq);

      expect(secondBoot.seq).toBeGreaterThan(sinceSeq);
      expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Available);
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "ReserveNow and CancelReservation return accepted command results",
  async () => {
    const cpId = "cp16-reserve";
    const cp = makeChargePoint(cpId);

    try {
      await connectBootReady(cp, cpId);

      const reserveResult = assertCommandOk(
        await csms.command({
          cpId,
          action: "ReserveNow",
          connectorId: 1,
          idTag: "RES-TAG",
          reservationId: 7,
          expiryDate: new Date(Date.now() + 60_000).toISOString(),
        }),
      );
      expect(reserveResult).toMatchObject({ status: "Accepted" });

      const cancelResult = assertCommandOk(
        await csms.command({
          cpId,
          action: "CancelReservation",
          reservationId: 7,
        }),
      );
      expect(cancelResult).toMatchObject({ status: "Accepted" });
    } finally {
      await cp.disconnect();
    }
  },
  TEST_TIMEOUT_MS,
);
