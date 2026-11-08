import { describe, expect, it } from "vitest";
import {
  handleCancelReservationV201,
  handleChangeAvailabilityV201,
  handleReserveNowV201,
  handleResetV201,
  handleTriggerMessageV201,
  handleUnlockConnectorV201,
} from "../coreControlV201";

describe("core-control v201 handlers", () => {
  // ClearCache reads the charge point (#452): see clearCacheV201.test.ts.
  it("returns schema-valid ack statuses", () => {
    const cases = [
      ["Reset", handleResetV201, "Accepted"],
      ["ChangeAvailability", handleChangeAvailabilityV201, "Accepted"],
      ["UnlockConnector", handleUnlockConnectorV201, "Unlocked"],
      ["TriggerMessage", handleTriggerMessageV201, "Accepted"],
      ["ReserveNow", handleReserveNowV201, "Accepted"],
      ["CancelReservation", handleCancelReservationV201, "Accepted"],
    ] as const;

    for (const [action, handler, status] of cases) {
      expect(handler(), action).toEqual({ response: { status } });
    }
  });
});

describe("TriggerMessage(BootNotification) (F06.FR.17)", () => {
  const payload = { requestedMessage: "BootNotification" };
  const ctx = (bootAccepted?: () => boolean) => ({ bootAccepted }) as never;

  it("is Rejected, with nothing to send, after an Accepted boot", () => {
    const result = handleTriggerMessageV201(
      payload,
      ctx(() => true),
    );
    expect(result).toEqual({ response: { status: "Rejected" } });
  });

  it("stays Accepted while the boot is not Accepted", () => {
    const result = handleTriggerMessageV201(
      payload,
      ctx(() => false),
    );
    expect(result.response).toEqual({ status: "Accepted" });
    expect(result.afterResult).toBeDefined();
  });
});
