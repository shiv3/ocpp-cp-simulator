import { ChargePoint } from "../../domain/charge-point/ChargePoint";

/**
 * Composition root for a {@link ChargePoint}: the single place that calls its
 * constructor. Every caller (CLI, web console, tests, benches) builds charge
 * points through here so infrastructure dependencies can be injected in one
 * spot (#575).
 */
export function createChargePoint(
  ...args: ConstructorParameters<typeof ChargePoint>
): ChargePoint {
  return new ChargePoint(...args);
}
