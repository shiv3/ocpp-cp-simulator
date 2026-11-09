// A behavior whose `main` waits on something the host does not own: a promise
// that never settles. Stage D2 uses it to check that an iteration still ends.
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";

export const hang: Behavior = {
  api: 1,
  id: "hang",
  async main() {
    await new Promise<void>(() => undefined);
  },
};

export default hang;
