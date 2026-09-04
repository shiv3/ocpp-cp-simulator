import type { Blueprint } from "../../protocol";

/**
 * Read-only hardware profiles, returned by `blueprint.list` alongside stored
 * ones. The authoritative id → hardware mapping is in `README.md`.
 *
 * `wsUrl` is deliberately absent: a blueprint describes hardware, and the CSMS
 * a fleet points at is a property of the run, not of the charge point model.
 * `cp.create_many` requires one alongside `blueprintId`.
 */
export const BUILT_IN_BLUEPRINTS: readonly Blueprint[] = [
  {
    id: "ac-22kw",
    name: "AC 22 kW wallbox",
    description: "Three-phase 22 kW AC wallbox, single outlet.",
    params: { connectors: 1, vendor: "Generic", model: "AC-22" },
    evSettings: { maxChargingPowerKw: 22, batteryCapacityKwh: 60 },
  },
  {
    id: "ac-22kw-x2",
    name: "AC 22 kW, twin outlet",
    description: "Three-phase 22 kW AC unit with two sockets.",
    params: { connectors: 2, vendor: "Generic", model: "AC-22-T2" },
    evSettings: { maxChargingPowerKw: 22, batteryCapacityKwh: 60 },
  },
  {
    id: "dc-50kw",
    name: "DC 50 kW rapid",
    description: "DC rapid charger, two outlets.",
    params: { connectors: 2, vendor: "Generic", model: "DC-50" },
    evSettings: { maxChargingPowerKw: 50, batteryCapacityKwh: 75 },
  },
  {
    id: "dc-150kw",
    name: "DC 150 kW high-power",
    description: "DC high-power charger, two outlets.",
    params: { connectors: 2, vendor: "Generic", model: "DC-150" },
    evSettings: { maxChargingPowerKw: 150, batteryCapacityKwh: 90 },
  },
  {
    id: "dc-350kw",
    name: "DC 350 kW high-power",
    description: "DC high-power charger, four outlets.",
    params: { connectors: 4, vendor: "Generic", model: "DC-350" },
    evSettings: { maxChargingPowerKw: 350, batteryCapacityKwh: 100 },
  },
] as const;

const BUILT_IN_IDS = new Set(BUILT_IN_BLUEPRINTS.map((b) => b.id));

/** Whether an id names a built-in, which may not be overwritten or deleted. */
export function isBuiltInBlueprint(id: string): boolean {
  return BUILT_IN_IDS.has(id);
}
