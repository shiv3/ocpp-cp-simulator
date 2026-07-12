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

function buildChargePoint(): ChargePoint {
  return new ChargePoint(
    "test-cp-181",
    bootNotification,
    1,
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

describe("ChargePoint.authorizeAndWait (#181)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the idTagInfo.status from the tagId-matched authorizeResult event", async () => {
    const cp = buildChargePoint();
    const promise = cp.authorizeAndWait("TAG-A", 5000);
    cp.notifyAuthorizeResult("TAG-A", "Blocked");
    await expect(promise).resolves.toBe("Blocked");
  });

  it("ignores authorizeResult events for a different tagId", async () => {
    const cp = buildChargePoint();
    const promise = cp.authorizeAndWait("TAG-A", 5000);
    cp.notifyAuthorizeResult("TAG-OTHER", "Accepted");
    cp.notifyAuthorizeResult("TAG-A", "Expired");
    await expect(promise).resolves.toBe("Expired");
  });

  it("cleans up its listeners once resolved via the event", async () => {
    const cp = buildChargePoint();
    const promise = cp.authorizeAndWait("TAG-A", 5000);
    cp.notifyAuthorizeResult("TAG-A", "Accepted");
    await promise;
    expect(cp.events.listenerCount("authorizeResult")).toBe(0);
    expect(cp.events.listenerCount("disconnected")).toBe(0);
  });

  it("times out and resolves 'Accepted' (warn-and-proceed) when no Authorize.conf arrives", async () => {
    vi.useFakeTimers();
    const cp = buildChargePoint();
    const promise = cp.authorizeAndWait("TAG-A", 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBe("Accepted");
    expect(cp.events.listenerCount("authorizeResult")).toBe(0);
  });

  it("resolves 'Accepted' (warn-and-proceed) if disconnected while waiting", async () => {
    const cp = buildChargePoint();
    const promise = cp.authorizeAndWait("TAG-A", 5000);
    cp.events.emit("disconnected", { code: 1006, reason: "test" });
    await expect(promise).resolves.toBe("Accepted");
    expect(cp.events.listenerCount("authorizeResult")).toBe(0);
  });
});

describe("ChargePoint.startTransaction — local-authorize gate (#181)", () => {
  it("denies the local start on Invalid Authorize.conf: no transaction begun, authorizeDenied emitted", async () => {
    const cp = buildChargePoint();
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
      const cp = buildChargePoint();
      const promise = cp.startTransaction("BAD-TAG", 1);
      cp.notifyAuthorizeResult("BAD-TAG", status);
      const outcome = await promise;
      expect(outcome).toEqual({ started: false, denialStatus: status });
    },
  );

  it("proceeds to start the transaction on Accepted Authorize.conf", async () => {
    const cp = buildChargePoint();
    const connector = cp.getConnector(1)!;

    const promise = cp.startTransaction("GOOD-TAG", 1);
    cp.notifyAuthorizeResult("GOOD-TAG", "Accepted");
    const outcome = await promise;

    expect(outcome).toEqual({ started: true });
    expect(connector.transaction).not.toBeNull();
    expect(connector.status).toBe(OCPPStatus.Preparing);
  });

  it("AuthorizeBeforeLocalStart=false: sends no Authorize.req and starts immediately", async () => {
    const cp = buildChargePoint();
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
    const cp = buildChargePoint();
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
