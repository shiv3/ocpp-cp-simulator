import type { EVSettings, EVSettingsPatch } from "./EVSettings";

/**
 * The part of {@link EVSettings} a *vehicle* determines (#327, #311): the car
 * itself, not the session (opening and target SoC) and not the electrical
 * values a car does not determine (voltage, power factor).
 *
 * This is the one definition of that slice. A vehicle profile resolves to it
 * (`resolveEvSettings`, `VehicleEvSettings` is its strict form), the
 * auto-traffic vehicle pool carries it, and `Connector.operatingPoint()` reads
 * it back out of the connector's EV settings (`vehicleTermOf`), so the traffic
 * generator and the meter model cannot be given two different vehicles for
 * one connector: both go through {@link vehicleSettingsPatch}.
 *
 * Protocol-agnostic like `OperatingPoint.ts`: no transport or `ocpp/` import.
 */
export type VehicleSettings = Pick<
  EVSettings,
  "modelName" | "batteryCapacityKwh" | "maxChargingPowerKw"
> &
  Partial<
    Pick<EVSettings, "chargingCurve" | "currentType" | "phases" | "attribution">
  >;

/**
 * The EV settings patch that makes a connector this vehicle. Replaces the
 * previous vehicle whole: a field the vehicle lacks is removed (`null`) or
 * reset to its explicit "none" (`[]` for the curve), never left to the vehicle
 * before it, because the connector merges a patch into its settings (see
 * `applyVehicleSettings`, docs/concepts/vehicle-profiles.md).
 */
export function vehicleSettingsPatch(
  vehicle: VehicleSettings,
): EVSettingsPatch {
  return {
    modelName: vehicle.modelName,
    batteryCapacityKwh: vehicle.batteryCapacityKwh,
    maxChargingPowerKw: vehicle.maxChargingPowerKw,
    chargingCurve: vehicle.chargingCurve ?? [],
    currentType: vehicle.currentType ?? null,
    phases: vehicle.phases ?? null,
    attribution: vehicle.attribution ?? null,
  };
}
