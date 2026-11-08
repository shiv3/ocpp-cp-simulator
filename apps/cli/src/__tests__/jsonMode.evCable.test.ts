import { describe, it, expect, vi } from "vitest";
import { handleJsonCommand } from "../jsonMode";
import type { ChargePointService } from "@ocpp-cp-sim/client/interfaces/ChargePointService";
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

// #453: the JSON-Lines surface carries the cable model's two commands; the
// unplug is the existing ev_disconnected.
describe("JSON-Lines ev_plug_in and ev_ready (#453)", () => {
  it("ev_plug_in forwards the connector", async () => {
    const evPlugIn = vi.fn().mockResolvedValue(undefined);
    await handleJsonCommand(facadeTarget({ evPlugIn }), {
      command: "ev_plug_in",
      params: { connector: 1 },
    });
    expect(evPlugIn).toHaveBeenCalledWith(CP_ID, 1);
  });

  it("ev_ready forwards the connector and the flag", async () => {
    const evSetReady = vi.fn().mockResolvedValue(undefined);
    await handleJsonCommand(facadeTarget({ evSetReady }), {
      command: "ev_ready",
      params: { connector: 2, ready: false },
    });
    expect(evSetReady).toHaveBeenCalledWith(CP_ID, 2, false);
  });

  it("refuses connector 0 and a missing ready", async () => {
    const evPlugIn = vi.fn().mockResolvedValue(undefined);
    const evSetReady = vi.fn().mockResolvedValue(undefined);
    const target = facadeTarget({ evPlugIn, evSetReady });
    await expect(
      handleJsonCommand(target, {
        command: "ev_plug_in",
        params: { connector: 0 },
      }),
    ).rejects.toThrow(/connector/);
    await expect(
      handleJsonCommand(target, {
        command: "ev_ready",
        params: { connector: 1 },
      }),
    ).rejects.toThrow(/ready/);
    expect(evPlugIn).not.toHaveBeenCalled();
    expect(evSetReady).not.toHaveBeenCalled();
  });
});
