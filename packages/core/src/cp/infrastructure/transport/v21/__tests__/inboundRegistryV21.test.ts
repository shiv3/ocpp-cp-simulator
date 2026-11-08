import { describe, expect, it } from "vitest";
import { actionValidatorV21 } from "@ocpp-cp-sim/ocpp/v21/index";
import { buildV21InboundRegistry } from "../inboundRegistryV21";
import type { V201HandlerResult } from "../../v201/inboundRegistryV201";

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

function callErrorFor(action: string): unknown {
  const handler = buildV21InboundRegistry().get(action);
  expect(handler).toBeDefined();
  return (handler?.handle({}, {} as never) as V201HandlerResult | undefined)
    ?.callError;
}

function responseFor(action: string): unknown {
  const handler = buildV21InboundRegistry().get(action);
  expect(handler).toBeDefined();
  // These Tier-3 handlers answer synchronously.
  return (handler?.handle({}, {} as never) as V201HandlerResult | undefined)
    ?.response;
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

  it("answers SetDefaultTariff and ChangeTransactionTariff with CALLERROR NotSupported (I07.FR.01, I11.FR.01)", () => {
    for (const action of ["SetDefaultTariff", "ChangeTransactionTariff"]) {
      expect(callErrorFor(action)).toMatchObject({ code: "NotSupported" });
    }
  });

  it("returns Tier-3 acknowledgements for v21 CSMS net-new actions", () => {
    expect(responseFor("AFRRSignal")).toEqual({ status: "Rejected" });
    expect(responseFor("AdjustPeriodicEventStream")).toEqual({
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
    expect(responseFor("UpdateDynamicSchedule")).toEqual({
      status: "Rejected",
    });
  });

  describe("UsePriorityCharging (K21)", () => {
    const answer = (
      transactionId: string,
      activate: boolean,
      stopTime: Date | null = null,
    ): unknown => {
      const handler = buildV21InboundRegistry().get("UsePriorityCharging");
      const ctx = {
        chargePoint: {
          connectors: new Map([
            [
              1,
              {
                hasRunningTransaction: stopTime === null,
                transaction: { cpTransactionId: "tx-1", stopTime },
              },
            ],
          ]),
        },
      };
      return (
        handler?.handle({ transactionId, activate }, ctx as never) as
          V201HandlerResult | undefined
      )?.response;
    };

    it("is Rejected / TxNotFound for a transaction that is not ongoing (K21.FR.02)", () => {
      expect(answer("tx-9", true)).toEqual({
        status: "Rejected",
        statusInfo: { reasonCode: "TxNotFound" },
      });
      expect(answer("tx-9", false)).toEqual({
        status: "Rejected",
        statusInfo: { reasonCode: "TxNotFound" },
      });
    });

    it("is Rejected / TxNotFound for a transaction that has ended but is still attached (K21.FR.02)", () => {
      expect(answer("tx-1", true, new Date())).toEqual({
        status: "Rejected",
        statusInfo: { reasonCode: "TxNotFound" },
      });
    });

    it("is NoProfile for an ongoing transaction and activate = true (K21.FR.01)", () => {
      expect(answer("tx-1", true)).toEqual({
        status: "NoProfile",
        statusInfo: { reasonCode: "NotFound" },
      });
    });

    it("is Accepted for an ongoing transaction and activate = false (K21.FR.06)", () => {
      expect(answer("tx-1", false)).toEqual({ status: "Accepted" });
    });
  });
});
