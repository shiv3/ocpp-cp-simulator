import { describe, expect, it } from "bun:test";
import { startMockCsms, type MockCsms } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import {
  ID_TOKEN_TYPE_VALUES,
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
  it.each([...ID_TOKEN_TYPE_VALUES])(
    "sends %s in Authorize and in both TransactionEvents",
    async (type) => {
      await withStation(version, async (csms, cp) => {
        const expected = { idToken: "TAG-T", type };
        expect(await sessionTokens(csms, cp, type)).toEqual({
          authorize: expected,
          started: expected,
          ended: expected,
        });
      });
    },
  );

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
