import { describe, expect, it } from "bun:test";
import type { TransactionEventRequestV201 } from "../../../../ocpp";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { answerTo, startMockCsms, type MockCsms } from "./mockCsms";
import { bootedChargePoint, callOf } from "./stationHarness";

/**
 * #452 on the 2.x wire (2.0.1 Part 2 C10, C11; 2.1 shares the handler):
 * AuthorizeResponse and TransactionEventResponse idTokenInfo fill the
 * Authorization Cache (C10.FR.04/.05), cacheExpiryDateTime included, and
 * ClearCache answers per C11.
 */

const VERSIONS = ["OCPP-2.0.1", "OCPP-2.1"] as const;

async function waitUntil(cond: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A heartbeat round trip: once its answer is processed, any answer sent
 *  before it has been too. */
async function sentinel(csms: MockCsms, cp: ChargePoint): Promise<void> {
  cp.sendHeartbeat();
  const heartbeat = await csms.waitForCall("Heartbeat");
  csms.replyCallResult(heartbeat.messageId, {
    currentTime: new Date().toISOString(),
  });
  await new Promise((r) => setTimeout(r, 50));
}

async function withStation(
  version: string,
  id: string,
  body: (csms: MockCsms, cp: ChargePoint) => Promise<void>,
): Promise<void> {
  const csms = startMockCsms();
  const cp = await bootedChargePoint(csms, id, version);
  try {
    await body(csms, cp);
  } finally {
    cp.disconnect();
    await csms.stop();
  }
}

describe.each(VERSIONS)("%s Authorization Cache (#452)", (version) => {
  it("AuthorizeResponse fills the cache, then LocalPreAuthorize skips Authorize (C10.FR.04, C12.FR.02)", async () => {
    await withStation(version, `CP-${version}-CACHE-AUTH`, async (csms, cp) => {
      cp.configuration.applyChange("AuthorizationCacheEnabled", "true");
      const pending = cp.authorizeAndWait("TAG-C");
      const call = await csms.waitForCall("Authorize");
      csms.replyCallResult(call.messageId, {
        idTokenInfo: {
          status: "Accepted",
          cacheExpiryDateTime: "2099-01-01T00:00:00.000Z",
          groupIdToken: { idToken: "GROUP-1", type: "Central" },
        },
      });
      expect(await pending).toBe("Accepted");
      expect(cp.authorization.cache.get("TAG-C")).toMatchObject({
        status: "Accepted",
        expiresAt: Date.parse("2099-01-01T00:00:00.000Z"),
        parentId: "GROUP-1",
      });

      cp.configuration.applyChange("LocalPreAuthorize", "true");
      expect(await cp.authorizeAndWait("TAG-C")).toBe("Accepted");
      expect(csms.received.filter(callOf("Authorize"))).toHaveLength(1);
    });
  });

  it("an entry past its cacheExpiryDateTime is not used (C10.FR.10, C10.FR.13)", async () => {
    await withStation(version, `CP-${version}-CACHE-EXP`, async (csms, cp) => {
      cp.configuration.applyChange("AuthorizationCacheEnabled", "true");
      cp.configuration.applyChange("LocalPreAuthorize", "true");
      const pending = cp.authorizeAndWait("TAG-E");
      const first = await csms.waitForCall("Authorize");
      csms.replyCallResult(first.messageId, {
        idTokenInfo: {
          status: "Accepted",
          cacheExpiryDateTime: "2000-01-01T00:00:00.000Z",
        },
      });
      expect(await pending).toBe("Accepted");

      // Expired in the cache: online, the CSMS is asked again (C10.FR.03).
      const again = cp.authorizeAndWait("TAG-E");
      await waitUntil(
        () => csms.received.filter(callOf("Authorize")).length === 2,
      );
      const second = csms.received.filter(callOf("Authorize"))[1];
      csms.replyCallResult(second[1] as string, {
        idTokenInfo: { status: "Invalid" },
      });
      expect(await again).toBe("Invalid");
      expect(cp.authorization.cache.get("TAG-E")?.status).toBe("Invalid");
    });
  });

  it("writes nothing while AuthCacheCtrlr.Enabled is false (default)", async () => {
    await withStation(version, `CP-${version}-CACHE-OFF`, async (csms, cp) => {
      const pending = cp.authorizeAndWait("TAG-OFF");
      const call = await csms.waitForCall("Authorize");
      csms.replyCallResult(call.messageId, {
        idTokenInfo: { status: "Accepted" },
      });
      expect(await pending).toBe("Accepted");
      expect(cp.authorization.cache.size()).toBe(0);
    });
  });

  it("does not cache the Invalid synthesized from a CALLERROR", async () => {
    await withStation(version, `CP-${version}-CACHE-ERR`, async (csms, cp) => {
      cp.configuration.applyChange("AuthorizationCacheEnabled", "true");
      const pending = cp.authorizeAndWait("TAG-ERR");
      const call = await csms.waitForCall("Authorize");
      csms.send([4, call.messageId, "InternalError", "boom", {}]);
      expect(await pending).toBe("Invalid");
      expect(cp.authorization.cache.size()).toBe(0);
    });
  });

  it.each(["Accepted", "Blocked"])(
    "TransactionEventResponse idTokenInfo %s fills the cache (C10.FR.05)",
    async (status) => {
      await withStation(
        version,
        `CP-${version}-CACHE-TX-${status}`,
        async (csms, cp) => {
          cp.configuration.applyChange("AuthorizationCacheEnabled", "true");
          cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
          cp.configuration.applyChange("StopTransactionOnInvalidId", "false");
          void cp.startTransaction("TAG-TX", 1);
          const started = await csms.waitForFrame(
            (f) =>
              f[0] === 2 &&
              f[2] === "TransactionEvent" &&
              (f[3] as TransactionEventRequestV201).eventType === "Started",
          );
          csms.replyCallResult(started[1] as string, {
            idTokenInfo: { status },
          });
          await sentinel(csms, cp);
          expect(cp.authorization.cache.get("TAG-TX")?.status).toBe(status);
        },
      );
    },
  );

  it("ClearCache answers Rejected under the default configuration (C11.FR.04)", async () => {
    await withStation(version, `CP-${version}-CLEAR-OFF`, async (csms) => {
      csms.send([2, "cc-452", "ClearCache", {}]);
      const answer = await csms.waitForFrame(answerTo("cc-452"));
      expect(answer).toEqual([3, "cc-452", { status: "Rejected" }]);
    });
  });

  it("ClearCache clears an enabled cache and answers Accepted (C11.FR.03)", async () => {
    await withStation(version, `CP-${version}-CLEAR-ON`, async (csms, cp) => {
      cp.configuration.applyChange("AuthorizationCacheEnabled", "true");
      cp.recordAuthorizationResult("TAG-X", { status: "Accepted" });
      csms.send([2, "cc-452", "ClearCache", {}]);
      const answer = await csms.waitForFrame(answerTo("cc-452"));
      expect(answer).toEqual([3, "cc-452", { status: "Accepted" }]);
      expect(cp.authorization.cache.size()).toBe(0);
    });
  });
});
