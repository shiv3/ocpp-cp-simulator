import { describe, it, expect } from "bun:test";
import { getOcppCallCatalog } from "../codec/ocppCallCatalog";
import { bootedV201ChargePoint, startMockCsms } from "./mockCsms";

/**
 * #1096 / #1097: OCPP 2.1 SEND (RPC message type 6) and the 2.1-only
 * station messages, sent with the schema-valid default payload when none is
 * given.
 */
async function station(version: "OCPP-2.0.1" | "OCPP-2.1" = "OCPP-2.1") {
  const csms = startMockCsms();
  const cp = await bootedV201ChargePoint(csms, "CP21-SEND", version);
  return {
    csms,
    cp,
    stop: async () => {
      cp.disconnect();
      await csms.stop();
    },
  };
}

describe("OCPP 2.1 SEND (#1096)", () => {
  it("writes [6, id, action, payload] with the default payload and awaits nothing", async () => {
    const { csms, cp, stop } = await station();
    try {
      const sent = await cp.sendOcppSend({
        action: "NotifyPeriodicEventStream",
      });
      const frame = await csms.waitForFrame((f) => f[0] === 6);
      expect(frame[1]).toBe(sent.messageId);
      expect(frame[2]).toBe("NotifyPeriodicEventStream");
      expect(frame[3]).toMatchObject({
        id: 0,
        pending: 0,
        data: [{ t: 0, v: "" }],
      });
      expect(JSON.parse(sent.sentFrame)).toEqual(frame);
    } finally {
      await stop();
    }
  });

  it("sends the payload as given, and a schema-invalid one only with skipValidation", async () => {
    const { csms, cp, stop } = await station();
    try {
      const payload = {
        id: 3,
        pending: 1,
        basetime: "2026-11-21T00:00:00Z",
        data: [{ t: 0.5, v: "12.5" }],
      };
      const sent = await cp.sendOcppSend({
        action: "NotifyPeriodicEventStream",
        payload,
      });
      expect((await csms.waitForFrame((f) => f[0] === 6))[3]).toEqual(payload);
      expect(sent.sentFrame).toBe(
        `[6,"${sent.messageId}","NotifyPeriodicEventStream",{"id":3,"pending":1,"basetime":"2026-11-21T00:00:00Z","data":[{"t":0.5,"v":"12.5"}]}]`,
      );

      await expect(
        cp.sendOcppSend({
          action: "NotifyPeriodicEventStream",
          payload: { id: -1 },
        }),
      ).rejects.toThrow(/NotifyPeriodicEventStream/);
      await cp.sendOcppSend({
        action: "NotifyPeriodicEventStream",
        payload: { id: -1 },
        skipValidation: true,
      });
      await csms.waitForFrame(
        (f) => f[0] === 6 && (f[3] as { id: number }).id === -1,
      );
    } finally {
      await stop();
    }
  });

  it("refuses a CALL action, an unknown action and a station that is not 2.1", async () => {
    const { cp, stop } = await station();
    try {
      await expect(
        cp.sendOcppSend({ action: "Heartbeat", payload: {} }),
      ).rejects.toThrow(/expected one of NotifyPeriodicEventStream/);
    } finally {
      await stop();
    }
    const old = await station("OCPP-2.0.1");
    try {
      await expect(
        old.cp.sendOcppSend({ action: "NotifyPeriodicEventStream" }),
      ).rejects.toThrow(/OCPP 2\.1 only/);
    } finally {
      await old.stop();
    }
  });
});

describe("2.1-only station messages with default payloads (#1097)", () => {
  it.each([
    "BatterySwap",
    "NotifyDERAlarm",
    "NotifyDERStartStop",
    "NotifySettlement",
    "PullDynamicScheduleUpdate",
    "NotifyPriorityCharging",
    "VatNumberValidation",
  ])(
    "%s goes out with its default payload and the CSMS's answer comes back",
    async (action) => {
      const { csms, cp, stop } = await station();
      try {
        const outcome = cp.sendOcppCall({ action });
        const call = await csms.waitForCall(action);
        // the catalog's own default: schema-valid, with every required field
        const catalog = getOcppCallCatalog("OCPP-2.1")!;
        expect(catalog.validate(action, call.payload)).toBeNull();
        expect(Object.keys(call.payload as object).sort()).toEqual(
          Object.keys(catalog.defaultPayload(action)).sort(),
        );
        csms.replyCallResult(call.messageId, { status: "Accepted" });
        expect(await outcome).toMatchObject({
          kind: "callResult",
          payload: { status: "Accepted" },
        });
      } finally {
        await stop();
      }
    },
  );

  it("an unknown action without a payload is refused as unsupported", async () => {
    const { cp, stop } = await station();
    try {
      await expect(cp.sendOcppCall({ action: "NoSuchAction" })).rejects.toThrow(
        /not a station-initiated call/,
      );
    } finally {
      await stop();
    }
  });
});
