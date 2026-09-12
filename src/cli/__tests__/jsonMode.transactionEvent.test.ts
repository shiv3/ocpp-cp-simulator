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

// #335: the JSON-Lines surface must carry the same parameters the RPC
// table declares, validated against the OCPP vocabularies rather than
// passed through as free strings.
describe("JSON-Lines transaction parameters (#335)", () => {
  it("start_transaction forwards triggerReason and chargingState", async () => {
    const startTransaction = vi.fn().mockResolvedValue(undefined);
    await handleJsonCommand(facadeTarget({ startTransaction }), {
      command: "start_transaction",
      params: {
        connector: 1,
        tagId: "TAG",
        triggerReason: "CablePluggedIn",
        chargingState: "EVConnected",
      },
    });
    expect(startTransaction).toHaveBeenCalledWith(CP_ID, 1, "TAG", {
      triggerReason: "CablePluggedIn",
      chargingState: "EVConnected",
    });
  });

  it("start_transaction without the new fields passes an empty option set", async () => {
    const startTransaction = vi.fn().mockResolvedValue(undefined);
    await handleJsonCommand(facadeTarget({ startTransaction }), {
      command: "start_transaction",
      params: { connector: 1, tagId: "TAG" },
    });
    expect(startTransaction).toHaveBeenCalledWith(CP_ID, 1, "TAG", {
      triggerReason: undefined,
      chargingState: undefined,
    });
  });

  it("stop_transaction forwards reason and triggerReason", async () => {
    const stopTransaction = vi.fn().mockResolvedValue(undefined);
    await handleJsonCommand(facadeTarget({ stopTransaction }), {
      command: "stop_transaction",
      params: {
        connector: 2,
        reason: "SOCLimitReached",
        triggerReason: "EnergyLimitReached",
      },
    });
    expect(stopTransaction).toHaveBeenCalledWith(CP_ID, 2, {
      reason: "SOCLimitReached",
      triggerReason: "EnergyLimitReached",
    });
  });

  it("transaction_event forwards every field and requires triggerReason", async () => {
    const sendTransactionUpdate = vi.fn().mockResolvedValue(undefined);
    const target = facadeTarget({ sendTransactionUpdate });
    await handleJsonCommand(target, {
      command: "transaction_event",
      params: {
        connector: 1,
        triggerReason: "MeterValuePeriodic",
        chargingState: "Charging",
        meterValues: true,
        context: "Sample.Clock",
      },
    });
    expect(sendTransactionUpdate).toHaveBeenCalledWith(CP_ID, 1, {
      triggerReason: "MeterValuePeriodic",
      chargingState: "Charging",
      meterValues: true,
      context: "Sample.Clock",
    });

    await expect(
      handleJsonCommand(target, {
        command: "transaction_event",
        params: { connector: 1 },
      }),
    ).rejects.toThrow(/triggerReason \(expected one of Authorized, /);
  });

  it("rejects a value outside the OCPP vocabulary and names the spelling that works", async () => {
    const stopTransaction = vi.fn();
    await expect(
      handleJsonCommand(facadeTarget({ stopTransaction }), {
        command: "stop_transaction",
        params: { connector: 1, reason: "EvDisconnected" },
      }),
    ).rejects.toThrow(/reason \(expected one of .*EVDisconnected/);
    expect(stopTransaction).not.toHaveBeenCalled();
  });

  it("send_meter_value forwards the ReadingContext", async () => {
    const sendMeterValue = vi.fn().mockResolvedValue(undefined);
    await handleJsonCommand(facadeTarget({ sendMeterValue }), {
      command: "send_meter_value",
      params: { connector: 1, context: "Trigger" },
    });
    expect(sendMeterValue).toHaveBeenCalledWith(CP_ID, 1, "Trigger");
  });
});
