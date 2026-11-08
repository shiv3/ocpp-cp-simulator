import { afterEach, describe, expect, test } from "bun:test";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { runBehavior, type BehaviorRun } from "./runBehavior";

let runs: BehaviorRun[] = [];
afterEach(async () => {
  for (const r of runs) await r.dispose();
  runs = [];
});

// A heartbeat every 10 virtual minutes.
const beat: Behavior = {
  api: 1,
  id: "beat",
  async main(ctx) {
    for (;;) {
      await ctx.sleep(600_000);
      await ctx.send("Heartbeat", {});
    }
  },
};

describe("runBehavior over the in-memory transport", () => {
  test("opens no port and needs no real hop between frames", async () => {
    const run = await runBehavior({ version: "1.6", behaviors: [beat] });
    runs.push(run);
    expect(run.csms.memory).toBe(true);
    expect(run.csms.url).toContain("memory-csms");
    expect(run.csms.openCount).toBe(1);
    const started = performance.now();
    // Six virtual hours in ONE jump: every Heartbeat waits for the (in-memory)
    // answer before the next timer is armed, so this only works if the
    // answer arrives without a real hop.
    await run.advance(6 * 3_600_000);
    expect(run.callsOf("Heartbeat")).toHaveLength(36);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("a CSMS call and a dropped connection work like on a socket", async () => {
    const run = await runBehavior({ version: "1.6" });
    runs.push(run);
    const answer = await run.call("GetConfiguration", {});
    expect(answer.kind).toBe("result");
    run.csms.dropConnection();
    await run.settle();
    expect(run.csms.closeCount).toBe(1);
    expect(run.csms.connected).toBe(false);
  });

  test("the real socket stays available and shows the same frames", async () => {
    const memory = await runBehavior({ version: "1.6", behaviors: [beat] });
    const socket = await runBehavior({
      version: "1.6",
      behaviors: [beat],
      transport: "socket",
    });
    runs.push(memory, socket);
    expect(socket.csms.memory).toBe(false);
    await memory.advanceInSteps(1_200_000, 600_000);
    await socket.advanceInSteps(1_200_000, 600_000);
    expect(memory.effectHash()).toBe(socket.effectHash());
  });

  test("other URLs still reach the real WebSocket", async () => {
    const run = await runBehavior({ version: "1.6" });
    runs.push(run);
    const ws = new WebSocket("ws://127.0.0.1:1/");
    const outcome = await new Promise<string>((resolve) => {
      ws.addEventListener("error", () => resolve("error"));
      ws.addEventListener("close", () => resolve("close"));
      ws.addEventListener("open", () => resolve("open"));
    });
    expect(outcome).not.toBe("open");
  });
});
