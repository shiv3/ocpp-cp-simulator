import type { ChargePointTransportOptions } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";

/**
 * The opt-in station behaviours of an init or a command line, as the charge
 * point's transport options: ReserveNow authorization (#595) and the meter
 * value quirks (#1133, #1134). Each is absent when off, so a station without
 * them is built exactly as before.
 */
export function stationOptionsOf(
  o: Pick<
    ChargePointTransportOptions,
    | "reservationAuthorizeIdTag"
    | "meterValueDecimalSeparator"
    | "emptyMeterValues"
  >,
): Partial<ChargePointTransportOptions> {
  return {
    ...(o.reservationAuthorizeIdTag ? { reservationAuthorizeIdTag: true } : {}),
    ...(o.meterValueDecimalSeparator
      ? { meterValueDecimalSeparator: o.meterValueDecimalSeparator }
      : {}),
    ...(o.emptyMeterValues ? { emptyMeterValues: true } : {}),
  };
}
