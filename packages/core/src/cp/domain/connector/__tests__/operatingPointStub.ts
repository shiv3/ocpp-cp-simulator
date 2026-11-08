import type { EVSettings } from "../EVSettings";
import { resolveOperatingPoint, type OperatingPoint } from "../OperatingPoint";

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
    charging: state.status === "Charging",
    settings: state.evSettings as EVSettings | undefined,
    soc: state.soc,
    transactionInitialSoc: state.transaction?.initialSoc,
    scheduleLimitW,
    activePhases,
    energyOfferSuspended,
  });
}
