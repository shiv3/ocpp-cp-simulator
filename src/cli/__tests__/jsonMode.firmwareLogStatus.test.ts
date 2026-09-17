import { describe, it, expect, vi } from "vitest";
import { handleJsonCommand } from "../jsonMode";
import type { ChargePointService } from "../../data/interfaces/ChargePointService";
import type { FacadeSingleCpTarget } from "../singleCpTarget";

const CP_ID = "bootstrap-cp";

function facadeTarget(
  chargePointService: Partial<ChargePointService>,
): FacadeSingleCpTarget {
  return {
    chargePointService: chargePointService as ChargePointService,
    cpId: CP_ID,
  };
}

// #345: `requestId` rides on firmware_status_notification, and
// log_status_notification exists at all, with its status vocabulary held.
describe("JSON-Lines firmware / log status notifications (#345)", () => {
  it("firmware_status_notification forwards requestId when given, and not otherwise", async () => {
    const sendFirmwareStatusNotification = vi.fn().mockResolvedValue(undefined);
    const target = facadeTarget({ sendFirmwareStatusNotification });
    await handleJsonCommand(target, {
      command: "firmware_status_notification",
      params: { status: "Downloading", requestId: 41 },
    });
    expect(sendFirmwareStatusNotification).toHaveBeenLastCalledWith(
      CP_ID,
      "Downloading",
      41,
    );
    await handleJsonCommand(target, {
      command: "firmware_status_notification",
      params: { status: "Installed" },
    });
    expect(sendFirmwareStatusNotification).toHaveBeenLastCalledWith(
      CP_ID,
      "Installed",
    );
  });

  it("log_status_notification forwards status and requestId", async () => {
    const sendLogStatusNotification = vi.fn().mockResolvedValue(undefined);
    await handleJsonCommand(facadeTarget({ sendLogStatusNotification }), {
      command: "log_status_notification",
      params: { status: "Uploaded", requestId: 12 },
    });
    expect(sendLogStatusNotification).toHaveBeenCalledWith(
      CP_ID,
      "Uploaded",
      12,
    );
  });

  it("log_status_notification rejects a status outside the vocabulary", async () => {
    const sendLogStatusNotification = vi.fn();
    await expect(
      handleJsonCommand(facadeTarget({ sendLogStatusNotification }), {
        command: "log_status_notification",
        params: { status: "Done" },
      }),
    ).rejects.toThrow(/status/);
    expect(sendLogStatusNotification).not.toHaveBeenCalled();
  });
});
