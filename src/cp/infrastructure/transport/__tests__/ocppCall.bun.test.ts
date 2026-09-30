import { describe, it, expect } from "bun:test";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import {
  DefaultBootNotification,
  OCPPStatus,
} from "../../../domain/types/OcppTypes";
import { getOcppCallCatalog } from "../codec/ocppCallCatalog";
import {
  OcppCallNoAnswerError,
  OcppCallRejectedError,
} from "../../../domain/errors/OcppCallErrors";

/**
 * #389: `ChargePoint.sendOcppCall` sends an operator-chosen station CALL
 * through the normal transport and resolves with the CSMS's answer —
 * CALLRESULT or CALLERROR — plus the frame exactly as it went out.
 */
type Version = "OCPP-2.0.1" | "OCPP-2.1" | "OCPP-1.6J";

async function bootedChargePoint(
  csms: MockCsms,
  id: string,
  version: Version | "OCPP-1.6S",
  connectors = 1,
): Promise<ChargePoint> {
  const cp = new ChargePoint(
    id,
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
  if (version === "OCPP-1.6S") return cp;
  cp.connect();
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-09-17T00:00:00.000Z",
    interval: 300,
  });
  await csms.waitForFrame(
    (frame) => frame[0] === 2 && frame[2] === "StatusNotification",
  );
  return cp;
}

/** Answer every CALL but the ones `skip` names with an empty CALLRESULT, so
 *  1.6's serial queue (#176) keeps moving. */
type Skip = readonly string[] | ((frame: OcppFrame) => boolean);

function answerEverythingElse(csms: MockCsms, skip: Skip): () => void {
  const skipped =
    typeof skip === "function"
      ? skip
      : (frame: OcppFrame) => skip.includes(frame[2] as string);
  const answered = new Set<string>();
  const tick = setInterval(() => {
    for (const frame of csms.received) {
      if (frame[0] !== 2) continue;
      const id = frame[1] as string;
      if (answered.has(id) || skipped(frame)) continue;
      answered.add(id);
      if (frame[2] === "BootNotification") continue;
      csms.replyCallResult(id, {});
    }
  }, 5);
  return () => clearInterval(tick);
}

const callOf = (action: string) => (frame: OcppFrame) =>
  frame[0] === 2 && frame[2] === action;

const statusNotifications = (csms: MockCsms) =>
  csms.received.filter(callOf("StatusNotification")).length;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withStation(
  version: Version,
  skip: Skip,
  body: (cp: ChargePoint, csms: MockCsms) => Promise<void>,
  connectors = 1,
): Promise<void> {
  const csms = startMockCsms();
  const cp = await bootedChargePoint(
    csms,
    `CP-${version}`,
    version,
    connectors,
  );
  const stop = answerEverythingElse(csms, skip);
  try {
    await body(cp, csms);
  } finally {
    stop();
    cp.disconnect();
    await csms.stop();
  }
}

describe("sendOcppCall (#389)", () => {
  it("1.6: a station-level Heartbeat with an edited payload returns the CALLRESULT and the sent frame", async () => {
    await withStation("OCPP-1.6J", ["Heartbeat"], async (cp, csms) => {
      const answer = cp.sendOcppCall({ action: "Heartbeat", payload: {} });
      const call = await csms.waitForFrame(callOf("Heartbeat"));
      csms.replyCallResult(call[1] as string, {
        currentTime: "2026-09-30T00:00:00.000Z",
      });
      expect(await answer).toEqual({
        kind: "callResult",
        messageId: call[1] as string,
        sentFrame: JSON.stringify(call),
        payload: { currentTime: "2026-09-30T00:00:00.000Z" },
      });
    });
  });

  it("1.6: a connector StatusNotification goes out with the payload as edited", async () => {
    const edited = (f: OcppFrame) =>
      callOf("StatusNotification")(f) &&
      (f[3] as { vendorErrorCode?: string }).vendorErrorCode === "E42";
    await withStation("OCPP-1.6J", edited, async (cp, csms) => {
      const payload = {
        connectorId: 1,
        errorCode: "OtherError",
        status: "Faulted",
        vendorErrorCode: "E42",
      };
      const answer = cp.sendOcppCall({
        action: "StatusNotification",
        payload,
      });
      const call = await csms.waitForFrame(edited);
      expect(call[3]).toEqual(payload);
      csms.replyCallResult(call[1] as string, {});
      expect((await answer).kind).toBe("callResult");
    });
  });

  it("2.0.1: a CALLERROR is an answer, with its code, description and details", async () => {
    await withStation("OCPP-2.0.1", ["MeterValues"], async (cp, csms) => {
      const answer = cp.sendOcppCall({
        action: "MeterValues",
        payload: {
          evseId: 1,
          meterValue: [
            {
              timestamp: "2026-09-30T00:00:00.000Z",
              sampledValue: [{ value: 12.5 }],
            },
          ],
        },
      });
      const call = await csms.waitForFrame(callOf("MeterValues"));
      csms.send([4, call[1], "PropertyConstraintViolation", "bad", { a: 1 }]);
      expect(await answer).toEqual({
        kind: "callError",
        messageId: call[1] as string,
        sentFrame: JSON.stringify(call),
        errorCode: "PropertyConstraintViolation",
        errorDescription: "bad",
        errorDetails: { a: 1 },
      });
    });
  });

  it.each(["OCPP-1.6J", "OCPP-2.0.1", "OCPP-2.1"] as const)(
    "%s: a schema-invalid payload is refused and nothing is written",
    async (version) => {
      await withStation(version, ["Heartbeat"], async (cp, csms) => {
        const before = csms.received.length;
        const answer = cp.sendOcppCall({
          action: "Heartbeat",
          payload: { unexpected: true },
        });
        await expect(answer).rejects.toBeInstanceOf(OcppCallRejectedError);
        await expect(answer).rejects.toMatchObject({
          reason: "invalid_payload",
        });
        await sleep(50);
        expect(csms.received.slice(before).some(callOf("Heartbeat"))).toBe(
          false,
        );
      });
    },
  );

  it.each(["OCPP-1.6J", "OCPP-2.0.1", "OCPP-2.1"] as const)(
    "%s: skipValidation sends that one invalid payload; validation still applies to the next call",
    async (version) => {
      await withStation(version, ["Heartbeat"], async (cp, csms) => {
        const invalid = cp.sendOcppCall({
          action: "Heartbeat",
          payload: { unexpected: true },
          skipValidation: true,
        });
        const call = await csms.waitForFrame(callOf("Heartbeat"));
        expect(call[3]).toEqual({ unexpected: true });
        csms.replyCallResult(call[1] as string, {
          currentTime: "2026-09-30T00:00:00.000Z",
        });
        expect((await invalid).kind).toBe("callResult");

        await expect(
          cp.sendOcppCall({ action: "Heartbeat", payload: { again: 1 } }),
        ).rejects.toMatchObject({ reason: "invalid_payload" });
      });
    },
  );

  it.each(["OCPP-1.6J", "OCPP-2.0.1"] as const)(
    "%s: an action the station does not send is refused",
    async (version) => {
      await withStation(version, ["Reset"], async (cp) => {
        await expect(
          cp.sendOcppCall({ action: "Reset", payload: {} }),
        ).rejects.toMatchObject({ reason: "unsupported_action" });
      });
    },
  );

  it.each([
    ["a string", "{oops"],
    ["an array", [1]],
    ["null", null],
  ])(
    "refuses %s as payload, even with skipValidation",
    async (_label, payload) => {
      await withStation("OCPP-1.6J", ["Heartbeat"], async (cp) => {
        await expect(
          cp.sendOcppCall({
            action: "Heartbeat",
            payload: payload as unknown as Record<string, unknown>,
            skipValidation: true,
          }),
        ).rejects.toMatchObject({ reason: "invalid_payload" });
      });
    },
  );

  it("SOAP stations refuse expert calls", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP-SOAP", "OCPP-1.6S");
    try {
      await expect(
        cp.sendOcppCall({ action: "Heartbeat", payload: {} }),
      ).rejects.toMatchObject({ reason: "unsupported_transport" });
    } finally {
      await csms.stop();
    }
  });

  it.each(["OCPP-1.6J", "OCPP-2.0.1"] as const)(
    "%s: a BootNotification answer leaves the station alone unless applyResponse is set",
    async (version) => {
      await withStation(version, ["BootNotification"], async (cp, csms) => {
        const payload =
          version === "OCPP-1.6J"
            ? { chargePointVendor: "V", chargePointModel: "M" }
            : {
                reason: "PowerUp",
                chargingStation: { model: "M", vendorName: "V" },
              };
        const accepted = {
          status: "Accepted",
          currentTime: "2026-09-30T00:00:00.000Z",
          interval: 300,
        };
        const boots = () => csms.received.filter(callOf("BootNotification"));

        await sleep(50);
        const quiet = statusNotifications(csms);
        const first = cp.sendOcppCall({ action: "BootNotification", payload });
        await csms.waitForFrame(
          (f) => boots().length === 2 && f === boots()[1],
        );
        csms.replyCallResult(boots()[1][1] as string, accepted);
        expect((await first).kind).toBe("callResult");
        await sleep(100);
        expect(statusNotifications(csms)).toBe(quiet);

        const second = cp.sendOcppCall({
          action: "BootNotification",
          payload,
          applyResponse: true,
        });
        await csms.waitForFrame(
          (f) => boots().length === 3 && f === boots()[2],
        );
        csms.replyCallResult(boots()[2][1] as string, accepted);
        expect((await second).kind).toBe("callResult");
        // Boot accepted again → the station re-announces its connectors.
        await csms.waitForFrame(
          (f) =>
            callOf("StatusNotification")(f) &&
            statusNotifications(csms) > quiet,
        );
      });
    },
  );

  it("2.0.1: closing the connection drops a pending call", async () => {
    await withStation("OCPP-2.0.1", ["Heartbeat"], async (cp, csms) => {
      const answer = cp.sendOcppCall({ action: "Heartbeat", payload: {} });
      await csms.waitForFrame(callOf("Heartbeat"));
      csms.closeCurrentConnection();
      await expect(answer).rejects.toBeInstanceOf(OcppCallNoAnswerError);
      await expect(answer).rejects.toMatchObject({ reason: "dropped" });
    });
  });

  it("2.1: a 2.1-only station message goes out with its default payload", async () => {
    await withStation("OCPP-2.1", ["NotifySettlement"], async (cp, csms) => {
      const payload =
        getOcppCallCatalog("OCPP-2.1")!.defaultPayload("NotifySettlement");
      const answer = cp.sendOcppCall({ action: "NotifySettlement", payload });
      const call = await csms.waitForFrame(callOf("NotifySettlement"));
      expect(call[3]).toEqual(payload);
      csms.replyCallResult(call[1] as string, {});
      expect((await answer).kind).toBe("callResult");
    });
  });

  describe("1.6 specifics", () => {
    const startTransaction = (connectorId: number) => ({
      connectorId,
      idTag: "TAG-1",
      meterStart: 0,
      timestamp: "2026-09-30T00:00:00.000Z",
    });

    it("applyResponse applies a StartTransaction answer to the connector the payload names", async () => {
      await withStation(
        "OCPP-1.6J",
        ["StartTransaction"],
        async (cp, csms) => {
          const answer = cp.sendOcppCall({
            action: "StartTransaction",
            payload: startTransaction(2),
            applyResponse: true,
          });
          const call = await csms.waitForFrame(callOf("StartTransaction"));
          csms.replyCallResult(call[1] as string, {
            transactionId: 42,
            idTagInfo: { status: "Accepted" },
          });
          await answer;
          await sleep(50);
          expect(cp.getConnector(2)?.status).toBe(OCPPStatus.Charging);
          expect(cp.getConnector(1)?.status).not.toBe(OCPPStatus.Charging);
        },
        2,
      );
    });

    it("a CALLERROR without applyResponse is only an answer: no recovery, and the queue moves on", async () => {
      await withStation(
        "OCPP-1.6J",
        ["StartTransaction", "Heartbeat"],
        async (cp, csms) => {
          cp.updateConnectorStatus(1, OCPPStatus.Preparing);
          const answer = cp.sendOcppCall({
            action: "StartTransaction",
            payload: startTransaction(1),
          });
          const call = await csms.waitForFrame(callOf("StartTransaction"));
          csms.send([4, call[1], "GenericError", "no", {}]);
          expect((await answer).kind).toBe("callError");

          // The serial slot was released: the next CALL goes out at once.
          const next = cp.sendOcppCall({ action: "Heartbeat", payload: {} });
          const heartbeat = await csms.waitForFrame(callOf("Heartbeat"), 1000);
          csms.replyCallResult(heartbeat[1] as string, {
            currentTime: "2026-09-30T00:00:00.000Z",
          });
          await next;
          // StartTransaction's CALLERROR recovery would have reset it.
          expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Preparing);
        },
      );
    });

    it("the boot gate refuses a call before BootNotification is Accepted, and writes nothing", async () => {
      const csms = startMockCsms();
      const cp = new ChargePoint(
        "CP-GATE",
        DefaultBootNotification,
        1,
        csms.url,
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6J",
        {},
      );
      cp.events.on("error", () => undefined);
      try {
        cp.connect();
        const boot = await csms.waitForCall("BootNotification");
        csms.replyCallResult(boot.messageId, {
          status: "Pending",
          currentTime: "2026-09-30T00:00:00.000Z",
          interval: 300,
        });
        await sleep(50);
        await expect(
          cp.sendOcppCall({ action: "Heartbeat", payload: {} }),
        ).rejects.toMatchObject({ reason: "boot_gate" });
        await sleep(50);
        expect(csms.received.some(callOf("Heartbeat"))).toBe(false);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("a close drops queued and in-flight calls; none is replayed after the reconnect", async () => {
      await withStation(
        "OCPP-1.6J",
        ["Heartbeat", "MeterValues"],
        async (cp, csms) => {
          // The unanswered Heartbeat holds the serial slot, so MeterValues
          // waits in the queue.
          const inFlight = cp.sendOcppCall({
            action: "Heartbeat",
            payload: {},
          });
          await csms.waitForFrame(callOf("Heartbeat"));
          const queued = cp.sendOcppCall({
            action: "MeterValues",
            payload: {
              connectorId: 1,
              meterValue: [
                {
                  timestamp: "2026-09-30T00:00:00.000Z",
                  sampledValue: [{ value: "1" }],
                },
              ],
            },
          });
          // The close rejects both synchronously: capture before closing.
          const outcomes = Promise.all(
            [inFlight, queued].map((p) => p.catch((err: unknown) => err)),
          );
          csms.closeCurrentConnection();
          for (const err of await outcomes) {
            expect(err).toBeInstanceOf(OcppCallNoAnswerError);
            expect(err).toMatchObject({ reason: "dropped" });
          }

          const boots = () => csms.received.filter(callOf("BootNotification"));
          await csms.waitForFrame(
            (f) => boots().length === 2 && f === boots()[1],
            10_000,
          );
          csms.replyCallResult(boots()[1][1] as string, {
            status: "Accepted",
            currentTime: "2026-09-30T00:00:00.000Z",
            interval: 300,
          });
          await sleep(300);
          expect(csms.received.some(callOf("MeterValues"))).toBe(false);
        },
      );
    });
  });
});
