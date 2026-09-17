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

// #348: the JSON-Lines surface reaches sendDataTransfer and returns the
// CSMS's answer as the result line.
describe("JSON-Lines data_transfer (#348)", () => {
  it("forwards vendorId, messageId and data, and returns the answer", async () => {
    const sendDataTransfer = vi
      .fn()
      .mockResolvedValue({ status: "Accepted", data: { echo: 1 } });
    const result = await handleJsonCommand(facadeTarget({ sendDataTransfer }), {
      command: "data_transfer",
      params: { vendorId: "VendorX", messageId: "ping", data: { n: 1 } },
    });
    expect(sendDataTransfer).toHaveBeenCalledWith(CP_ID, "VendorX", "ping", {
      n: 1,
    });
    expect(result).toEqual({ status: "Accepted", data: { echo: 1 } });
  });

  it("requires vendorId", async () => {
    const sendDataTransfer = vi.fn();
    await expect(
      handleJsonCommand(facadeTarget({ sendDataTransfer }), {
        command: "data_transfer",
        params: { messageId: "ping" },
      }),
    ).rejects.toThrow(/vendorId/);
    expect(sendDataTransfer).not.toHaveBeenCalled();
  });
});
