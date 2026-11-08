import { describe, expect, test } from "bun:test";
import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import { runBehavior } from "./runBehavior";

// GetConfiguration has no default behavior, so `extend` is refused at load.
const refused: Behavior = {
  api: 1,
  id: "refused",
  onCall: {
    GetConfiguration: {
      mode: "extend",
      handle: (req, ctx) => ({ response: ctx.defaultBehavior(req) }),
    },
  },
};

// #803: a run that fails before it returns has no `dispose()` for the caller
// to call, so the harness must tear the rig down itself. Otherwise the station
// stays connected and the memory transport's WebSocket patch outlives the test
// file, for every later file of the same `bun test` process.
describe("runBehavior when a behavior is refused at load", () => {
  test("puts the real WebSocket back", async () => {
    const before = globalThis.WebSocket;
    await expect(
      runBehavior({ version: "1.6", behaviors: [refused] }),
    ).rejects.toThrow(/no default behavior to extend/);
    expect(globalThis.WebSocket).toBe(before);
  });

  test("disconnects the station it booted", async () => {
    let station: ChargePoint | undefined;
    await expect(
      runBehavior({
        version: "1.6",
        behaviors: [refused],
        beforeConnect: (cp) => {
          station = cp;
        },
      }),
    ).rejects.toThrow(/no default behavior to extend/);
    expect(station?.isOnline()).toBe(false);
  });
});
