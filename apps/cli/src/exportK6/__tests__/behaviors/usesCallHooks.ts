import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";

// Everything the k6 host does provide from stage E: it must export.
const behavior: Behavior = {
  api: 1,
  id: "uses-call-hooks",
  on: {
    connected: () => undefined,
    disconnected: () => undefined,
    callResult: () => undefined,
    callReceived: () => undefined,
  },
  beforeSend: { MeterValues: (payload) => payload },
  onCall: {
    Reset: {
      mode: "replace",
      handle: (_r, ctx) => ({ response: ctx.accepted("Reset") }),
    },
  },
};

export default behavior;
