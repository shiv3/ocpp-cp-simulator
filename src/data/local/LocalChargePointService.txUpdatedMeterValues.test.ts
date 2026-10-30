import { describe, expect, it, vi } from "vitest";

import { parseCreateBody } from "../../cli/server/httpServer";
import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../cp/domain/types/OcppTypes";
import { LocalChargePointService } from "./LocalChargePointService";
import type { LocalChargePointDefinition } from "./LocalChargePointService";

/**
 * #347: the browser runtime honours `txUpdatedMeterValues` like the daemon
 * does, and its meter-value scheduler goes through `sendScheduledMeterValue`.
 */
function localDefinition(
  overrides: Partial<LocalChargePointDefinition> = {},
): LocalChargePointDefinition {
  return {
    id: "CP-LOCAL-347",
    connectorNumber: 1,
    bootNotification: DefaultBootNotification,
    wsUrl: "ws://localhost:9000/ocpp/",
    basicAuth: null,
    autoMeterValueSetting: null,
    ocppVersion: "OCPP-2.0.1",
    ...overrides,
  };
}

function chargePointOf(service: LocalChargePointService, id: string) {
  return (
    service as unknown as {
      getExistingChargePointOrThrow(id: string): ChargePoint;
    }
  ).getExistingChargePointOrThrow(id);
}

describe("LocalChargePointService txUpdatedMeterValues (#347)", () => {
  it("is off unless the definition asks for it", async () => {
    const service = new LocalChargePointService();
    await service.syncLocalChargePoints([localDefinition()]);
    expect(chargePointOf(service, "CP-LOCAL-347").txUpdatedMeterValues).toBe(
      false,
    );
  });

  it("turns it on and routes scheduler ticks through sendScheduledMeterValue", async () => {
    const service = new LocalChargePointService();
    await service.syncLocalChargePoints([
      localDefinition({ txUpdatedMeterValues: true }),
    ]);
    const cp = chargePointOf(service, "CP-LOCAL-347");
    expect(cp.txUpdatedMeterValues).toBe(true);

    const scheduled = vi
      .spyOn(cp, "sendScheduledMeterValue")
      .mockImplementation(() => undefined);
    const plain = vi
      .spyOn(cp, "sendMeterValue")
      .mockImplementation(() => undefined);
    const connector = cp.getConnector(1) as unknown as {
      onMeterSend: ((id: number) => void) | null;
    };
    expect(typeof connector.onMeterSend).toBe("function");
    connector.onMeterSend!(1);
    expect(scheduled).toHaveBeenCalledWith(1);
    expect(plain).not.toHaveBeenCalled();
  });
});

describe("parseCreateBody txUpdatedMeterValues (#347)", () => {
  const base = { cpId: "CP", wsUrl: "ws://localhost:9000/ocpp/" };

  it("keeps true and an explicit false, and omits it when absent", () => {
    expect(
      parseCreateBody({ ...base, txUpdatedMeterValues: true })
        .txUpdatedMeterValues,
    ).toBe(true);
    expect(
      parseCreateBody({ ...base, txUpdatedMeterValues: false })
        .txUpdatedMeterValues,
    ).toBe(false);
    expect("txUpdatedMeterValues" in parseCreateBody(base)).toBe(false);
  });
});
