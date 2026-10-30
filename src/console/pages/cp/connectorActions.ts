import { meterFromSoc } from "@/data/hooks/useSocMeterSync";
import type { EVSettings } from "@/cp/domain/connector/EVSettings";
import { OCPPStatus } from "@/cp/domain/types/OcppTypes";
import type { ChargePointService } from "@/data/interfaces/ChargePointService";

/*
 * The connector card's plug in / unplug. A plug-in sends StatusNotification
 * Preparing, as the exported k6 runtime does for a `connectorPlug` plug-in
 * node; the simulator's own node treats a plug-in as a no-op.
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

/**
 * An EV-side disconnect (#488): the station decides what it means. With a
 * running transaction StopTransactionOnEVSideDisconnect stops it
 * (`EVDisconnected`) or suspends it (SuspendedEV); without one the connector
 * goes Available, as this button did before.
 */
export function unplug(
  service: ChargePointService,
  cpId: string,
  connectorId: number,
): Promise<void> {
  return service.evDisconnected(cpId, connectorId);
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
