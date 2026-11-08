import { afterEach, describe, expect, it, vi } from "vitest";
import { ChargePoint } from "../ChargePoint";
import { DefaultBootNotification } from "../../types/OcppTypes";
import { V201_VARIABLE_TO_V16_KEY } from "../../../infrastructure/transport/v201/deviceModelMap";
import type { ReconnectPolicy } from "../../../shared/ReconnectPolicy";

// #609: the policy reaches the transport, 2.x RetryBackOff* variables are
// registered, and giving up is an event (and a timeline entry).

function build(
  version: string,
  reconnect?: Partial<ReconnectPolicy>,
  seed?: string,
  id = "cp-609",
): ChargePoint {
  return new ChargePoint(
    id,
    DefaultBootNotification,
    1,
    "ws://localhost:8080",
    null,
    null,
    null,
    {},
    [],
    version,
    reconnect ? { reconnect } : {},
    undefined,
    undefined,
    undefined,
    undefined,
    seed === undefined ? {} : { seed },
  );
}

describe("ChargePoint reconnect policy (#609)", () => {
  afterEach(() => vi.useRealTimers());

  it("hands the policy to the transport", () => {
    const cp = build("OCPP-1.6J", { maxAttempts: 3, mode: "fixed" });
    expect(cp["_webSocket"]!.reconnectPolicy).toMatchObject({
      maxAttempts: 3,
      mode: "fixed",
      baseDelayMs: 1000,
    });
  });

  it("refuses an invalid policy at construction", () => {
    expect(() => build("OCPP-1.6J", { maxAttempts: -5 })).toThrow(
      /maxAttempts/,
    );
  });

  it("registers RetryBackOff* on 2.x only, mapped to OCPPCommCtrlr", () => {
    for (const name of [
      "RetryBackOffWaitMinimum",
      "RetryBackOffRandomRange",
      "RetryBackOffRepeatTimes",
    ]) {
      expect(V201_VARIABLE_TO_V16_KEY.get(`OCPPCommCtrlr/${name}`)).toBe(name);
    }
    const v2 = build("OCPP-2.0.1");
    expect(v2.configuration.retryBackOffWaitMinimum()).toBe(1);
    expect(v2.configuration.retryBackOffRandomRange()).toBe(0);
    expect(v2.configuration.retryBackOffRepeatTimes()).toBe(5);
    const v16 = build("OCPP-1.6J");
    expect(v16.configuration.get("RetryBackOffWaitMinimum")).toBeUndefined();
  });

  it("derives the 2.x variable defaults from the policy", () => {
    const cp = build("OCPP-2.0.1", {
      baseDelayMs: 4000,
      maxDelayMs: 64000,
      jitterMs: 2500,
    });
    expect(cp.configuration.retryBackOffWaitMinimum()).toBe(4);
    expect(cp.configuration.retryBackOffRandomRange()).toBe(3);
    expect(cp.configuration.retryBackOffRepeatTimes()).toBe(4);
  });

  it("a SetVariables-style change reaches the transport", () => {
    const cp = build("OCPP-2.0.1");
    expect(cp.configuration.applyChange("RetryBackOffWaitMinimum", "7")).toBe(
      "Accepted",
    );
    cp.configuration.applyChange("RetryBackOffRepeatTimes", "2");
    expect(cp["_webSocket"]!["_retryBackOff"]).toEqual({
      waitMinimumSeconds: 7,
      randomRangeSeconds: 0,
      repeatTimes: 2,
    });
    expect(
      cp.configuration.applyChange("RetryBackOffWaitMinimum", "0"),
    ).not.toBe("Accepted");
  });

  // Neither the CLI nor cp.create sets a simulation seed, so a charge point
  // without one seeds its jitter from its id.
  const jitterDelays = (seed?: string, id?: string) => {
    const cp = build("OCPP-1.6J", { jitterMs: 5000 }, seed, id);
    const out: number[] = [];
    cp.events.on("reconnecting", ({ delayMs }) => out.push(delayMs));
    for (let i = 0; i < 3; i++) {
      cp["_webSocket"]!["_pendingReconnectNotice"] = null;
      cp["_webSocket"]!["attemptReconnect"]();
      cp["_webSocket"]!.observers.emit(
        "reconnectScheduled",
        cp["_webSocket"]!["_pendingReconnectNotice"]!,
      );
    }
    cp["_webSocket"]!.dispose();
    return out;
  };

  it("without a simulation seed the jitter is seeded by the charge point id", () => {
    const a = jitterDelays(undefined, "CP-A");
    expect(jitterDelays(undefined, "CP-A")).toEqual(a);
    expect(jitterDelays(undefined, "CP-B")).not.toEqual(a);
    expect(new Set(a).size).toBeGreaterThan(1);
  });

  it("jitter is seeded: the same seed replays the same delays", () => {
    const delays = (seed: string) => {
      const cp = build("OCPP-1.6J", { jitterMs: 5000 }, seed);
      const out: number[] = [];
      cp.events.on("reconnecting", ({ delayMs }) => out.push(delayMs));
      for (let i = 0; i < 3; i++) {
        cp["_webSocket"]!["_pendingReconnectNotice"] = null;
        cp["_webSocket"]!["attemptReconnect"]();
        cp["_webSocket"]!.observers.emit(
          "reconnectScheduled",
          cp["_webSocket"]!["_pendingReconnectNotice"]!,
        );
      }
      cp["_webSocket"]!.dispose();
      return out;
    };
    const a = delays("s1");
    expect(delays("s1")).toEqual(a);
    expect(delays("s2")).not.toEqual(a);
    expect(a[0]).toBeGreaterThanOrEqual(1000);
    expect(a[0]).toBeLessThanOrEqual(6000);
  });

  it("re-emits the transport's give-up as gaveUp, and the timeline records it", () => {
    const cp = build("OCPP-1.6J", { maxAttempts: 0 });
    const seen: unknown[] = [];
    cp.events.on("gaveUp", (e) => seen.push(e));

    cp["_webSocket"]!.observers.emit("reconnectGaveUp", { attempts: 4 });

    expect(seen).toEqual([{ target: "reconnect", attempts: 4 }]);
    const entry = cp.timeline.query().entries.at(-1)!;
    expect(entry.kind).toBe("gave_up");
    expect(entry.data).toEqual({ target: "reconnect", attempts: 4 });
  });

  describe("BootNotification retry limit", () => {
    const rejected = (cp: ChargePoint) =>
      cp.onBootNotificationResult({
        status: "Rejected",
        interval: 10,
        currentTime: new Date().toISOString(),
      });

    it("retries forever by default", () => {
      vi.useFakeTimers();
      const cp = build("OCPP-1.6J");
      const boot = vi.spyOn(cp, "boot").mockImplementation(() => {});
      for (let i = 0; i < 5; i++) {
        rejected(cp);
        vi.advanceTimersByTime(10_000);
      }
      expect(boot).toHaveBeenCalledTimes(5);
    });

    it("stops after bootRetryLimit re-sends and reports it once", () => {
      vi.useFakeTimers();
      const cp = build("OCPP-1.6J", { bootRetryLimit: 2 });
      const boot = vi.spyOn(cp, "boot").mockImplementation(() => {});
      const seen: unknown[] = [];
      cp.events.on("gaveUp", (e) => seen.push(e));

      // The first answer and two re-sends' answers; the third gives up.
      for (let i = 0; i < 3; i++) {
        rejected(cp);
        vi.advanceTimersByTime(10_000);
      }

      expect(boot).toHaveBeenCalledTimes(2);
      expect(seen).toEqual([{ target: "boot_notification", attempts: 2 }]);
    });

    it("records the give-up after the Rejected answer that caused it", () => {
      vi.useFakeTimers();
      const cp = build("OCPP-1.6J", { bootRetryLimit: 0 });
      vi.spyOn(cp, "boot").mockImplementation(() => {});
      const order: string[] = [];
      cp.events.on("bootNotificationResult", () => order.push("result"));
      cp.events.on("gaveUp", () => order.push("gaveUp"));
      rejected(cp);
      expect(order).toEqual(["result", "gaveUp"]);
    });

    it("a new connection restores the budget", () => {
      vi.useFakeTimers();
      const cp = build("OCPP-1.6J", { bootRetryLimit: 1 });
      const boot = vi.spyOn(cp, "boot").mockImplementation(() => {});
      let onOpen: (() => void) | undefined;
      vi.spyOn(cp["_webSocket"]!, "connect").mockImplementation((open) => {
        onOpen = open ?? undefined;
      });
      const seen: unknown[] = [];
      cp.events.on("gaveUp", (e) => seen.push(e));

      rejected(cp);
      vi.advanceTimersByTime(10_000);
      rejected(cp); // gives up
      expect(seen).toHaveLength(1);

      cp.connect();
      onOpen?.();
      expect(boot).toHaveBeenCalledTimes(2); // re-send + the new connection's
      rejected(cp);
      vi.advanceTimersByTime(10_000);
      expect(boot).toHaveBeenCalledTimes(3); // budget is back: it re-sends
      expect(seen).toHaveLength(1);
    });

    it("an Accepted answer restores the budget", () => {
      vi.useFakeTimers();
      const cp = build("OCPP-1.6J", { bootRetryLimit: 1 });
      const boot = vi.spyOn(cp, "boot").mockImplementation(() => {});
      rejected(cp);
      vi.advanceTimersByTime(10_000);
      cp.onBootNotificationResult({
        status: "Accepted",
        interval: 300,
        currentTime: new Date().toISOString(),
      });
      rejected(cp);
      vi.advanceTimersByTime(10_000);
      expect(boot).toHaveBeenCalledTimes(2);
    });
  });
});
