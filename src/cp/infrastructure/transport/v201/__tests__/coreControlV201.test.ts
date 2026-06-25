import { describe, expect, it } from "vitest";
import {
  handleCancelReservationV201,
  handleChangeAvailabilityV201,
  handleClearCacheV201,
  handleReserveNowV201,
  handleResetV201,
  handleTriggerMessageV201,
  handleUnlockConnectorV201,
} from "../coreControlV201";

describe("core-control v201 handlers", () => {
  it("returns schema-valid ack statuses", () => {
    const cases = [
      ["Reset", handleResetV201, "Accepted"],
      ["ChangeAvailability", handleChangeAvailabilityV201, "Accepted"],
      ["UnlockConnector", handleUnlockConnectorV201, "Unlocked"],
      ["TriggerMessage", handleTriggerMessageV201, "Accepted"],
      ["ClearCache", handleClearCacheV201, "Accepted"],
      ["ReserveNow", handleReserveNowV201, "Accepted"],
      ["CancelReservation", handleCancelReservationV201, "Accepted"],
    ] as const;

    for (const [action, handler, status] of cases) {
      expect(handler(), action).toEqual({ response: { status } });
    }
  });
});
