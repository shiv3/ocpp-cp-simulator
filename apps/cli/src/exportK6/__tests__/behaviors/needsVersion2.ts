// Test input of export-k6 --behavior: OCPP 2.x only.
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";

export default {
  api: 1,
  id: "needs-2x",
  requires: ["ocpp2.x"],
  async main() {},
} satisfies Behavior;
