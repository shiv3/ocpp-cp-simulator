import type {
  ClearVariableMonitoringRequestV201,
  SetVariableMonitoringRequestV201,
} from "../../../../../ocpp";
import { describe, expect, it } from "vitest";
import {
  handleClearVariableMonitoringAckV201,
  handleCostUpdatedAckV201,
  handleDataTransferAckV201,
  handleGetChargingProfilesAckV201,
  handleGetCompositeScheduleAckV201,
  handleGetLocalListVersionAckV201,
  handleGetReportAckV201,
  handleSetChargingProfileAckV201,
  handleSetVariableMonitoringAckV201,
  handleUnpublishFirmwareAckV201,
} from "../csmsAcksV201";

describe("csmsAcksV201", () => {
  it("returns representative Tier-3 schema-valid static responses", () => {
    expect(handleSetChargingProfileAckV201().response).toEqual({
      status: "Rejected",
    });
    expect(handleGetChargingProfilesAckV201().response).toEqual({
      status: "NoProfiles",
    });
    expect(handleGetCompositeScheduleAckV201().response).toEqual({
      status: "Rejected",
    });
    expect(handleGetReportAckV201().response).toEqual({
      status: "EmptyResultSet",
    });
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

  it("rejects variable monitoring requests while echoing monitored targets", () => {
    const request: SetVariableMonitoringRequestV201 = {
      setMonitoringData: [
        {
          value: 10,
          type: "UpperThreshold",
          severity: 5,
          component: { name: "ChargingStation" },
          variable: { name: "Available" },
        },
        {
          value: 20,
          type: "Delta",
          severity: 7,
          component: { name: "EVSE", evse: { id: 1, connectorId: 1 } },
          variable: { name: "Voltage", instance: "L1" },
        },
      ],
    };

    expect(handleSetVariableMonitoringAckV201(request).response).toEqual({
      setMonitoringResult: [
        {
          status: "Rejected",
          type: "UpperThreshold",
          component: { name: "ChargingStation" },
          variable: { name: "Available" },
          severity: 5,
        },
        {
          status: "Rejected",
          type: "Delta",
          component: { name: "EVSE", evse: { id: 1, connectorId: 1 } },
          variable: { name: "Voltage", instance: "L1" },
          severity: 7,
        },
      ],
    });
  });

  it("reports clear variable monitoring ids as not found", () => {
    const request: ClearVariableMonitoringRequestV201 = {
      id: [101, 202],
    };

    expect(handleClearVariableMonitoringAckV201(request).response).toEqual({
      clearMonitoringResult: [
        { status: "NotFound", id: 101 },
        { status: "NotFound", id: 202 },
      ],
    });
  });
});
