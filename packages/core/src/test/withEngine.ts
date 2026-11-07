import { ChargerEngine } from "../cp/application/engine/ChargerEngine";
import type { ChargePoint } from "../cp/domain/charge-point/ChargePoint";
import { Logger } from "../cp/shared/Logger";
import { realClock } from "../cp/shared/clock";

/**
 * Give a hand-written charge point stub the charger engine its handlers now
 * call: the default behaviors run for real against the stub. Fields the
 * engine reads and the stub lacks (`clock`, `logger`, `ocppVersion`, `id`) are
 * filled in.
 */
export function withEngine<T extends object>(stub: T): T & ChargePoint {
  const station = stub as Record<string, unknown>;
  station.clock ??= realClock;
  station.logger ??= new Logger();
  station.ocppVersion ??= "OCPP-1.6J";
  station.id ??= "stub-cp";
  station.engine = new ChargerEngine(stub as unknown as ChargePoint);
  return stub as T & ChargePoint;
}
