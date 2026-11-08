import type { EVSettings } from "../EVSettings";
import {
  resolveOperatingPoint,
  vehicleTermOf,
  type OperatingPoint,
} from "../OperatingPoint";
import { resolveSessionIntent } from "../SessionIntent";

/** The slice of a connector stub `operatingPoint()` resolves from. */
interface StubState {
  status: string;
  soc: number | null;
  evSettings?: Partial<EVSettings>;
  transaction?: { initialSoc?: number } | null;
}

/**
 * What `Connector.operatingPoint()` returns for a stub: the real pure
 * resolution applied to the stub's own fields, so a test stub cannot drift
 * from the connector's arithmetic (#327).
 */
export function stubOperatingPoint(
  stubThis: object,
  scheduleLimitW: number,
  activePhases: number,
  energyOfferSuspended = false,
): OperatingPoint {
  const state = stubThis as StubState;
  return resolveOperatingPoint({
    at: 0,
    charging: state.status === "Charging",
    soc: state.soc,
    schedule: { scheduleLimitW, activePhases },
    vehicle: vehicleTermOf(state.evSettings as EVSettings | undefined),
    session: {
      initialSoc: resolveSessionIntent(state.transaction, state.evSettings)
        .initialSoc,
    },
    fault: { energyOfferSuspended },
  });
}
