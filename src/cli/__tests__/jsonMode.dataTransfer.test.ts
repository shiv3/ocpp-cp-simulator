import { describe, it, expect, vi } from "vitest";
import { handleJsonCommand } from "../jsonMode";
import type { ChargePointService } from "../../data/interfaces/ChargePointService";
import type { FacadeSingleCpTarget } from "../singleCpTarget";
import { OBJ_MAX_BYTES, STR_64K_MAX } from "../../protocol";

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

  it("refuses data that is neither a string nor an object, and treats null as absent", async () => {
    const sendDataTransfer = vi.fn().mockResolvedValue({ status: "Accepted" });
    await expect(
      handleJsonCommand(facadeTarget({ sendDataTransfer }), {
        command: "data_transfer",
        params: { vendorId: "VendorX", data: 42 },
      }),
    ).rejects.toThrow(/data/);
    await handleJsonCommand(facadeTarget({ sendDataTransfer }), {
      command: "data_transfer",
      params: { vendorId: "VendorX", data: null },
    });
    expect(sendDataTransfer).toHaveBeenCalledWith(
      CP_ID,
      "VendorX",
      undefined,
      undefined,
    );
  });

  // #382: the same bounds as the daemon's schema — a string by its length, an
  // object by its serialized length.
  it.each([
    ["a string at the cap", "a".repeat(STR_64K_MAX)],
    ["a quote-heavy string under the cap", '"'.repeat(40_000)],
  ])("accepts %s (#382)", async (_label, data) => {
    const sendDataTransfer = vi.fn().mockResolvedValue({ status: "Accepted" });
    await handleJsonCommand(facadeTarget({ sendDataTransfer }), {
      command: "data_transfer",
      params: { vendorId: "VendorX", data },
    });
    expect(sendDataTransfer).toHaveBeenCalledWith(
      CP_ID,
      "VendorX",
      undefined,
      data,
    );
  });

  it.each([
    ["a string past the cap", "a".repeat(STR_64K_MAX + 1)],
    ["an object past the cap", { blob: "a".repeat(OBJ_MAX_BYTES) }],
  ])("refuses %s (#382)", async (_label, data) => {
    const sendDataTransfer = vi.fn();
    await expect(
      handleJsonCommand(facadeTarget({ sendDataTransfer }), {
        command: "data_transfer",
        params: { vendorId: "VendorX", data },
      }),
    ).rejects.toThrow(/data/);
    expect(sendDataTransfer).not.toHaveBeenCalled();
  });
});
