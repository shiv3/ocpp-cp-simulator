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

// #452: the JSON-Lines surface reaches the Authorization Cache seam and
// validates the seed with the control plane's own schema.
describe("JSON-Lines authorization cache (#452)", () => {
  it("reads the cache", async () => {
    const view = { enabled: true, entries: [] };
    const getAuthorizationCache = vi.fn().mockResolvedValue(view);
    const result = await handleJsonCommand(
      facadeTarget({ getAuthorizationCache }),
      { command: "get_auth_cache", params: {} },
    );
    expect(getAuthorizationCache).toHaveBeenCalledWith(CP_ID);
    expect(result).toEqual(view);
  });

  it("seeds the cache and reports the count", async () => {
    const seedAuthorizationCache = vi.fn().mockResolvedValue(1);
    const entries = [
      { idToken: "T", status: "Blocked", expiresAt: "2099-01-01T00:00:00Z" },
    ];
    const result = await handleJsonCommand(
      facadeTarget({ seedAuthorizationCache }),
      { command: "seed_auth_cache", params: { entries } },
    );
    expect(seedAuthorizationCache).toHaveBeenCalledWith(CP_ID, entries);
    expect(result).toEqual({ seeded: 1 });
  });

  it.each([
    ["no entries", {}],
    ["an unknown status", { entries: [{ idToken: "T", status: "Maybe" }] }],
    [
      "a duplicate idToken",
      {
        entries: [
          { idToken: "T", status: "Accepted" },
          { idToken: "T", status: "Blocked" },
        ],
      },
    ],
  ])("refuses %s without calling the service", async (_label, params) => {
    const seedAuthorizationCache = vi.fn();
    await expect(
      handleJsonCommand(facadeTarget({ seedAuthorizationCache }), {
        command: "seed_auth_cache",
        params,
      }),
    ).rejects.toThrow(/entries/);
    expect(seedAuthorizationCache).not.toHaveBeenCalled();
  });

  it("clears the cache", async () => {
    const clearAuthorizationCache = vi.fn().mockResolvedValue(true);
    const result = await handleJsonCommand(
      facadeTarget({ clearAuthorizationCache }),
      { command: "clear_auth_cache", params: {} },
    );
    expect(clearAuthorizationCache).toHaveBeenCalledWith(CP_ID);
    expect(result).toEqual({ cleared: true });
  });
});
