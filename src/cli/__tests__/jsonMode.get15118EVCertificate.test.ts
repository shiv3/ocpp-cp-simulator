import { describe, expect, it, vi } from "vitest";

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

const REQUEST = {
  iso15118SchemaVersion: "urn:iso:std:iso:15118:-20:CommonMessages",
  action: "Install",
  exiRequest: "AAAA",
  maximumContractCertificateChains: 2,
  prioritizedEMAIDs: ["DE8ACC12345678"],
};

// #537: the JSON-Lines surface reaches the Get15118EVCertificate relay and
// returns the CSMS's answers as the result line.
describe("JSON-Lines get_15118_ev_certificate (#537)", () => {
  it("forwards the request and returns the answers", async () => {
    const answer = { responses: [{ status: "Accepted", exiResponse: "BBBB" }] };
    const get15118EVCertificate = vi.fn().mockResolvedValue(answer);

    const result = await handleJsonCommand(
      facadeTarget({ get15118EVCertificate }),
      { command: "get_15118_ev_certificate", params: REQUEST },
    );

    expect(result).toEqual(answer);
    expect(get15118EVCertificate).toHaveBeenCalledWith(CP_ID, REQUEST);
  });

  it.each([
    ["a non-base64 exiRequest", { ...REQUEST, exiRequest: "not base64!" }],
    ["an unknown action", { ...REQUEST, action: "Delete" }],
    [
      "a missing iso15118SchemaVersion",
      { ...REQUEST, iso15118SchemaVersion: undefined },
    ],
  ])("refuses %s before reaching the station", async (_label, params) => {
    const get15118EVCertificate = vi.fn();
    await expect(
      handleJsonCommand(facadeTarget({ get15118EVCertificate }), {
        command: "get_15118_ev_certificate",
        params,
      }),
    ).rejects.toThrow(/Missing or invalid parameter/);
    expect(get15118EVCertificate).not.toHaveBeenCalled();
  });
});
