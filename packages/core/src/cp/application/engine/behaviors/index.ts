import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { ChargerEngine } from "../ChargerEngine";
import { firmwareBehavior } from "./firmware";
import { signedFirmwareBehavior } from "./signedFirmware";

/**
 * The default behaviors, written against the same `ctx` as user behaviors.
 * Each one answers the inbound CALLs of its actions when no user behavior
 * does, and is reached through `engine.runDefault`. The ones listed here
 * reach connector and transaction paths through `cp` until stage C moves
 * those into the engine.
 */
export function registerDefaultBehaviors(
  engine: ChargerEngine,
  cp: ChargePoint,
): void {
  engine.registerDefault(firmwareBehavior(cp));
  engine.registerDefault(signedFirmwareBehavior(cp));
}
