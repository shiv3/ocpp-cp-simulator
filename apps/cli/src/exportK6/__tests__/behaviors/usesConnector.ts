// Test input of export-k6 --behavior: a snapshot the k6 host cannot give.
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";

export default {
  api: 1,
  id: "uses-connector",
  async main(ctx) {
    const { connector } = ctx;
    connector(1);
  },
} satisfies Behavior;
