import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { ChargerEngine } from "../ChargerEngine";
import { availabilityBehavior } from "./availability";
import { diagnosticsBehavior } from "./diagnostics";
import { firmwareBehavior } from "./firmware";
import { logsBehavior } from "./logs";
import { reservationBehavior } from "./reservation";
import { resetBehavior } from "./reset";
import { transactionBehavior } from "./transaction";
import { unlockBehavior } from "./unlock";
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
  engine.registerDefault(diagnosticsBehavior(cp));
  engine.registerDefault(logsBehavior(cp));
  engine.registerDefault(resetBehavior(cp));
  engine.registerDefault(availabilityBehavior(cp));
  engine.registerDefault(reservationBehavior(cp));
  engine.registerDefault(unlockBehavior(cp));
  engine.registerDefault(transactionBehavior(cp));
}
