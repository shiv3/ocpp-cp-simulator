import { describe, expect, it } from "vitest";
import { actionValidatorV21 } from "../../../../../ocpp/v21";
import { buildV21InboundRegistry } from "../inboundRegistryV21";

const SHARED_ACTIONS = [
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
] as const;

const NET_NEW_CSMS_ACTIONS = [
  "AFRRSignal",
  "AdjustPeriodicEventStream",
  "ChangeTransactionTariff",
  "ClearDERControl",
  "ClearTariffs",
  "GetDERControl",
  "GetPeriodicEventStream",
  "GetTariffs",
  "NotifyAllowedEnergyTransfer",
  "NotifyWebPaymentStarted",
  "RequestBatterySwap",
  "SetDERControl",
  "SetDefaultTariff",
  "UpdateDynamicSchedule",
  "UsePriorityCharging",
] as const;

const SKIPPED_CP_ACTIONS = [
  "BatterySwap",
  "ClosePeriodicEventStream",
  "GetCertificateChainStatus",
  "NotifyDERAlarm",
  "NotifyDERStartStop",
  "NotifyPriorityCharging",
  "NotifySettlement",
  "OpenPeriodicEventStream",
  "PullDynamicScheduleUpdate",
  "ReportDERControl",
  "VatNumberValidation",
] as const;

function responseFor(action: string): unknown {
  const handler = buildV21InboundRegistry().get(action);
  expect(handler).toBeDefined();
  return handler?.handle({}, {} as never).response;
}

describe("buildV21InboundRegistry", () => {
  it("keeps shared CSMS actions with v21 validators and adds only v21 CSMS net-new actions", () => {
    const registry = buildV21InboundRegistry();

    expect(registry.size).toBe(55);
    for (const action of SHARED_ACTIONS) {
      expect(registry.has(action)).toBe(true);
    }
    for (const action of NET_NEW_CSMS_ACTIONS) {
      expect(registry.has(action)).toBe(true);
    }
    for (const action of SKIPPED_CP_ACTIONS) {
      expect(registry.has(action)).toBe(false);
    }

    expect(registry.get("GetVariables")?.validate).toBe(
      actionValidatorV21.GetVariables,
    );
    expect(registry.get("ClearVariableMonitoring")?.validate).toBe(
      actionValidatorV21.ClearVariableMonitoring,
    );
  });

  it("returns Tier-3 acknowledgements for v21 CSMS net-new actions", () => {
    expect(responseFor("AFRRSignal")).toEqual({ status: "Rejected" });
    expect(responseFor("AdjustPeriodicEventStream")).toEqual({
      status: "Rejected",
    });
    expect(responseFor("ChangeTransactionTariff")).toEqual({
      status: "Rejected",
    });
    expect(responseFor("ClearDERControl")).toEqual({
      status: "NotSupported",
    });
    expect(responseFor("ClearTariffs")).toEqual({
      clearTariffsResult: [{ status: "NoTariff" }],
    });
    expect(responseFor("GetDERControl")).toEqual({ status: "NotSupported" });
    expect(responseFor("GetPeriodicEventStream")).toEqual({});
    expect(responseFor("GetTariffs")).toEqual({ status: "NoTariff" });
    expect(responseFor("NotifyAllowedEnergyTransfer")).toEqual({
      status: "Rejected",
    });
    expect(responseFor("NotifyWebPaymentStarted")).toEqual({});
    expect(responseFor("RequestBatterySwap")).toEqual({ status: "Rejected" });
    expect(responseFor("SetDERControl")).toEqual({
      status: "NotSupported",
    });
    expect(responseFor("SetDefaultTariff")).toEqual({ status: "Rejected" });
    expect(responseFor("UpdateDynamicSchedule")).toEqual({
      status: "Rejected",
    });
    expect(responseFor("UsePriorityCharging")).toEqual({
      status: "NoProfile",
    });
  });
});
