import { describe, expect, it } from "vitest";
import { buildV201InboundRegistry } from "../inboundRegistryV201";

describe("buildV201InboundRegistry", () => {
  it("registers supported inbound CSMS CALL actions", () => {
    const registry = buildV201InboundRegistry();
    const expectedActions = [
      "GetVariables",
      "SetVariables",
      "GetBaseReport",
      "RequestStartTransaction",
      "RequestStopTransaction",
      "GetTransactionStatus",
      "Reset",
      "ChangeAvailability",
      "UnlockConnector",
      "TriggerMessage",
      "ClearCache",
      "ReserveNow",
      "CancelReservation",
      "SetChargingProfile",
      "ClearChargingProfile",
      "GetChargingProfiles",
      "GetCompositeSchedule",
      "GetReport",
      "GetMonitoringReport",
      "SetMonitoringBase",
      "SetMonitoringLevel",
      "SetNetworkProfile",
      "SendLocalList",
      "GetLog",
      "SetDisplayMessage",
      "GetDisplayMessages",
      "ClearDisplayMessage",
      "CustomerInformation",
      "DataTransfer",
      "CertificateSigned",
      "DeleteCertificate",
      "GetInstalledCertificateIds",
      "InstallCertificate",
      "PublishFirmware",
      "UnpublishFirmware",
      "UpdateFirmware",
      "GetLocalListVersion",
      "CostUpdated",
      "SetVariableMonitoring",
      "ClearVariableMonitoring",
    ];

    expect(registry.size).toBe(40);
    expect([...registry.keys()]).toEqual(expectedActions);
    for (const action of [
      "Reset",
      "ChangeAvailability",
      "UnlockConnector",
      "TriggerMessage",
      "ClearCache",
      "ReserveNow",
      "CancelReservation",
      "SetChargingProfile",
      "GetChargingProfiles",
      "SetVariableMonitoring",
      "ClearVariableMonitoring",
    ]) {
      expect(registry.has(action)).toBe(true);
      expect(typeof registry.get(action)?.validate).toBe("function");
    }
  });
});
