import { describe, expect, it } from "bun:test";
import { startMockCsms, type MockCsms } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import {
  ID_TOKEN_TYPE_VALUES,
  ID_TOKEN_TYPE_VALUES_V21_ONLY,
  type IdTokenTypeName,
} from "../../../domain/connector/Transaction";

const VERSIONS = ["OCPP-2.0.1", "OCPP-2.1"] as const;

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
  run: (csms: MockCsms, cp: ChargePoint) => Promise<void>,
): Promise<void> {
  const csms = startMockCsms();
  const cp = new ChargePoint(
    "CP-IDTOKEN",
    DefaultBootNotification,
    1,
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
    await run(csms, cp);
  } finally {
    cp.disconnect();
    await csms.stop();
  }
}

const eventOf = (type: string) => (f: unknown[]) =>
  f[0] === 2 &&
  f[2] === "TransactionEvent" &&
  (f[3] as { eventType?: string }).eventType === type;

/** Runs Authorize -> Started -> Ended and returns the IdToken of each. */
async function sessionTokens(
  csms: MockCsms,
  cp: ChargePoint,
  idTokenType?: IdTokenTypeName,
) {
  const started = cp.startTransaction("TAG-T", 1, undefined, undefined, {
    ...(idTokenType ? { idTokenType } : {}),
  });
  const auth = await csms.waitForCall("Authorize");
  csms.replyCallResult(auth.messageId, { idTokenInfo: { status: "Accepted" } });
  await started;
  const startedFrame = await csms.waitForFrame(eventOf("Started"));
  cp.stopTransaction(1);
  const endedFrame = await csms.waitForFrame(eventOf("Ended"));
  const token = (f: unknown[]) =>
    (f[3] as { idToken?: unknown }).idToken as unknown;
  return {
    authorize: (auth.payload as { idToken: unknown }).idToken,
    started: token(startedFrame),
    ended: token(endedFrame),
  };
}

describe.each(VERSIONS)("%s IdToken.type (#599)", (version) => {
  const v21Only = (t: string) =>
    (ID_TOKEN_TYPE_VALUES_V21_ONLY as readonly string[]).includes(t);

  it.each([...ID_TOKEN_TYPE_VALUES].filter((t) => t !== "NoAuthorization"))(
    "sends %s in Authorize and in both TransactionEvents (a 2.1-only type falls back to ISO14443 on 2.0.1)",
    async (type) => {
      await withStation(version, async (csms, cp) => {
        const effective =
          version === "OCPP-2.0.1" && v21Only(type) ? "ISO14443" : type;
        const expected = { idToken: "TAG-T", type: effective };
        expect(await sessionTokens(csms, cp, type)).toEqual({
          authorize: expected,
          started: expected,
          ended: expected,
        });
      });
    },
  );

  it("sends NoAuthorization with an empty idToken and no Authorize", async () => {
    await withStation(version, async (csms, cp) => {
      await cp.startTransaction("TAG-T", 1, undefined, undefined, {
        idTokenType: "NoAuthorization",
      });
      const startedFrame = await csms.waitForFrame(eventOf("Started"));
      cp.stopTransaction(1);
      const endedFrame = await csms.waitForFrame(eventOf("Ended"));
      const expected = { idToken: "", type: "NoAuthorization" };
      expect((startedFrame[3] as { idToken: unknown }).idToken).toEqual(
        expected,
      );
      expect((endedFrame[3] as { idToken: unknown }).idToken).toEqual(expected);
      expect(csms.received.some((f) => f[2] === "Authorize")).toBe(false);
    });
  });

  describe("RequestStartTransaction keeps the CSMS's idToken.type (F01.FR.04)", () => {
    const ask = async (csms: MockCsms, payload: object): Promise<unknown> => {
      csms.send([2, "rst-1", "RequestStartTransaction", payload]);
      const frame = await csms.waitForFrame(
        (f) => (f[0] === 3 || f[0] === 4) && f[1] === "rst-1",
      );
      return frame[2];
    };

    it.each(["Central", "eMAID", "KeyCode"])(
      "carries %s into Authorize and the Started event",
      async (type) => {
        await withStation(version, async (csms, cp) => {
          cp.configuration.setRuntimeValue("AuthorizeRemoteTxRequests", true);
          const expected = { idToken: "REMOTE-1", type };
          expect(
            await ask(csms, { remoteStartId: 7, idToken: expected }),
          ).toEqual({ status: "Accepted" });
          const auth = await csms.waitForCall("Authorize");
          expect(auth.payload).toEqual({ idToken: expected });
          csms.replyCallResult(auth.messageId, {
            idTokenInfo: { status: "Accepted" },
          });
          const started = await csms.waitForFrame(eventOf("Started"));
          expect((started[3] as { idToken: unknown }).idToken).toEqual(
            expected,
          );
        });
      },
    );

    it("carries a 2.1 standard type as sent", async () => {
      if (version !== "OCPP-2.1") return;
      await withStation(version, async (csms) => {
        const expected = { idToken: "VIN-1", type: "VIN" };
        await ask(csms, { remoteStartId: 8, idToken: expected });
        const started = await csms.waitForFrame(eventOf("Started"));
        expect((started[3] as { idToken: unknown }).idToken).toEqual(expected);
      });
    });

    it("hands the type to a parked remoteStartTrigger scenario", async () => {
      await withStation(version, async (csms, cp) => {
        const got: unknown[] = [];
        cp.events.on("remoteStartReceived", (d) => got.push(d));
        cp.registerScenarioHandler(1);
        await ask(csms, {
          remoteStartId: 9,
          idToken: { idToken: "REMOTE-2", type: "Central" },
        });
        expect(got).toEqual([
          {
            connectorId: 1,
            tagId: "REMOTE-2",
            remoteStartId: 9,
            idTokenType: "Central",
          },
        ]);
      });
    });
  });

  it("keeps ISO14443 when no type is given", async () => {
    await withStation(version, async (csms, cp) => {
      const expected = { idToken: "TAG-T", type: "ISO14443" };
      expect(await sessionTokens(csms, cp)).toEqual({
        authorize: expected,
        started: expected,
        ended: expected,
      });
    });
  });

  it("lets a standalone Authorize name the type", async () => {
    await withStation(version, async (csms, cp) => {
      cp.authorize("TAG-S", "eMAID");
      const auth = await csms.waitForCall("Authorize");
      expect(auth.payload).toEqual({
        idToken: { idToken: "TAG-S", type: "eMAID" },
      });
    });
  });
});
