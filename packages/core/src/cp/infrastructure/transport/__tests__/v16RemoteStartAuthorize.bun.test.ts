import { describe, it, expect, spyOn } from "bun:test";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { createChargePoint } from "../../charge-point/createChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

/**
 * #921: OCPP 1.6 §5.11 with `AuthorizeRemoteTxRequests` true — the Charge
 * Point behaves as for a local start with the idTag of the
 * RemoteStartTransaction.req: it authorizes it first, and "a transaction will
 * only be started after authorization was obtained". The key is writable
 * (§9.1.3: R or RW), so the CSMS turns it on with ChangeConfiguration.
 */

async function replyStatusNotification(
  csms: MockCsms,
  connectorId: number,
  status: string,
): Promise<void> {
  const frame = await csms.waitForFrame(
    (candidate) =>
      candidate[0] === 2 &&
      candidate[2] === "StatusNotification" &&
      (candidate[3] as { connectorId?: number; status?: string })
        .connectorId === connectorId &&
      (candidate[3] as { connectorId?: number; status?: string }).status ===
        status,
  );
  csms.replyCallResult(frame[1] as string, {});
}

async function expectNoFrame(
  csms: MockCsms,
  pred: (frame: OcppFrame) => boolean,
): Promise<void> {
  try {
    const frame = await csms.waitForFrame(pred, 200);
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

/** Sends a CALL to the station and returns the payload of its answer. */
async function csmsCall(
  csms: MockCsms,
  id: string,
  action: string,
  payload: object,
): Promise<unknown> {
  csms.send([2, id, action, payload]);
  const frame = await csms.waitForFrame(
    (f) => (f[0] === 3 || f[0] === 4) && f[1] === id,
  );
  return frame[2];
}

async function withStation(
  id: string,
  run: (csms: MockCsms, cp: ChargePoint) => Promise<void>,
): Promise<void> {
  const csms = startMockCsms();
  const cp = createChargePoint(
    id,
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
      status: "Accepted",
      currentTime: "2026-06-24T00:00:00.000Z",
      interval: 300,
    });
    await replyStatusNotification(csms, 0, "Available");
    await replyStatusNotification(csms, 1, "Available");
    expect(
      await csmsCall(csms, "cc-1", "ChangeConfiguration", {
        key: "AuthorizeRemoteTxRequests",
        value: "true",
      }),
    ).toEqual({ status: "Accepted" });
    await run(csms, cp);
  } finally {
    cp.disconnect();
    await csms.stop();
  }
}

const remoteStart = (csms: MockCsms, idTag: string) =>
  csmsCall(csms, "rst-1", "RemoteStartTransaction", { connectorId: 1, idTag });

const isStartTransaction = (frame: OcppFrame) =>
  frame[0] === 2 && frame[2] === "StartTransaction";

describe("OCPP 1.6 remote start with AuthorizeRemoteTxRequests (#921, §5.11)", () => {
  it("answers the request, then sends Authorize.req, and starts once it is Accepted", async () => {
    await withStation("CP016-921-ACCEPTED", async (csms) => {
      expect(await remoteStart(csms, "TAG-921-OK")).toEqual({
        status: "Accepted",
      });
      const auth = await csms.waitForCall("Authorize");
      expect(auth.payload).toEqual({ idTag: "TAG-921-OK" });
      // The OCA TC_010 / TC_011_1 / TC_059 order: the answer, then Authorize.
      const index = (pred: (f: OcppFrame) => boolean) =>
        csms.received.findIndex(pred);
      expect(index((f) => f[0] === 3 && f[1] === "rst-1")).toBeLessThan(
        index((f) => f[0] === 2 && f[2] === "Authorize"),
      );
      csms.replyCallResult(auth.messageId, {
        idTagInfo: { status: "Accepted" },
      });
      await replyStatusNotification(csms, 1, "Preparing");
      const start = await csms.waitForCall("StartTransaction");
      expect((start.payload as { idTag: string }).idTag).toBe("TAG-921-OK");
    });
  }, 5000);

  it.each(["Invalid", "Blocked", "Expired"])(
    "an Authorize.conf %s starts nothing and reports the denial",
    async (status) => {
      await withStation(`CP016-921-${status}`, async (csms, cp) => {
        const denied: unknown[] = [];
        cp.events.on("authorizeDenied", (d) => denied.push(d));
        await remoteStart(csms, "TAG-921-NO");
        const auth = await csms.waitForCall("Authorize");
        csms.replyCallResult(auth.messageId, { idTagInfo: { status } });
        await expectNoFrame(csms, isStartTransaction);
        expect(cp.getConnector(1)?.transaction).toBeNull();
        expect(denied).toEqual([
          { connectorId: 1, tagId: "TAG-921-NO", status },
        ]);
      });
    },
    5000,
  );

  it("waits fail-closed: an unanswered Authorize does not start the transaction", async () => {
    await withStation("CP016-921-UNANSWERED", async (csms, cp) => {
      const wait = spyOn(cp, "authorizeAndWait");
      await remoteStart(csms, "TAG-921-SILENT");
      await csms.waitForCall("Authorize");
      expect(wait).toHaveBeenCalledWith(
        "TAG-921-SILENT",
        undefined,
        undefined,
        {
          failClosed: true,
        },
      );
      await expectNoFrame(csms, isStartTransaction);
    });
  }, 5000);
});
