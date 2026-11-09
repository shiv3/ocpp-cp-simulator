import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";

// Needs a connector model the k6 host does not have: refused at export.
const behavior: Behavior = {
  api: 1,
  id: "uses-connector-hook",
  on: {
    connectorStatus: () => undefined,
    transactionStarted: () => undefined,
  },
};

export default behavior;
