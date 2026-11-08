// Test input of export-k6 --behavior: an extend rule.
import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";

export default {
  api: 1,
  id: "extend-mode",
  onCall: {
    Reset: {
      mode: "extend",
      handle(req, ctx) {
        return { response: ctx.defaultBehavior(req) };
      },
    },
  },
} satisfies Behavior;
