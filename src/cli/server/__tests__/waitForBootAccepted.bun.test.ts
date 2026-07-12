import { describe, it, expect } from "bun:test";
import { ChargePoint } from "../../../cp/domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../cp/domain/types/OcppTypes";
import { waitForBootAccepted } from "../waitForBootAccepted";

/**
 * Issue #174: the CLI startup-scenario path used to call `runScenario()`
 * immediately after the WebSocket connected, racing BootNotification
 * acceptance. `waitForBootAccepted` is the extracted signal the fix waits
 * on before firing a startup scenario. These tests drive a REAL
 * `ChargePoint` (no mocked event emitter, no mocked ChargePoint) through
 * its actual `onBootNotificationAccepted` production code path — the same
 * method `BootNotificationResultHandler` calls when a real
 * BootNotification.conf(Accepted) arrives — and assert the promise
 * behaves correctly around that transition.
 */
function makeChargePoint(id: string): ChargePoint {
  return new ChargePoint(
    id,
    DefaultBootNotification,
    1,
    "ws://127.0.0.1:65534/never", // nothing listens here; never connected
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    {},
  );
}

describe("waitForBootAccepted", () => {
  it("does not resolve before boot is accepted, and resolves promptly once it is", async () => {
    const cp = makeChargePoint("CP001");

    const promise = waitForBootAccepted(cp, 1, { timeoutMs: 5_000 });

    // Still pending: BootNotification hasn't been accepted yet. Race
    // against a short timer rather than the real 5s timeout so a
    // premature resolution fails fast instead of just looking slow.
    const PENDING = Symbol("pending");
    const raceResult = await Promise.race([
      promise,
      new Promise<typeof PENDING>((r) => setTimeout(() => r(PENDING), 20)),
    ]);
    expect(raceResult).toBe(PENDING);

    // Drive the real production boot-accept path.
    cp.onBootNotificationAccepted(new Date().toISOString(), 300);

    const result = await promise;
    expect(result).toBe(true);
  });

  it("resolves immediately when boot was already accepted before the wait started", async () => {
    const cp = makeChargePoint("CP002");
    cp.onBootNotificationAccepted(new Date().toISOString(), 300);

    const start = Date.now();
    const result = await waitForBootAccepted(cp, 1, { timeoutMs: 5_000 });
    expect(result).toBe(true);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("times out and invokes onTimeout when boot is never accepted", async () => {
    const cp = makeChargePoint("CP003");

    let timedOut = false;
    const result = await waitForBootAccepted(cp, 1, {
      timeoutMs: 30,
      onTimeout: () => {
        timedOut = true;
      },
    });

    expect(result).toBe(false);
    expect(timedOut).toBe(true);
  });

  it("still resolves false on timeout when onTimeout throws", async () => {
    const cp = makeChargePoint("CP004");

    const result = await waitForBootAccepted(cp, 1, {
      timeoutMs: 30,
      onTimeout: () => {
        throw new Error("boom");
      },
    });

    expect(result).toBe(false);
  });
});
