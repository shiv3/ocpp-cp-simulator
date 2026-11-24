import { describe, it, expect } from "bun:test";
import type { ChangeAvailabilityRequestV201 } from "@ocpp-cp-simulator/ocpp";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import { createChargePoint } from "../../charge-point/createChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

function callResultFrame(messageId: string): (frame: OcppFrame) => boolean {
  return (frame) => frame[0] === 3 && frame[1] === messageId;
}

function statusNotificationFrame(
  evseId: number,
  connectorStatus: "Available" | "Unavailable",
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
  connectorStatus: "Available" | "Unavailable",
): (frame: OcppFrame) => boolean {
  const matches = statusNotificationFrame(evseId, connectorStatus);
  return (frame) => matches(frame) && csms.received.indexOf(frame) > afterIndex;
}

async function bootAccepted(csms: MockCsms): Promise<void> {
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-06-24T00:00:00.000Z",
    interval: 300,
  });

  for (const evseId of [1, 2]) {
    await csms.waitForFrame(statusNotificationFrame(evseId, "Available"));
  }
}

describe("OCPP 2.0.1 ChangeAvailability", () => {
  it("applies CP-wide and single-connector availability after the CALLRESULT", async () => {
    const csms = startMockCsms();
    const cp = createChargePoint(
      "CP201-CHANGE-AVAILABILITY",
      DefaultBootNotification,
      2,
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

    try {
      cp.connect();
      await bootAccepted(csms);

      const cpWideUnavailable = {
        operationalStatus: "Inoperative",
      } satisfies ChangeAvailabilityRequestV201;
      csms.send([
        2,
        "change-availability-all",
        "ChangeAvailability",
        cpWideUnavailable,
      ]);

      const cpWideResult = await csms.waitForFrame(
        callResultFrame("change-availability-all"),
      );
      expect(cpWideResult).toEqual([
        3,
        "change-availability-all",
        { status: "Accepted" },
      ]);

      const unavailable1 = await csms.waitForFrame(
        statusNotificationFrame(1, "Unavailable"),
      );
      const unavailable2 = await csms.waitForFrame(
        statusNotificationFrame(2, "Unavailable"),
      );

      for (const frame of [unavailable1, unavailable2]) {
        expect(frame[3]).toMatchObject({
          connectorId: 1,
          connectorStatus: "Unavailable",
        });
      }

      const cpWideResultIndex = csms.received.indexOf(cpWideResult);
      for (const frame of [unavailable1, unavailable2]) {
        expect(csms.received.indexOf(frame)).toBeGreaterThan(cpWideResultIndex);
      }

      const connectorAvailable = {
        operationalStatus: "Operative",
        evse: { id: 1 },
      } satisfies ChangeAvailabilityRequestV201;
      csms.send([
        2,
        "change-availability-1",
        "ChangeAvailability",
        connectorAvailable,
      ]);

      const connectorResult = await csms.waitForFrame(
        callResultFrame("change-availability-1"),
      );
      expect(connectorResult).toEqual([
        3,
        "change-availability-1",
        { status: "Accepted" },
      ]);

      const available1 = await csms.waitForFrame(
        statusNotificationFrameAfter(
          csms,
          csms.received.indexOf(connectorResult),
          1,
          "Available",
        ),
      );
      expect(available1[3]).toMatchObject({
        evseId: 1,
        connectorId: 1,
        connectorStatus: "Available",
      });
      expect(csms.received.indexOf(available1)).toBeGreaterThan(
        csms.received.indexOf(connectorResult),
      );
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});

// OCPP 2.0.1 Ed4 Part 2 G03 (2.1 likewise): `evse.id` + `evse.connectorId`
// addresses one connector of an EVSE (TC_G_15..TC_G_17_CS, TC_G_19_CS; a CSMS
// sends it in TC_G_07/08_CSMS). A connector the EVSE does not have is
// Rejected with the Appendix reason code UnknownConnectorId instead of
// changing the EVSE's connector 1.
describe("OCPP 2.x ChangeAvailability with evse.connectorId (G03)", () => {
  for (const version of ["OCPP-2.0.1", "OCPP-2.1"] as const) {
    it(`${version}: changes the named connector and rejects one the EVSE lacks`, async () => {
      const csms = startMockCsms();
      const cp = createChargePoint(
        `CP-CHANGE-AVAILABILITY-CONNECTOR-${version}`,
        DefaultBootNotification,
        2,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        version,
        {},
      );
      cp.events.on("error", () => undefined);

      try {
        cp.connect();
        await bootAccepted(csms);

        // TC_G_07_CSMS-style connector-level change on a 1:1 station: same
        // answer and StatusNotification as the EVSE-level form.
        csms.send([
          2,
          "ca-connector",
          "ChangeAvailability",
          {
            operationalStatus: "Inoperative",
            evse: { id: 1, connectorId: 1 },
          } satisfies ChangeAvailabilityRequestV201,
        ]);
        const accepted = await csms.waitForFrame(
          callResultFrame("ca-connector"),
        );
        expect(accepted).toEqual([3, "ca-connector", { status: "Accepted" }]);
        const unavailable = await csms.waitForFrame(
          statusNotificationFrameAfter(
            csms,
            csms.received.indexOf(accepted),
            1,
            "Unavailable",
          ),
        );
        expect(unavailable[3]).toMatchObject({ evseId: 1, connectorId: 1 });
        expect(cp.getConnector(1)?.availability).toBe("Inoperative");

        // G03: EVSE 2 has no connector 2 -> Rejected, UnknownConnectorId,
        // and connector 2 (EVSE 2's only one) stays Operative.
        csms.send([
          2,
          "ca-no-connector",
          "ChangeAvailability",
          {
            operationalStatus: "Inoperative",
            evse: { id: 2, connectorId: 2 },
          } satisfies ChangeAvailabilityRequestV201,
        ]);
        const rejected = await csms.waitForFrame(
          callResultFrame("ca-no-connector"),
        );
        expect(rejected).toEqual([
          3,
          "ca-no-connector",
          {
            status: "Rejected",
            statusInfo: {
              reasonCode: "UnknownConnectorId",
              additionalInfo: "EVSE 2 has no connector 2",
            },
          },
        ]);
        expect(cp.getConnector(2)?.availability).toBe("Operative");

        // An unknown EVSE keeps the plain Rejected it always answered.
        csms.send([
          2,
          "ca-no-evse",
          "ChangeAvailability",
          {
            operationalStatus: "Inoperative",
            evse: { id: 9, connectorId: 1 },
          } satisfies ChangeAvailabilityRequestV201,
        ]);
        expect(await csms.waitForFrame(callResultFrame("ca-no-evse"))).toEqual([
          3,
          "ca-no-evse",
          { status: "Rejected" },
        ]);

        // Nothing was sent for EVSE 2 after the rejected request.
        const after = csms.received.indexOf(rejected);
        expect(
          csms.received.some(
            (frame, index) =>
              index > after &&
              frame[0] === 2 &&
              frame[2] === "StatusNotification" &&
              (frame[3] as { evseId?: number }).evseId === 2,
          ),
        ).toBe(false);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });
  }
});
