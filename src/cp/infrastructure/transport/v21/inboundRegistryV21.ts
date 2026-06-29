import {
  actionValidatorV21,
  isValidAFRRSignalRequestV21,
  isValidAdjustPeriodicEventStreamRequestV21,
  isValidChangeTransactionTariffRequestV21,
  isValidClearDERControlRequestV21,
  isValidClearTariffsRequestV21,
  isValidGetDERControlRequestV21,
  isValidGetPeriodicEventStreamRequestV21,
  isValidGetTariffsRequestV21,
  isValidNotifyAllowedEnergyTransferRequestV21,
  isValidNotifyWebPaymentStartedRequestV21,
  isValidRequestBatterySwapRequestV21,
  isValidSetDERControlRequestV21,
  isValidSetDefaultTariffRequestV21,
  isValidUpdateDynamicScheduleRequestV21,
  isValidUsePriorityChargingRequestV21,
  type AdjustPeriodicEventStreamResponseV21,
  type AFRRSignalResponseV21,
  type ChangeTransactionTariffResponseV21,
  type ClearDERControlResponseV21,
  type ClearTariffsResponseV21,
  type GetDERControlResponseV21,
  type GetPeriodicEventStreamResponseV21,
  type GetTariffsResponseV21,
  type NotifyAllowedEnergyTransferResponseV21,
  type NotifyWebPaymentStartedResponseV21,
  type RequestBatterySwapResponseV21,
  type SetDefaultTariffResponseV21,
  type SetDERControlResponseV21,
  type UpdateDynamicScheduleResponseV21,
  type UsePriorityChargingResponseV21,
} from "../../../../ocpp/v21";
import {
  buildV201InboundRegistry,
  type V201InboundHandler,
  type V201InboundRegistry,
} from "../v201/inboundRegistryV201";

export function buildV21InboundRegistry(): V201InboundRegistry {
  const registry = new Map<string, V201InboundHandler>();

  for (const [action, entry] of buildV201InboundRegistry()) {
    registry.set(action, {
      validate: actionValidatorV21[action] ?? entry.validate,
      handle: entry.handle,
    });
  }

  registry.set("AFRRSignal", {
    validate: isValidAFRRSignalRequestV21,
    handle: () => ({
      response: { status: "Rejected" } satisfies AFRRSignalResponseV21,
    }),
  });

  registry.set("AdjustPeriodicEventStream", {
    validate: isValidAdjustPeriodicEventStreamRequestV21,
    handle: () => ({
      response: {
        status: "Rejected",
      } satisfies AdjustPeriodicEventStreamResponseV21,
    }),
  });

  registry.set("ChangeTransactionTariff", {
    validate: isValidChangeTransactionTariffRequestV21,
    handle: () => ({
      response: {
        status: "Rejected",
      } satisfies ChangeTransactionTariffResponseV21,
    }),
  });

  registry.set("ClearDERControl", {
    validate: isValidClearDERControlRequestV21,
    handle: () => ({
      response: {
        status: "NotSupported",
      } satisfies ClearDERControlResponseV21,
    }),
  });

  registry.set("ClearTariffs", {
    validate: isValidClearTariffsRequestV21,
    handle: () => ({
      response: {
        clearTariffsResult: [
          { status: "NoTariff" },
        ] as ClearTariffsResponseV21["clearTariffsResult"],
      } satisfies ClearTariffsResponseV21,
    }),
  });

  registry.set("GetDERControl", {
    validate: isValidGetDERControlRequestV21,
    handle: () => ({
      response: { status: "NotSupported" } satisfies GetDERControlResponseV21,
    }),
  });

  registry.set("GetPeriodicEventStream", {
    validate: isValidGetPeriodicEventStreamRequestV21,
    handle: () => ({
      response: {} satisfies GetPeriodicEventStreamResponseV21,
    }),
  });

  registry.set("GetTariffs", {
    validate: isValidGetTariffsRequestV21,
    handle: () => ({
      response: { status: "NoTariff" } satisfies GetTariffsResponseV21,
    }),
  });

  registry.set("NotifyAllowedEnergyTransfer", {
    validate: isValidNotifyAllowedEnergyTransferRequestV21,
    handle: () => ({
      response: {
        status: "Rejected",
      } satisfies NotifyAllowedEnergyTransferResponseV21,
    }),
  });

  registry.set("NotifyWebPaymentStarted", {
    validate: isValidNotifyWebPaymentStartedRequestV21,
    handle: () => ({
      response: {} satisfies NotifyWebPaymentStartedResponseV21,
    }),
  });

  registry.set("RequestBatterySwap", {
    validate: isValidRequestBatterySwapRequestV21,
    handle: () => ({
      response: { status: "Rejected" } satisfies RequestBatterySwapResponseV21,
    }),
  });

  registry.set("SetDERControl", {
    validate: isValidSetDERControlRequestV21,
    handle: () => ({
      response: { status: "NotSupported" } satisfies SetDERControlResponseV21,
    }),
  });

  registry.set("SetDefaultTariff", {
    validate: isValidSetDefaultTariffRequestV21,
    handle: () => ({
      response: { status: "Rejected" } satisfies SetDefaultTariffResponseV21,
    }),
  });

  registry.set("UpdateDynamicSchedule", {
    validate: isValidUpdateDynamicScheduleRequestV21,
    handle: () => ({
      response: {
        status: "Rejected",
      } satisfies UpdateDynamicScheduleResponseV21,
    }),
  });

  registry.set("UsePriorityCharging", {
    validate: isValidUsePriorityChargingRequestV21,
    handle: () => ({
      response: {
        status: "NoProfile",
      } satisfies UsePriorityChargingResponseV21,
    }),
  });

  return registry;
}
