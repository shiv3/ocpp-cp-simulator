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
  { authorizeRemoteTxRequests = true, connectors = 1 } = {},
): Promise<void> {
  const csms = startMockCsms();
  const cp = createChargePoint(
    id,
    DefaultBootNotification,
    connectors,
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
    for (let connector = 1; connector <= connectors; connector++) {
      await replyStatusNotification(csms, connector, "Available");
    }
    expect(
      await csmsCall(csms, "cc-1", "ChangeConfiguration", {
        key: "AuthorizeRemoteTxRequests",
        value: String(authorizeRemoteTxRequests),
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

  it("waits fail-closed for the Authorize.conf, without starting meanwhile", async () => {
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

  // The wait above lasts 10 s; this is what it ends in on 1.6 (the 2.x
  // counterpart is in v2xOneCallInFlight.bun.test.ts).
  it("a fail-closed wait left unanswered on 1.6 resolves Unknown, not Accepted", async () => {
    await withStation("CP016-921-TIMEOUT", async (csms, cp) => {
      const outcome = cp.authorizeAndWait("TAG-921-SILENT", 100, undefined, {
        failClosed: true,
      });
      await csms.waitForCall("Authorize");
      expect(await outcome).toBe("Unknown");
    });
  }, 5000);
});

/**
 * #839: 1.6 §5.13 — a reservation holding a parent idTag admits the idTags
 * under that parent. When the station knows no parent for the incoming idTag
 * (not in the Local Authorization List nor the Authorization Cache), it "SHALL
 * send an Authorize.req for the incoming idTag", so a RemoteStartTransaction
 * of such a child is Accepted (errata 3.32: "will attempt to start") and
 * starts only once the Authorize.conf names the reservation's parent.
 */
describe("OCPP 1.6 remote start of a child idTag on a parent's reservation (#839, §5.13)", () => {
  async function reserveForParent(csms: MockCsms): Promise<void> {
    expect(
      await csmsCall(csms, "rn-1", "ReserveNow", {
        connectorId: 1,
        expiryDate: new Date(Date.now() + 3_600_000).toISOString(),
        idTag: "OWNER-839",
        parentIdTag: "PARENT-839",
        reservationId: 839,
      }),
    ).toEqual({ status: "Accepted" });
    await replyStatusNotification(csms, 1, "Reserved");
  }

  const childStart = (csms: MockCsms, connectorId?: number) =>
    csmsCall(csms, "rst-839", "RemoteStartTransaction", {
      ...(connectorId !== undefined ? { connectorId } : {}),
      idTag: "CHILD-839",
    });

  it.each([
    ["on the reserved connector", 1],
    ["without a connector", undefined],
  ])(
    "%s: accepts, sends Authorize.req and starts on the parent's reservation",
    async (_label, connectorId) => {
      await withStation(
        `CP016-839-CHILD-${connectorId ?? "ANY"}`,
        async (csms) => {
          await reserveForParent(csms);
          expect(await childStart(csms, connectorId)).toEqual({
            status: "Accepted",
          });
          const auth = await csms.waitForCall("Authorize");
          expect(auth.payload).toEqual({ idTag: "CHILD-839" });
          csms.replyCallResult(auth.messageId, {
            idTagInfo: { status: "Accepted", parentIdTag: "PARENT-839" },
          });
          await replyStatusNotification(csms, 1, "Preparing");
          const start = await csms.waitForCall("StartTransaction");
          expect(start.payload).toMatchObject({
            connectorId: 1,
            idTag: "CHILD-839",
            reservationId: 839,
          });
        },
        { authorizeRemoteTxRequests: false },
      );
    },
    5000,
  );

  it("does not start when the Authorize.conf names another parent", async () => {
    await withStation(
      "CP016-839-OTHER-PARENT",
      async (csms, cp) => {
        await reserveForParent(csms);
        expect(await childStart(csms, 1)).toEqual({ status: "Accepted" });
        const auth = await csms.waitForCall("Authorize");
        csms.replyCallResult(auth.messageId, {
          idTagInfo: { status: "Accepted", parentIdTag: "OTHER-839" },
        });
        await expectNoFrame(csms, isStartTransaction);
        expect(cp.getConnector(1)?.transaction).toBeNull();
        expect(cp.reservationManager.getReservation(839)).toBeDefined();
        // The parent is known now and does not match: Rejected at once,
        // without another Authorize.req.
        expect(
          await csmsCall(csms, "rst-839-again", "RemoteStartTransaction", {
            connectorId: 1,
            idTag: "CHILD-839",
          }),
        ).toEqual({ status: "Rejected" });
        await expectNoFrame(
          csms,
          (f) => f[0] === 2 && f[2] === "Authorize" && f[1] !== auth.messageId,
        );
      },
      { authorizeRemoteTxRequests: false },
    );
  }, 5000);

  it("with AuthorizeRemoteTxRequests, sends a single Authorize.req", async () => {
    await withStation("CP016-839-ONE-AUTHORIZE", async (csms) => {
      await reserveForParent(csms);
      expect(await childStart(csms, 1)).toEqual({ status: "Accepted" });
      const auth = await csms.waitForCall("Authorize");
      csms.replyCallResult(auth.messageId, {
        idTagInfo: { status: "Accepted", parentIdTag: "PARENT-839" },
      });
      await replyStatusNotification(csms, 1, "Preparing");
      await csms.waitForCall("StartTransaction");
      expect(
        csms.received.filter((f) => f[0] === 2 && f[2] === "Authorize"),
      ).toHaveLength(1);
    });
  }, 5000);

  it.each([false, true])(
    "on a connector a scenario is parked on (AuthorizeRemoteTxRequests %p), learns the parent before handing the request over",
    async (authorizeRemoteTxRequests) => {
      await withStation(
        `CP016-839-SCENARIO-${authorizeRemoteTxRequests}`,
        async (csms, cp) => {
          await reserveForParent(csms);
          const got: string[] = [];
          cp.events.on("remoteStartReceived", (d) => got.push(d.tagId));
          cp.registerScenarioHandler(1);
          expect(await childStart(csms, 1)).toEqual({ status: "Accepted" });
          const auth = await csms.waitForCall("Authorize");
          expect(got).toEqual([]);
          csms.replyCallResult(auth.messageId, {
            idTagInfo: { status: "Accepted", parentIdTag: "PARENT-839" },
          });
          for (let i = 0; i < 50 && got.length === 0; i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(got).toEqual(["CHILD-839"]);
          expect(cp.knownParentIdOf("CHILD-839")).toBe("PARENT-839");
          expect(
            csms.received.filter((f) => f[0] === 2 && f[2] === "Authorize"),
          ).toHaveLength(1);
        },
        { authorizeRemoteTxRequests },
      );
    },
    5000,
  );

  it("without a connector, prefers a free connector to the parent's reservation", async () => {
    await withStation(
      "CP016-839-FREE-FIRST",
      async (csms, cp) => {
        await reserveForParent(csms);
        expect(await childStart(csms)).toEqual({ status: "Accepted" });
        await replyStatusNotification(csms, 2, "Preparing");
        const start = await csms.waitForCall("StartTransaction");
        expect(start.payload).toMatchObject({
          connectorId: 2,
          idTag: "CHILD-839",
        });
        expect(
          csms.received.some((f) => f[0] === 2 && f[2] === "Authorize"),
        ).toBe(false);
        expect(cp.reservationManager.getReservation(839)).toBeDefined();
      },
      { authorizeRemoteTxRequests: false, connectors: 2 },
    );
  }, 5000);
});
