import { describe, expect, it } from "bun:test";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

function callResultFrame(messageId: string): (frame: OcppFrame) => boolean {
  return (frame) => frame[0] === 3 && frame[1] === messageId;
}

function callErrorFrame(messageId: string): (frame: OcppFrame) => boolean {
  return (frame) => frame[0] === 4 && frame[1] === messageId;
}

async function bootAccepted(csms: MockCsms): Promise<void> {
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-06-24T00:00:00.000Z",
    interval: 300,
  });

  await csms.waitForFrame(
    (frame) =>
      frame[0] === 2 &&
      frame[2] === "StatusNotification" &&
      (frame[3] as { evseId?: number; connectorId?: number }).evseId === 1 &&
      (frame[3] as { evseId?: number; connectorId?: number }).connectorId ===
        1 &&
      (frame[3] as { connectorStatus?: string }).connectorStatus ===
        "Available",
  );
}

describe("OCPP 2.1 inbound CSMS calls", () => {
  it("handles v21 net-new, shared, malformed, and unknown inbound CALLs", async () => {
    const csms = startMockCsms();
    const cp = new ChargePoint(
      "CP21-INBOUND",
      DefaultBootNotification,
      1,
      csms.url,
      null,
      null,
      null,
      {},
      [],
      "OCPP-2.1",
    );
    cp.events.on("error", () => undefined);

    try {
      cp.connect();
      await bootAccepted(csms);

      csms.send([
        2,
        "v21-set-der",
        "SetDERControl",
        {
          isDefault: false,
          controlId: "der-control-1",
          controlType: "EnterService",
        },
      ]);
      expect(await csms.waitForFrame(callResultFrame("v21-set-der"))).toEqual([
        3,
        "v21-set-der",
        { status: "NotSupported" },
      ]);

      csms.send([
        2,
        "v21-get-variables",
        "GetVariables",
        {
          getVariableData: [
            {
              component: { name: "OCPPCommCtrlr" },
              variable: { name: "HeartbeatInterval" },
            },
          ],
        },
      ]);
      expect(
        await csms.waitForFrame(callResultFrame("v21-get-variables")),
      ).toEqual([
        3,
        "v21-get-variables",
        {
          getVariableResult: [
            {
              attributeStatus: "Accepted",
              attributeType: "Actual",
              attributeValue: "300",
              component: { name: "OCPPCommCtrlr" },
              variable: { name: "HeartbeatInterval" },
            },
          ],
        },
      ]);

      csms.send([
        2,
        "v21-set-der-malformed",
        "SetDERControl",
        { controlId: "der-control-2", controlType: "EnterService" },
      ]);
      expect(
        await csms.waitForFrame(callErrorFrame("v21-set-der-malformed")),
      ).toEqual([
        4,
        "v21-set-der-malformed",
        "FormationViolation",
        "Invalid SetDERControl payload",
        {},
      ]);

      csms.send([2, "v21-unknown", "UnknownV21Action", {}]);
      expect(await csms.waitForFrame(callErrorFrame("v21-unknown"))).toEqual([
        4,
        "v21-unknown",
        "NotImplemented",
        "This action is not supported",
        {},
      ]);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
