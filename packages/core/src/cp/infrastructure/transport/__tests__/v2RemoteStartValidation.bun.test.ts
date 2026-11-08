import { describe, expect, it } from "bun:test";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

const VERSIONS = ["OCPP-2.0.1", "OCPP-2.1"] as const;

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
      (frame[3] as { connectorStatus?: string }).connectorStatus ===
        "Available",
  );
}

const result = (id: string) => (frame: OcppFrame) =>
  (frame[0] === 3 || frame[0] === 4) && frame[1] === id;

async function withStation(
  version: (typeof VERSIONS)[number],
  run: (
    csms: MockCsms,
    cp: ChargePoint,
    ask: (payload: object) => Promise<unknown>,
  ) => Promise<void>,
  connectors = 2,
): Promise<void> {
  const csms = startMockCsms();
  const cp = new ChargePoint(
    "CP-RST-VALIDATION",
    DefaultBootNotification,
    connectors,
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
    await run(csms, cp, async (payload) => {
      const id = `rst-${++n}`;
      csms.send([2, id, "RequestStartTransaction", payload]);
      const frame = await csms.waitForFrame(result(id));
      return frame[0] === 4 ? { callError: frame[2] } : frame[2];
    });
  } finally {
    cp.disconnect();
    await csms.stop();
  }
}

const token = { idToken: "TAG-1", type: "Central" };

describe.each(VERSIONS)("%s RequestStartTransaction validation", (version) => {
  it("rejects a chargingProfile that is not a TxProfile (F01.FR.11)", async () => {
    await withStation(version, async (_c, _cp, ask) => {
      const res = await ask({
        remoteStartId: 1,
        idToken: token,
        chargingProfile: {
          id: 1,
          stackLevel: 0,
          chargingProfilePurpose: "TxDefaultProfile",
          chargingProfileKind: "Absolute",
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: "W",
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 7000 }],
            },
          ],
        },
      });
      expect(res).toMatchObject({
        status: "Rejected",
        statusInfo: { reasonCode: "InvalidProfile" },
      });
    });
  });

  it("rejects a TxProfile that carries a transactionId (F01.FR.12)", async () => {
    await withStation(version, async (_c, _cp, ask) => {
      const res = await ask({
        remoteStartId: 1,
        idToken: token,
        chargingProfile: {
          id: 1,
          stackLevel: 0,
          chargingProfilePurpose: "TxProfile",
          chargingProfileKind: "Absolute",
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: "W",
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 7000 }],
            },
          ],
          transactionId: "tx-1",
        },
      });
      expect(res).toMatchObject({
        status: "Rejected",
        statusInfo: { reasonCode: "InvalidProfile" },
      });
    });
  });

  it("answers a malformed idToken without starting a transaction", async () => {
    await withStation(version, async (csms, _cp, ask) => {
      // The message schema already refuses an empty or over-long idToken
      // (CALLERROR); the handler refuses an unknown type that the 2.1
      // schema, where `type` is a free string, lets through.
      for (const idToken of [
        { idToken: "", type: "Central" },
        { idToken: "X".repeat(37), type: "Central" },
        { idToken: "TAG", type: "NotAType" },
      ]) {
        const res = await ask({ remoteStartId: 1, idToken });
        expect(res).not.toEqual({ status: "Accepted" });
        if (version === "OCPP-2.1" && idToken.type === "NotAType") {
          expect(res).toMatchObject({
            status: "Rejected",
            statusInfo: { reasonCode: "InvalidIdToken" },
          });
        }
      }
      expect(
        csms.received.some((f) => f[0] === 2 && f[2] === "TransactionEvent"),
      ).toBe(false);
    });
  });

  it("rejects a master pass token as idToken or groupIdToken", async () => {
    await withStation(version, async (_c, cp, ask) => {
      expect(
        cp.configuration.setRuntimeValue("MasterPassGroupId", "MASTER"),
      ).toBe(true);
      expect(
        await ask({
          remoteStartId: 1,
          idToken: token,
          groupIdToken: { idToken: "MASTER", type: "Central" },
        }),
      ).toMatchObject({
        status: "Rejected",
        statusInfo: { reasonCode: "MasterPassNotAllowed" },
      });
      expect(
        await ask({
          remoteStartId: 2,
          idToken: { idToken: "MASTER", type: "Central" },
        }),
      ).toMatchObject({
        status: "Rejected",
        statusInfo: { reasonCode: "MasterPassNotAllowed" },
      });
    });
  });

  it("rejects an unknown EVSE and a busy EVSE", async () => {
    await withStation(version, async (csms, _cp, ask) => {
      expect(
        await ask({ remoteStartId: 1, idToken: token, evseId: 9 }),
      ).toMatchObject({
        status: "Rejected",
        statusInfo: { reasonCode: "UnknownEvse" },
      });
      expect(
        await ask({ remoteStartId: 2, idToken: token, evseId: 1 }),
      ).toEqual({ status: "Accepted" });
      await csms.waitForFrame((f) => f[0] === 2 && f[2] === "TransactionEvent");
      expect(
        await ask({ remoteStartId: 3, idToken: token, evseId: 1 }),
      ).toMatchObject({
        status: "Rejected",
        statusInfo: { reasonCode: "TxInProgress" },
      });
    });
  });

  it("selects a free EVSE when evseId is omitted, then reports none left", async () => {
    await withStation(version, async (csms, _cp, ask) => {
      expect(await ask({ remoteStartId: 1, idToken: token })).toEqual({
        status: "Accepted",
      });
      const first = await csms.waitForFrame(
        (f) => f[0] === 2 && f[2] === "TransactionEvent",
      );
      expect((first[3] as { evse?: { id: number } }).evse?.id).toBe(1);
      expect(await ask({ remoteStartId: 2, idToken: token })).toEqual({
        status: "Accepted",
      });
      await csms.waitForFrame(
        (f) =>
          f[0] === 2 &&
          f[2] === "TransactionEvent" &&
          (f[3] as { evse?: { id: number } }).evse?.id === 2,
      );
      expect(await ask({ remoteStartId: 3, idToken: token })).toMatchObject({
        status: "Rejected",
        statusInfo: { reasonCode: "NoFreeEvse" },
      });
    });
  });
});
