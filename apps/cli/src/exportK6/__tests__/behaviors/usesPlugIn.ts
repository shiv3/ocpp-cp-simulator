// Test input of export-k6 --behavior: a physical verb.
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";

export default {
  api: 1,
  id: "uses-plug-in",
  async main(ctx) {
    ctx.plugIn(1);
  },
} satisfies Behavior;
