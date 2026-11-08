import { meterFromSoc } from "@/data/hooks/useSocMeterSync";
import type { EVSettings } from "@ocpp-cp-simulator/core/cp/domain/connector/EVSettings";
import type { ChargePointService } from "@ocpp-cp-simulator/client/interfaces/ChargePointService";

/*
 * The connector card's plug in / unplug. A plug-in drives the connector's EV
 * and cable model (#453): an idle Available connector reports Preparing, in
 * any other state the cable is only recorded.
 */
export function plugIn(
  service: ChargePointService,
  cpId: string,
  connectorId: number,
): Promise<void> {
  return service.evPlugIn(cpId, connectorId);
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
