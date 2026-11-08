import { describe, expect, it } from "bun:test";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

const VERSIONS = ["OCPP-2.0.1", "OCPP-2.1"] as const;

const resultOf = (id: string) => (f: OcppFrame) => f[0] === 3 && f[1] === id;
const callOf = (action: string, seen: Set<unknown>) => (f: OcppFrame) =>
  f[0] === 2 && f[2] === action && !seen.has(f[1]);

async function bootAccepted(csms: MockCsms): Promise<void> {
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-06-24T00:00:00.000Z",
    interval: 300,
  });
  await csms.waitForFrame(
    (f) =>
      f[0] === 2 &&
      f[2] === "StatusNotification" &&
      (f[3] as { connectorStatus?: string }).connectorStatus === "Available",
  );
}

async function withStation(
  version: (typeof VERSIONS)[number],
  run: (
    csms: MockCsms,
    cp: ChargePoint,
    trigger: (
      requestedMessage: string,
      evse?: { id: number },
    ) => Promise<{
      result: OcppFrame;
      follow: (action: string) => Promise<OcppFrame>;
    }>,
  ) => Promise<void>,
): Promise<void> {
  const csms = startMockCsms();
  const cp = new ChargePoint(
    "CP-TRIGGER-596",
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
  let n = 0;
  try {
    cp.connect();
    await bootAccepted(csms);
    await run(csms, cp, async (requestedMessage, evse) => {
      const id = `tm-${++n}`;
      const seen = new Set<unknown>(csms.received.map((f) => f[1]));
      csms.send([
        2,
        id,
        "TriggerMessage",
        { requestedMessage, ...(evse ? { evse } : {}) },
      ]);
      const result = await csms.waitForFrame(resultOf(id));
      return {
        result,
        follow: async (action) => {
          const frame = await csms.waitForFrame(callOf(action, seen));
          // The response goes out before the triggered request.
          expect(csms.received.indexOf(frame)).toBeGreaterThan(
            csms.received.indexOf(result),
          );
          return frame;
        },
      };
    });
  } finally {
    cp.disconnect();
    await csms.stop();
  }
}

async function startOn(
  csms: MockCsms,
  cp: ChargePoint,
  connectorId: number,
): Promise<void> {
  cp.configuration.setRuntimeValue("AuthorizeBeforeLocalStart", false);
  await cp.startTransaction("TAG-1", connectorId);
  await csms.waitForFrame(
    (f) =>
      f[0] === 2 &&
      f[2] === "TransactionEvent" &&
      (f[3] as { eventType?: string; evse?: { id: number } }).eventType ===
        "Started" &&
      (f[3] as { evse?: { id: number } }).evse?.id === connectorId,
  );
}

describe.each(VERSIONS)("%s TriggerMessage (#596)", (version) => {
  it("TransactionEvent sends an Updated event with triggerReason Trigger", async () => {
    await withStation(version, async (csms, cp, trigger) => {
      await startOn(csms, cp, 1);
      await startOn(csms, cp, 2);
      const { result, follow } = await trigger("TransactionEvent");
      expect(result[2]).toEqual({ status: "Accepted" });
      const first = await follow("TransactionEvent");
      expect(first[3]).toMatchObject({
        eventType: "Updated",
        triggerReason: "Trigger",
      });
    });
  });

  it("TransactionEvent honors the requested EVSE", async () => {
    await withStation(version, async (csms, cp, trigger) => {
      await startOn(csms, cp, 1);
      await startOn(csms, cp, 2);
      const { result, follow } = await trigger("TransactionEvent", { id: 2 });
      expect(result[2]).toEqual({ status: "Accepted" });
      const frame = await follow("TransactionEvent");
      expect(frame[3]).toMatchObject({
        eventType: "Updated",
        triggerReason: "Trigger",
        evse: { id: 2 },
      });
      await new Promise((r) => setTimeout(r, 100));
      const triggered = csms.received.filter(
        (f) =>
          f[0] === 2 &&
          f[2] === "TransactionEvent" &&
          (f[3] as { triggerReason?: string }).triggerReason === "Trigger",
      );
      expect(triggered).toHaveLength(1);
    });
  });

  it("TransactionEvent is Rejected where no transaction runs", async () => {
    await withStation(version, async (csms, cp, trigger) => {
      const { result } = await trigger("TransactionEvent");
      expect(result[2]).toMatchObject({
        status: "Rejected",
        statusInfo: { reasonCode: "TxNotFound" },
      });
      await startOn(csms, cp, 1);
      const other = await trigger("TransactionEvent", { id: 2 });
      expect(other.result[2]).toMatchObject({ status: "Rejected" });
    });
  });

  it("FirmwareStatusNotification and LogStatusNotification report Idle when nothing is in progress", async () => {
    await withStation(version, async (_csms, _cp, trigger) => {
      for (const action of [
        "FirmwareStatusNotification",
        "LogStatusNotification",
      ]) {
        const { result, follow } = await trigger(action);
        expect(result[2]).toEqual({ status: "Accepted" });
        expect((await follow(action))[3]).toEqual({ status: "Idle" });
      }
    });
  });

  it("Idle carries no requestId even after an accepted UpdateFirmware / GetLog", async () => {
    await withStation(version, async (csms, _cp, trigger) => {
      csms.send([
        2,
        "uf-1",
        "UpdateFirmware",
        {
          requestId: 11,
          firmware: {
            location: "https://example.invalid/fw.bin",
            retrieveDateTime: "2026-06-24T00:00:00.000Z",
          },
        },
      ]);
      await csms.waitForFrame(resultOf("uf-1"));
      const { follow } = await trigger("FirmwareStatusNotification");
      expect((await follow("FirmwareStatusNotification"))[3]).toEqual({
        status: "Idle",
      });
    });
  });

  it("reports the status a behavior left in the engine while it is in progress", async () => {
    await withStation(version, async (_csms, cp, trigger) => {
      cp.engine.restoreState({
        schema: 1,
        firmware: { status: "Installing", requestId: 11 },
        signedFirmware: { status: "Idle", requestId: null },
        log: { status: "Uploading", requestId: 12 },
        diagnostics: { status: "Idle" },
        behaviors: {},
      });
      const fw = await trigger("FirmwareStatusNotification");
      expect((await fw.follow("FirmwareStatusNotification"))[3]).toEqual({
        status: "Installing",
        requestId: 11,
      });
      const log = await trigger("LogStatusNotification");
      expect((await log.follow("LogStatusNotification"))[3]).toEqual({
        status: "Uploading",
        requestId: 12,
      });
    });
  });
});
