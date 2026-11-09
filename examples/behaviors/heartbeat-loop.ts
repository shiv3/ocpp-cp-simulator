// A template behavior with a `main`: every few seconds, send a Heartbeat and a
// StatusNotification-free "ping" through the normal path, until the station
// stops. Works on the simulator and on k6 (`export-k6 --behavior`).
//
//   ocpp-cp-sim --cp-id CP001 --ws-url ws://localhost:9000 \
//     --behavior examples/behaviors/heartbeat-loop.ts
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";

/** Milliseconds between two heartbeats. */
const PERIOD_MS = 1000;

export const heartbeatLoop: Behavior = {
  api: 1,
  id: "heartbeat-loop",
  async main(ctx) {
    while (!ctx.stopping) {
      await ctx.sleep(PERIOD_MS);
      await ctx.send("Heartbeat", {});
      ctx.state.beats = Number(ctx.state.beats ?? 0) + 1;
    }
  },
};

export default heartbeatLoop;
