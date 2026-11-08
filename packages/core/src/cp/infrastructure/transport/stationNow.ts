import type { ChargePoint } from "../../domain/charge-point/ChargePoint";

/**
 * The station's time as a Date: its clock when it has one, the platform's
 * for a hand-written test double that lacks `nowDate`.
 */
export function stationNow(chargePoint: Pick<ChargePoint, "nowDate">): Date {
  return typeof chargePoint.nowDate === "function"
    ? chargePoint.nowDate()
    : new Date();
}
