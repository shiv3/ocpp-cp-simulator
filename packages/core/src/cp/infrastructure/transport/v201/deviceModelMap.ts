// Device Model lookup for the 2.x handlers (GetVariables, SetVariables,
// SetVariableMonitoring). The definitions live in the registry,
// `domain/device-model/DeviceModelRegistry.ts` (#604); this file resolves a
// request's component / variable / evse onto a registry entry and the
// ConfigurationStore key behind it.
import { evseValueKey } from "../../../domain/charge-point/runtimeValueKeys";
import {
  DEVICE_MODEL,
  type DeviceModelRegistry,
  type DeviceModelVariableDef,
} from "../../../domain/device-model/DeviceModelRegistry";

export interface DeviceModelEvse {
  readonly id: number;
  readonly connectorId?: number;
}

export type DeviceModelResolution =
  | { readonly status: "UnknownComponent" }
  | { readonly status: "UnknownVariable" }
  | {
      readonly status: "Found";
      /** The ConfigurationStore key (per-EVSE for an EVSE-scoped variable). */
      readonly valueKey: string;
      readonly variable: DeviceModelVariableDef;
    };

/**
 * The registry entry and configuration key behind `component.variable[instance]`,
 * EVSE scope included (#538). An EVSE-scoped component (EVSE, Connector) is
 * only found with an `evse` the station has (B06.FR.06, N04.FR.03); without
 * `evseExists` the station has none. A station-wide component ignores
 * `component.evse` here, as GetVariables / SetVariables always did.
 */
export function resolveDeviceModelVariable(
  component: { readonly name: string; readonly evse?: DeviceModelEvse },
  variable: { readonly name: string; readonly instance?: string },
  evseExists: (evse: DeviceModelEvse) => boolean = () => false,
  registry: DeviceModelRegistry = DEVICE_MODEL,
): DeviceModelResolution {
  if (!registry.hasComponent(component.name)) {
    return { status: "UnknownComponent" };
  }
  if (registry.isEvseScoped(component.name)) {
    if (component.evse === undefined || !evseExists(component.evse)) {
      return { status: "UnknownComponent" };
    }
    // An EVSE-scoped variable has no instances.
    const def = registry.find(component.name, variable.name);
    return def === undefined
      ? { status: "UnknownVariable" }
      : {
          status: "Found",
          valueKey: evseValueKey(def.valueKey, component.evse.id),
          variable: def,
        };
  }
  const def = registry.find(component.name, variable.name, variable.instance);
  return def === undefined
    ? { status: "UnknownVariable" }
    : { status: "Found", valueKey: def.valueKey, variable: def };
}
