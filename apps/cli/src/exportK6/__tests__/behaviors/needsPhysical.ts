// Test input of export-k6 --behavior: a capability the k6 host cannot meet.
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";

export default {
  api: 1,
  id: "needs-physical",
  requires: ["physical"],
  async main() {},
} satisfies Behavior;
