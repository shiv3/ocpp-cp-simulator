import type { Connector } from "../connector/Connector";
import { OCPPStatus } from "../types/OcppTypes";
import type { ChargePoint } from "./ChargePoint";

/**
 * The EVSE side of a `SuspendedEVSE` transaction lifts: a charging limit goes
 * from 0 to above 0, by a schedule period crossing or a Set/ClearChargingProfile
 * (#871). 1.6 §4.9: "If charging is suspended both by the EV and the EVSE,
 * status SuspendedEVSE SHALL have precedence over status SuspendedEV", so an
 * EV that stopped asking for energy meanwhile leaves for `SuspendedEV`, its
 * offer held the way `evSetReady(false)` holds it, so that the EV asking
 * again resumes `Charging`. Any other EV resumes `Charging` at once.
 */
export function resumeAfterEvseSuspension(
  chargePoint: Pick<ChargePoint, "updateConnectorStatus">,
  connector: Connector,
): void {
  if (connector.evConnection === "connected-not-ready") {
    connector.suspendEnergyOffer();
    chargePoint.updateConnectorStatus(connector.id, OCPPStatus.SuspendedEV);
    return;
  }
  chargePoint.updateConnectorStatus(connector.id, OCPPStatus.Charging);
}
