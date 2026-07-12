import { describe, expect, it } from "bun:test";
import type {
  CancelReservationRequestV201,
  ReserveNowRequestV201,
  TransactionEventRequestV201,
} from "../../../../ocpp";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";

function callResultFrame(messageId: string): (frame: OcppFrame) => boolean {
  return (frame) => frame[0] === 3 && frame[1] === messageId;
}

function statusNotificationFrame(
  evseId: number,
  connectorStatus: "Available" | "Reserved",
): (frame: OcppFrame) => boolean {
  return (frame) =>
    frame[0] === 2 &&
    frame[2] === "StatusNotification" &&
    (frame[3] as { evseId?: number }).evseId === evseId &&
    (frame[3] as { connectorStatus?: string }).connectorStatus ===
      connectorStatus;
}

function statusNotificationFrameAfter(
  csms: MockCsms,
  afterIndex: number,
  evseId: number,
  connectorStatus: "Available" | "Reserved",
): (frame: OcppFrame) => boolean {
  const matches = statusNotificationFrame(evseId, connectorStatus);
  return (frame) => matches(frame) && csms.received.indexOf(frame) > afterIndex;
}

function anyStatusNotificationAfter(
  csms: MockCsms,
  afterIndex: number,
): (frame: OcppFrame) => boolean {
  return (frame) =>
    csms.received.indexOf(frame) > afterIndex &&
    frame[0] === 2 &&
    frame[2] === "StatusNotification";
}

function transactionEventFrame(
  eventType: TransactionEventRequestV201["eventType"],
): (frame: OcppFrame) => boolean {
  return (frame) =>
    frame[0] === 2 &&
    frame[2] === "TransactionEvent" &&
    (frame[3] as { eventType?: string }).eventType === eventType;
}

async function expectNoFrame(
  csms: MockCsms,
  pred: (frame: OcppFrame) => boolean,
): Promise<void> {
  try {
    const frame = await csms.waitForFrame(pred, 150);
    throw new Error(`Unexpected frame: ${JSON.stringify(frame)}`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Timed out waiting for frame"
    ) {
      return;
    }
    throw error;
  }
}

async function bootAccepted(csms: MockCsms): Promise<void> {
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-06-24T00:00:00.000Z",
    interval: 300,
  });

  await csms.waitForFrame(statusNotificationFrame(1, "Available"));
}

function newChargePoint(id: string): {
  csms: MockCsms;
  cp: ChargePoint;
} {
  const csms = startMockCsms();
  const cp = new ChargePoint(
    id,
    DefaultBootNotification,
    1,
    csms.url,
    null,
    null,
    null,
    {},
    [],
    "OCPP-2.0.1",
    {},
  );
  cp.events.on("error", () => undefined);
  // This suite exercises Reservation semantics, not the #181 local-
  // authorize gate — disable it so the setup `startTransaction()` calls
  // below don't wait on an Authorize.conf the mock CSMS never answers.
  cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
  return { csms, cp };
}

function sendReserveNow(
  csms: MockCsms,
  messageId: string,
  payload: ReserveNowRequestV201,
): Promise<OcppFrame> {
  csms.send([2, messageId, "ReserveNow", payload]);
  return csms.waitForFrame(callResultFrame(messageId));
}

function sendCancelReservation(
  csms: MockCsms,
  messageId: string,
  payload: CancelReservationRequestV201,
): Promise<OcppFrame> {
  csms.send([2, messageId, "CancelReservation", payload]);
  return csms.waitForFrame(callResultFrame(messageId));
}

describe("OCPP 2.0.1 reservations", () => {
  it("creates and cancels reservations through the reservation manager", async () => {
    const { csms, cp } = newChargePoint("CP201-RESERVATION");

    try {
      cp.connect();
      await bootAccepted(csms);

      const reserveResult = await sendReserveNow(csms, "reserve-7", {
        id: 7,
        evseId: 1,
        expiryDateTime: "2030-01-01T00:00:00Z",
        idToken: { idToken: "TAG", type: "ISO14443" },
      });
      expect(reserveResult).toEqual([3, "reserve-7", { status: "Accepted" }]);

      const reserved = await csms.waitForFrame(
        statusNotificationFrameAfter(
          csms,
          csms.received.indexOf(reserveResult),
          1,
          "Reserved",
        ),
      );
      expect(reserved[3]).toMatchObject({
        evseId: 1,
        connectorId: 1,
        connectorStatus: "Reserved",
      });
      expect(csms.received.indexOf(reserved)).toBeGreaterThan(
        csms.received.indexOf(reserveResult),
      );

      const cancelResult = await sendCancelReservation(csms, "cancel-7", {
        reservationId: 7,
      });
      expect(cancelResult).toEqual([3, "cancel-7", { status: "Accepted" }]);

      const available = await csms.waitForFrame(
        statusNotificationFrameAfter(
          csms,
          csms.received.indexOf(cancelResult),
          1,
          "Available",
        ),
      );
      expect(available[3]).toMatchObject({
        evseId: 1,
        connectorId: 1,
        connectorStatus: "Available",
      });
      expect(csms.received.indexOf(available)).toBeGreaterThan(
        csms.received.indexOf(cancelResult),
      );

      const unknownCancelResult = await sendCancelReservation(
        csms,
        "cancel-999",
        { reservationId: 999 },
      );
      expect(unknownCancelResult).toEqual([
        3,
        "cancel-999",
        { status: "Rejected" },
      ]);
      await expectNoFrame(
        csms,
        anyStatusNotificationAfter(
          csms,
          csms.received.indexOf(unknownCancelResult),
        ),
      );
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("rejects ReserveNow as occupied during an active transaction", async () => {
    const { csms, cp } = newChargePoint("CP201-RESERVATION-ACTIVE");

    try {
      cp.connect();
      await bootAccepted(csms);

      cp.startTransaction("TAG-201", 1);
      await csms.waitForFrame(transactionEventFrame("Started"));

      const reserveResult = await sendReserveNow(csms, "reserve-8", {
        id: 8,
        evseId: 1,
        expiryDateTime: "2030-01-01T00:00:00Z",
        idToken: { idToken: "TAG", type: "ISO14443" },
      });
      expect(reserveResult).toEqual([3, "reserve-8", { status: "Occupied" }]);
      await expectNoFrame(
        csms,
        anyStatusNotificationAfter(csms, csms.received.indexOf(reserveResult)),
      );
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("includes reservationId on TransactionEvent when a reservation is consumed", async () => {
    const { csms, cp } = newChargePoint("CP201-RESERVATION-TX");

    try {
      cp.connect();
      await bootAccepted(csms);

      const reserveResult = await sendReserveNow(csms, "reserve-tx-7", {
        id: 7,
        evseId: 1,
        expiryDateTime: "2030-01-01T00:00:00Z",
        idToken: { idToken: "TAG", type: "ISO14443" },
      });
      expect(reserveResult).toEqual([
        3,
        "reserve-tx-7",
        { status: "Accepted" },
      ]);

      const reserved = await csms.waitForFrame(
        statusNotificationFrameAfter(
          csms,
          csms.received.indexOf(reserveResult),
          1,
          "Reserved",
        ),
      );

      cp.startTransaction("TAG", 1);
      const startedFrame = await csms.waitForFrame(
        transactionEventFrame("Started"),
      );
      const started = startedFrame[3] as TransactionEventRequestV201;

      expect(csms.received.indexOf(startedFrame)).toBeGreaterThan(
        csms.received.indexOf(reserved),
      );
      expect(started.reservationId).toBe(7);
      expect(started.transactionInfo.remoteStartId).toBeUndefined();
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
