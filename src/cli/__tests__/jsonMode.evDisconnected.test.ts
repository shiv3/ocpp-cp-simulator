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

// #488: the JSON-Lines surface carries the EV-side disconnect the RPC table
// declares, with the same connector rule (>= 1).
describe("JSON-Lines ev_disconnected (#488)", () => {
  it("forwards the connector to the service", async () => {
    const evDisconnected = vi.fn().mockResolvedValue(undefined);
    await handleJsonCommand(facadeTarget({ evDisconnected }), {
      command: "ev_disconnected",
      params: { connector: 2 },
    });
    expect(evDisconnected).toHaveBeenCalledWith(CP_ID, 2);
  });

  it("refuses connector 0", async () => {
    const evDisconnected = vi.fn().mockResolvedValue(undefined);
    await expect(
      handleJsonCommand(facadeTarget({ evDisconnected }), {
        command: "ev_disconnected",
        params: { connector: 0 },
      }),
    ).rejects.toThrow(/connector/);
    expect(evDisconnected).not.toHaveBeenCalled();
  });
});
