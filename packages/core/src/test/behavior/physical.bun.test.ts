import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import { afterEach, describe, expect, test } from "bun:test";
import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import { runBehavior, type BehaviorRun } from "./runBehavior";

let run: BehaviorRun | undefined;
afterEach(async () => {
  await run?.dispose();
  run = undefined;
});

// A driver written as code: it plugs in, authorizes, charges, stops and
// unplugs through the physical verbs of ctx. The verbs go through the same
// transaction default as a console or scenario start.
const driver: Behavior = {
  api: 1,
  id: "driver",
  requires: ["physical"],
  main: async (ctx) => {
    ctx.plugIn(1);
    await ctx.sleep(1_000);
    ctx.startCharging(1, "DRIVER-TAG");
    await ctx.sleep(10_000);
    ctx.stopCharging(1, "Local");
    await ctx.sleep(1_000);
    ctx.unplug(1);
  },
};

describe("physical verbs of ctx", () => {
  test.each(["1.6", "2.0.1"] as const)(
    "a main drives a full session on %s through the engine",
    async (version) => {
      run = await runBehavior({ version, behaviors: [driver] });
      const cp = run.cp;
      await run.advanceInSteps(1_500, 500);
      // The fake CSMS accepts the start; 1.6 moves on to Charging.
      const status = cp.engine.state.connectors["1"].status;
      expect(["Preparing", "Charging"]).toContain(status);
      expect(cp.getConnector(1)?.status).toBe(status);
      expect(cp.engine.state.connectors["1"].transaction?.tagId).toBe(
        "DRIVER-TAG",
      );
      expect(cp.engine.state.connectors["1"].transaction?.stopTime).toBeNull();
      // The state is plain JSON, with the transaction in it.
      const snapshot = cp.engine.snapshot();
      expect(snapshot.connectors["1"].transaction?.startTime).toMatch(/Z$/);

      await run.advanceInSteps(10_000, 500);
      const ended = cp.engine.state.connectors["1"].transaction;
      // stopped: closed and then detached by the stop
      expect(ended).toBeNull();
      await run.advanceInSteps(2_000, 500);
      expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Available);

      const actions = run.callsOf(
        version === "1.6" ? "StartTransaction" : "TransactionEvent",
      );
      expect(actions.length).toBeGreaterThanOrEqual(1);
      if (version === "1.6") {
        expect(run.callsOf("StopTransaction")).toHaveLength(1);
        expect(run.callsOf("StartTransaction")[0].payload).toMatchObject({
          connectorId: 1,
          idTag: "DRIVER-TAG",
        });
      } else {
        const types = run
          .callsOf("TransactionEvent")
          .map((f) => (f.payload as { eventType: string }).eventType);
        expect(types[0]).toBe("Started");
        expect(types).toContain("Ended");
      }
    },
  );

  test("a behavior that does not list physical cannot use the verbs", async () => {
    const sneaky: Behavior = {
      api: 1,
      id: "sneaky",
      main: async (ctx) => {
        ctx.plugIn(1);
      },
    };
    run = await runBehavior({ version: "1.6", behaviors: [sneaky] });
    await run.advance(100);
    expect(run.cp.getConnector(1)?.status).not.toBe("Preparing");
  });
});
