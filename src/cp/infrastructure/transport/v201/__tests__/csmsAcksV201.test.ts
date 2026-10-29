import { describe, expect, it } from "vitest";
import {
  handleCostUpdatedAckV201,
  handleDataTransferAckV201,
  handleGetLocalListVersionAckV201,
  handleUnpublishFirmwareAckV201,
} from "../csmsAcksV201";

// SetVariableMonitoring / ClearVariableMonitoring left this file when they
// became stateful (#457): see variableMonitoringV201.test.ts.
describe("csmsAcksV201", () => {
  it("returns representative Tier-3 schema-valid static responses", () => {
    expect(handleGetLocalListVersionAckV201().response).toEqual({
      versionNumber: 0,
    });
    expect(handleCostUpdatedAckV201().response).toEqual({});
    expect(handleDataTransferAckV201().response).toEqual({
      status: "UnknownVendorId",
    });
    expect(handleUnpublishFirmwareAckV201().response).toEqual({
      status: "NoFirmware",
    });
  });
});
