import { meterFromSoc } from "@/data/hooks/useSocMeterSync";
import type { EVSettings } from "@/cp/domain/connector/EVSettings";
import { OCPPStatus } from "@/cp/domain/types/OcppTypes";
import type { ChargePointService } from "@/data/interfaces/ChargePointService";

/*
 * The connector card's plug in / unplug. The simulator's `connectorPlug`
 * scenario node runs a no-op callback (`ScenarioRuntime`'s `onConnectorPlug`);
 * the exported k6 runtime, the other implementation of the same node, sends a
 * StatusNotification: Preparing for a plug-in, Available for a plug-out. The
 * card does what that node means on the wire, through the existing
 * `sendStatusNotification`, so no new service method is needed.
 */
export function plugIn(
  service: ChargePointService,
  cpId: string,
  connectorId: number,
): Promise<void> {
  return service.sendStatusNotification(
    cpId,
    connectorId,
    OCPPStatus.Preparing,
  );
}

export function unplug(
  service: ChargePointService,
  cpId: string,
  connectorId: number,
): Promise<void> {
  return service.sendStatusNotification(
    cpId,
    connectorId,
    OCPPStatus.Available,
  );
}

/**
 * Sets the SoC by hand. With SoC ↔ meter sync on, the connector derives its SoC
 * from the next meter value, so the meter is moved to match (as the former
 * Meter & SoC dialog did); the preference is read at the time of the call.
 */
export async function setSocWithSync(
  service: ChargePointService,
  cpId: string,
  connectorId: number,
  soc: number,
  evSettings: EVSettings,
): Promise<void> {
  await service.setConnectorSoc(cpId, connectorId, soc);
  if (evSettings.batteryCapacityKwh <= 0) return;
  const syncOn = await service.getSocMeterSync(cpId, connectorId);
  if (syncOn) {
    await service.setMeterValue(
      cpId,
      connectorId,
      meterFromSoc(soc, evSettings),
    );
  }
}

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
