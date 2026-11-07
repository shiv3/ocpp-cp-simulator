/* eslint-disable @typescript-eslint/no-explicit-any */
// vitest: one real runBehaviorIteration over a fake k6 WebSocket.
import { describe, expect, it, vi } from "vitest";

const { FakeWs, sockets } = vi.hoisted(() => {
  const sockets: any[] = [];
  class FakeWs {
    sent: string[] = [];
    private listeners: Record<string, Array<(e: any) => void>> = {};
    constructor(public url: string) {
      sockets.push(this);
      setTimeout(() => this.emit("open", {}), 0);
    }
    addEventListener(t: string, f: (e: any) => void) {
      (this.listeners[t] ??= []).push(f);
    }
    emit(t: string, e: any) {
      for (const f of this.listeners[t] ?? []) f(e);
    }
    send(raw: string) {
      if (this.closed) throw new Error("closed");
      this.sent.push(raw);
      const [, id, action] = JSON.parse(raw);
      const payload =
        action === "BootNotification"
          ? {
              status: "Accepted",
              currentTime: "2026-01-01T00:00:00Z",
              interval: 300,
            }
          : {};
      setTimeout(
        () => this.emit("message", { data: JSON.stringify([3, id, payload]) }),
        0,
      );
    }
    closed = false;
    close() {
      if (this.closed) return;
      this.closed = true;
      setTimeout(() => this.emit("close", { code: 1000 }), 0);
    }
  }
  return { FakeWs, sockets };
});
vi.mock("k6", () => ({ check: () => true }));
vi.mock("k6/websockets", () => ({ WebSocket: FakeWs }));
vi.mock("k6/metrics", () => {
  class M {
    add(): void {}
  }
  return { Trend: M, Counter: M, Rate: M };
});
vi.mock("k6/timers", () => ({
  setTimeout: (f: () => void, ms: number) => setTimeout(f, ms),
  clearTimeout: (i: never) => clearTimeout(i),
  setInterval: (f: () => void, ms: number) => setInterval(f, ms),
  clearInterval: (i: never) => clearInterval(i),
}));
vi.mock("k6/execution", () => ({
  default: {
    scenario: { startTime: Date.now(), name: "" },
    vu: { idInTest: 1 },
  },
}));

import {
  DEFAULT_HOLD_MS,
  runBehaviorIteration,
  stopAtMs,
} from "@ocpp-cp-sim/k6-runtime/behaviorRun";
import { wire16 } from "@ocpp-cp-sim/k6-runtime/wire/v16";

const base = {
  env: {},
  vu: 1,
  url: "ws://x",
  wire: wire16,
  identities: null,
  log: () => undefined,
};

describe("runBehaviorIteration", () => {
  it("C9 a main that throws fails the iteration", async () => {
    const r = await runBehaviorIteration({
      ...base,
      behaviors: [
        {
          api: 1,
          id: "b",
          main: async () => {
            throw new Error("the CSMS refused it");
          },
        },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it("C10 a connection the CSMS dropped mid-run fails the iteration", async () => {
    sockets.length = 0;
    const p = runBehaviorIteration({
      ...base,
      env: { RUN_FOR_MS: "60" },
      behaviors: [{ api: 1, id: "b" }],
    });
    await new Promise((res) => setTimeout(res, 20));
    sockets[0]!.closed = true;
    sockets[0]!.emit("close", { code: 1006 });
    const r = await p;
    expect(r.ok).toBe(false);
  });

  it("C11 beforeSend.BootNotification runs (every CALL passes it, the docs say)", async () => {
    sockets.length = 0;
    const seen: string[] = [];
    await runBehaviorIteration({
      ...base,
      env: { RUN_FOR_MS: "5" },
      behaviors: [
        {
          api: 1,
          id: "b",
          beforeSend: {
            BootNotification: (p) => {
              seen.push("boot");
              return { ...p, chargePointModel: "changed" };
            },
          },
        },
      ],
    });
    expect(seen).toEqual(["boot"]);
    expect(sockets[0]!.sent[0]).toContain("changed");
  });

  it("C11b on.callResult sees the BootNotification answer", async () => {
    const seen: string[] = [];
    await runBehaviorIteration({
      ...base,
      env: { RUN_FOR_MS: "5" },
      behaviors: [
        {
          api: 1,
          id: "b",
          on: {
            callResult: (e) => {
              seen.push(e.action);
            },
          },
        },
      ],
    });
    expect(seen).toContain("BootNotification");
  });

  it("C12 default DURATION: the iteration stops before the profile's end", () => {
    // PROFILE steady, no DURATION: buildOptions runs 5m; a main must be stopped.
    expect(stopAtMs({}, 1000, 0, true)).toBe(5 * 60_000 - 2000);
  });
  it("C12b soak default DURATION is 1h", () => {
    expect(stopAtMs({ PROFILE: "soak" }, 1000, 0, true)).toBe(3_600_000 - 2000);
  });
  it("(sound) no main and no limit holds DEFAULT_HOLD_MS", () => {
    expect(DEFAULT_HOLD_MS).toBe(60_000);
  });
});
