import { afterEach, describe, expect, it, vi } from "vitest";
import { ChargePoint } from "../ChargePoint";
import { OCPPStatus } from "../../types/OcppTypes";
import type { BootNotification } from "../../types/OcppTypes";
import { DefaultBootNotification } from "../../types/OcppTypes";

/**
 * Issue #181: `ChargePoint.authorizeAndWait` gives `startTransaction` a way
 * to send Authorize.req and await the matching Authorize.conf before a
 * LOCAL (non-remote-start) transaction begins. AuthorizeResultHandler has
 * no direct handle on the request's tagId (AuthorizeResponseV16 carries
 * none), so correlation happens via the `authorizeResult` event — emitted
 * here directly (`cp.notifyAuthorizeResult`) as the test seam, mirroring
 * what AuthorizeResultHandler does once the real CALLRESULT arrives.
 */

const bootNotification: BootNotification = DefaultBootNotification;

function buildChargePoint(connectorCount = 1): ChargePoint {
  return new ChargePoint(
    "test-cp-181",
    bootNotification,
    connectorCount,
    "ws://localhost:8080",
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    {},
  );
}

/** The CP built here never opens its socket, so it is offline. #452 makes
 *  an offline start decide locally; the #181 tests below are about the
 *  online round trip, so they declare the CP online. */
function online(cp: ChargePoint): ChargePoint {
  vi.spyOn(cp, "isOnline").mockReturnValue(true);
  return cp;
}

// Long-lived subscribers (the #448 timeline projector) listen too; what
// matters is that authorizeAndWait leaves no listener of its own behind.
function listenerCounts(cp: ChargePoint) {
  return {
    authorizeResult: cp.events.listenerCount("authorizeResult"),
    disconnected: cp.events.listenerCount("disconnected"),
  };
}

describe("ChargePoint.authorizeAndWait (#181)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the idTagInfo.status from the tagId-matched authorizeResult event", async () => {
    const cp = online(buildChargePoint());
    const promise = cp.authorizeAndWait("TAG-A", 5000);
    cp.notifyAuthorizeResult("TAG-A", "Blocked");
    await expect(promise).resolves.toBe("Blocked");
  });

  it("ignores authorizeResult events for a different tagId", async () => {
    const cp = online(buildChargePoint());
    const promise = cp.authorizeAndWait("TAG-A", 5000);
    cp.notifyAuthorizeResult("TAG-OTHER", "Accepted");
    cp.notifyAuthorizeResult("TAG-A", "Expired");
    await expect(promise).resolves.toBe("Expired");
  });

  it("cleans up its listeners once resolved via the event", async () => {
    const cp = online(buildChargePoint());
    const baseline = listenerCounts(cp);
    const promise = cp.authorizeAndWait("TAG-A", 5000);
    cp.notifyAuthorizeResult("TAG-A", "Accepted");
    await promise;
    expect(listenerCounts(cp)).toEqual(baseline);
  });

  // Online with no answer is unchanged by #452: still warn-and-proceed.
  it("times out and resolves 'Accepted' (warn-and-proceed) when no Authorize.conf arrives", async () => {
    vi.useFakeTimers();
    const cp = online(buildChargePoint());
    const baseline = listenerCounts(cp);
    const promise = cp.authorizeAndWait("TAG-A", 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBe("Accepted");
    expect(listenerCounts(cp)).toEqual(baseline);
  });

  // #452: a disconnect while waiting leaves the CP offline, so the offline
  // rules decide (1.6 §3.5.4) instead of the former fail-open "Accepted".
  it("applies the offline rules if disconnected while waiting: unknown tag refused by default", async () => {
    const cp = online(buildChargePoint());
    const baseline = listenerCounts(cp);
    const promise = cp.authorizeAndWait("TAG-A", 5000);
    cp.events.emit("disconnected", { code: 1006, reason: "test" });
    await expect(promise).resolves.toBe("Invalid");
    expect(listenerCounts(cp)).toEqual(baseline);
  });

  it("applies the offline rules if disconnected while waiting: AllowOfflineTxForUnknownId=true accepts", async () => {
    const cp = online(buildChargePoint());
    cp.configuration.applyChange("AllowOfflineTxForUnknownId", "true");
    const promise = cp.authorizeAndWait("TAG-A", 5000);
    cp.events.emit("disconnected", { code: 1006, reason: "test" });
    await expect(promise).resolves.toBe("Accepted");
  });
});

describe("ChargePoint.startTransaction — local-authorize gate (#181)", () => {
  it("denies the local start on Invalid Authorize.conf: no transaction begun, authorizeDenied emitted", async () => {
    const cp = online(buildChargePoint());
    const connector = cp.getConnector(1)!;
    const denied: Array<{
      connectorId: number;
      tagId: string;
      status: string;
    }> = [];
    cp.events.on("authorizeDenied", (e) => denied.push(e));

    const promise = cp.startTransaction("BAD-TAG", 1);
    cp.notifyAuthorizeResult("BAD-TAG", "Invalid");
    const outcome = await promise;

    expect(outcome).toEqual({ started: false, denialStatus: "Invalid" });
    expect(connector.transaction).toBeNull();
    expect(denied).toEqual([
      { connectorId: 1, tagId: "BAD-TAG", status: "Invalid" },
    ]);
  });

  it.each(["Expired", "Blocked"] as const)(
    "denies the local start on %s Authorize.conf",
    async (status) => {
      const cp = online(buildChargePoint());
      const promise = cp.startTransaction("BAD-TAG", 1);
      cp.notifyAuthorizeResult("BAD-TAG", status);
      const outcome = await promise;
      expect(outcome).toEqual({ started: false, denialStatus: status });
    },
  );

  it("proceeds to start the transaction on Accepted Authorize.conf", async () => {
    const cp = online(buildChargePoint());
    const connector = cp.getConnector(1)!;

    const promise = cp.startTransaction("GOOD-TAG", 1);
    cp.notifyAuthorizeResult("GOOD-TAG", "Accepted");
    const outcome = await promise;

    expect(outcome).toEqual({ started: true });
    expect(connector.transaction).not.toBeNull();
    expect(connector.status).toBe(OCPPStatus.Preparing);
  });

  it("AuthorizeBeforeLocalStart=false: sends no Authorize.req and starts immediately", async () => {
    const cp = online(buildChargePoint());
    const applyStatus = cp.configuration.applyChange(
      "AuthorizeBeforeLocalStart",
      "false",
    );
    expect(applyStatus).toBe("Accepted");
    const authorizeSpy = vi.spyOn(cp, "authorize");
    const connector = cp.getConnector(1)!;

    const outcome = await cp.startTransaction("ANY-TAG", 1);

    expect(authorizeSpy).not.toHaveBeenCalled();
    expect(outcome).toEqual({ started: true });
    expect(connector.transaction).not.toBeNull();
    expect(connector.status).toBe(OCPPStatus.Preparing);
  });

  it("skips the gate for a RemoteStart-triggered start (triggerReason='RemoteStart')", async () => {
    const cp = online(buildChargePoint());
    const authorizeSpy = vi.spyOn(cp, "authorize");
    const connector = cp.getConnector(1)!;

    const outcome = await cp.startTransaction(
      "REMOTE-TAG",
      1,
      undefined,
      undefined,
      { triggerReason: "RemoteStart" },
    );

    expect(authorizeSpy).not.toHaveBeenCalled();
    expect(outcome).toEqual({ started: true });
    expect(connector.transaction).not.toBeNull();
  });
});

/**
 * Issue #452: the local start consults the Local Authorization List and the
 * Authorization Cache (OCPP 1.6 Part 2 §3.5) before, or instead of, the
 * Authorize round trip. `recordAuthorizationResult` is the seam the 1.6
 * Authorize/StartTransaction/StopTransaction result handlers feed.
 */
describe("ChargePoint.startTransaction — local authorization (#452)", () => {
  const LIMITS = { localAuthListMaxLength: 100, sendLocalListMaxLength: 100 };

  function deniedEvents(cp: ChargePoint) {
    const denied: Array<{
      connectorId: number;
      tagId: string;
      status: string;
    }> = [];
    cp.events.on("authorizeDenied", (e) => denied.push(e));
    return denied;
  }

  function enableCache(cp: ChargePoint) {
    expect(
      cp.configuration.applyChange("AuthorizationCacheEnabled", "true"),
    ).toBe("Accepted");
  }

  it("online: Authorize.conf fills the cache, then LocalPreAuthorize starts without Authorize.req (issue test 1)", async () => {
    const cp = online(buildChargePoint(2));
    enableCache(cp);
    cp.configuration.applyChange("LocalPreAuthorize", "true");
    const authorizeSpy = vi.spyOn(cp, "authorize");

    const first = cp.startTransaction("TAG-A", 1);
    cp.recordAuthorizationResult("TAG-A", { status: "Accepted" });
    cp.notifyAuthorizeResult("TAG-A", "Accepted");
    expect(await first).toEqual({ started: true });
    expect(authorizeSpy).toHaveBeenCalledTimes(1);

    expect(await cp.startTransaction("TAG-A", 2)).toEqual({ started: true });
    expect(authorizeSpy).toHaveBeenCalledTimes(1);
    expect(cp.getConnector(2)!.transaction?.tagId).toBe("TAG-A");
  });

  it("online with LocalPreAuthorize=false still sends Authorize.req for a cached tag", async () => {
    const cp = online(buildChargePoint());
    enableCache(cp);
    cp.recordAuthorizationResult("TAG-A", { status: "Accepted" });
    const authorizeSpy = vi.spyOn(cp, "authorize");

    const promise = cp.startTransaction("TAG-A", 1);
    expect(authorizeSpy).toHaveBeenCalledWith("TAG-A");
    cp.notifyAuthorizeResult("TAG-A", "Accepted");
    expect(await promise).toEqual({ started: true });
  });

  it("cache disabled: nothing is cached and every start asks the CSMS (issue test 2)", async () => {
    const cp = online(buildChargePoint());
    cp.configuration.applyChange("LocalPreAuthorize", "true");
    cp.recordAuthorizationResult("TAG-A", { status: "Accepted" });
    expect(cp.authorization.cache.size()).toBe(0);
    const authorizeSpy = vi.spyOn(cp, "authorize");

    const promise = cp.startTransaction("TAG-A", 1);
    expect(authorizeSpy).toHaveBeenCalledWith("TAG-A");
    cp.notifyAuthorizeResult("TAG-A", "Accepted");
    expect(await promise).toEqual({ started: true });
  });

  it("expired cached tag: online asks the CSMS, offline refuses it as Expired (issue test 3)", async () => {
    const cp = buildChargePoint();
    enableCache(cp);
    cp.configuration.applyChange("LocalPreAuthorize", "true");
    cp.configuration.applyChange("AllowOfflineTxForUnknownId", "true");
    cp.recordAuthorizationResult("TAG-OLD", {
      status: "Accepted",
      expiresAt: Date.now() - 1000,
    });
    const denied = deniedEvents(cp);
    const isOnline = vi.spyOn(cp, "isOnline").mockReturnValue(false);

    expect(await cp.startTransaction("TAG-OLD", 1)).toEqual({
      started: false,
      denialStatus: "Expired",
    });
    expect(denied).toEqual([
      { connectorId: 1, tagId: "TAG-OLD", status: "Expired" },
    ]);

    isOnline.mockReturnValue(true);
    const authorizeSpy = vi.spyOn(cp, "authorize");
    const promise = cp.startTransaction("TAG-OLD", 1);
    expect(authorizeSpy).toHaveBeenCalledWith("TAG-OLD");
    cp.notifyAuthorizeResult("TAG-OLD", "Accepted");
    expect(await promise).toEqual({ started: true });
  });

  it("offline with a cached Accepted tag: starts at once, no Authorize.req (issue test 5)", async () => {
    const cp = buildChargePoint();
    enableCache(cp);
    cp.recordAuthorizationResult("TAG-A", { status: "Accepted" });
    const authorizeSpy = vi.spyOn(cp, "authorize");

    expect(cp.isOnline()).toBe(false);
    expect(await cp.startTransaction("TAG-A", 1)).toEqual({ started: true });
    expect(authorizeSpy).not.toHaveBeenCalled();
  });

  it("offline with a local-list Accepted tag: starts at once (§9.1.12)", async () => {
    const cp = buildChargePoint();
    cp.localAuthListManager.applyFull(
      1,
      [{ idTag: "LISTED", idTagInfo: { status: "Accepted" } }],
      LIMITS,
    );
    expect(await cp.startTransaction("LISTED", 1)).toEqual({ started: true });
  });

  it("offline with an unknown tag: refused by default, no 10 s stall (issue test 6, plan deviation 3)", async () => {
    const cp = buildChargePoint();
    const denied = deniedEvents(cp);
    const authorizeSpy = vi.spyOn(cp, "authorize");

    expect(await cp.startTransaction("STRANGER", 1)).toEqual({
      started: false,
      denialStatus: "Invalid",
    });
    expect(authorizeSpy).not.toHaveBeenCalled();
    expect(cp.getConnector(1)!.transaction).toBeNull();
    expect(denied).toEqual([
      { connectorId: 1, tagId: "STRANGER", status: "Invalid" },
    ]);
  });

  it("offline with an unknown tag and AllowOfflineTxForUnknownId=true: starts, and the tag is not cached (C15.FR.01)", async () => {
    const cp = buildChargePoint();
    enableCache(cp);
    cp.configuration.applyChange("AllowOfflineTxForUnknownId", "true");

    expect(await cp.startTransaction("STRANGER", 1)).toEqual({
      started: true,
    });
    expect(cp.authorization.cache.get("STRANGER")).toBeUndefined();
  });

  it("local list wins over the cache: listed Blocked refuses a cached Accepted tag (issue test 7)", async () => {
    const cp = buildChargePoint();
    enableCache(cp);
    cp.recordAuthorizationResult("TAG-A", { status: "Accepted" });
    cp.localAuthListManager.applyFull(
      1,
      [{ idTag: "TAG-A", idTagInfo: { status: "Blocked" } }],
      LIMITS,
    );

    expect(await cp.startTransaction("TAG-A", 1)).toEqual({
      started: false,
      denialStatus: "Blocked",
    });
    // §3.5.3: a listed identifier is never (re)written to the cache.
    cp.recordAuthorizationResult("TAG-A", { status: "Invalid" });
    expect(cp.authorization.cache.get("TAG-A")?.status).toBe("Accepted");
  });

  it("AuthorizeBeforeLocalStart=false bypasses the local decision too: offline unknown starts as before", async () => {
    const cp = buildChargePoint();
    cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
    expect(await cp.startTransaction("STRANGER", 1)).toEqual({
      started: true,
    });
  });
});
