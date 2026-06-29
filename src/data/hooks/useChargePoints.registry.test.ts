/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChargePointSnapshot } from "../interfaces/ChargePointService";
import type { RemoteRegistrySubscriptionEvent } from "../remote/RemoteChargePointService";

interface HookHarness {
  readonly state: any[];
  readonly effects: Array<() => void | (() => void)>;
  beginRender(): void;
}

function createHookHarness(): HookHarness {
  const state: any[] = [];
  const effects: Array<() => void | (() => void)> = [];
  let cursor = 0;

  vi.doMock("react", () => ({
    useState: (initial: any) => {
      const slot = cursor++;
      if (state.length <= slot) {
        state[slot] = typeof initial === "function" ? initial() : initial;
      }
      const setState = (next: any) => {
        state[slot] = typeof next === "function" ? next(state[slot]) : next;
      };
      return [state[slot], setState];
    },
    useCallback: (fn: any) => fn,
    useEffect: (effect: () => void | (() => void)) => {
      effects.push(effect);
    },
  }));

  return {
    state,
    effects,
    beginRender() {
      cursor = 0;
      effects.splice(0);
    },
  };
}

function cp(id: string, status = "Available"): ChargePointSnapshot {
  return {
    id,
    status: status as ChargePointSnapshot["status"],
    error: "",
    connectors: [],
    config: {
      wsUrl: "ws://example.test/ocpp",
      connectors: 1,
      vendor: "Vendor",
      model: "Model",
      basicAuth: null,
      bootNotification: null,
    },
  };
}

describe("useChargePoints remote registry subscription", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("populates from snapshot, updates from registry events, and schedules no timer", async () => {
    const harness = createHookHarness();
    let registryHandler:
      | ((event: RemoteRegistrySubscriptionEvent) => void)
      | null = null;
    const unsubscribe = vi.fn();
    const service = {
      listChargePoints: vi.fn(),
      subscribeRegistry: vi.fn(
        (handler: (event: RemoteRegistrySubscriptionEvent) => void) => {
          registryHandler = handler;
          return unsubscribe;
        },
      ),
    };
    vi.doMock("../providers/DataProvider", () => ({
      useDataContext: () => ({
        chargePointService: service,
        mode: "remote",
      }),
    }));
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const { useChargePoints } = await import("./useChargePoints");

    harness.beginRender();
    const result = useChargePoints(null);
    expect(result.chargePoints).toEqual([]);
    const cleanup = harness.effects[0]();

    expect(service.subscribeRegistry).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(registryHandler).not.toBeNull();
    const emitRegistry = (event: RemoteRegistrySubscriptionEvent) => {
      if (!registryHandler) throw new Error("registry handler was not set");
      registryHandler(event);
    };

    emitRegistry({ type: "snapshot", cps: [cp("cp-1")] });
    expect(
      harness.state[0].map((item: ChargePointSnapshot) => item.id),
    ).toEqual(["cp-1"]);

    emitRegistry({
      type: "change",
      change: "updated",
      cp: cp("cp-2", "Charging"),
    });
    expect(
      harness.state[0].map((item: ChargePointSnapshot) => item.id),
    ).toEqual(["cp-1", "cp-2"]);

    emitRegistry({
      type: "change",
      change: "updated",
      cp: cp("cp-1", "Unavailable"),
    });
    expect(harness.state[0][0].status).toBe("Unavailable");

    emitRegistry({
      type: "change",
      change: "removed",
      cp: cp("cp-1"),
    });
    expect(
      harness.state[0].map((item: ChargePointSnapshot) => item.id),
    ).toEqual(["cp-2"]);

    emitRegistry({ type: "change", change: "reset" });
    expect(harness.state[0]).toEqual([]);

    if (typeof cleanup === "function") cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
