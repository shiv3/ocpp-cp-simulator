import { BehaviorRegistry } from "../../application/behavior/BehaviorRegistry";
import { ChargerEngine } from "../../application/engine/ChargerEngine";
import {
  cleanTransaction,
  startTransaction,
  stopTransaction,
} from "../../application/engine/behaviors/transaction";
import { HeartbeatService } from "../../application/services/HeartbeatService";
import { OperationalTimeline } from "../../application/services/OperationalTimeline";
import { OperationalTimelineProjector } from "../../application/services/OperationalTimelineProjector";
import { StateManager } from "../../application/services/StateManager";
import type { ChargePointServiceFactories } from "../../domain/charge-point/ChargePointDeps";

/**
 * The production services of a charge point (#575): the application classes
 * behind the domain interfaces `ChargePoint` is typed with. Spread into the
 * deps by `createChargePoint`.
 */
export const DEFAULT_SERVICES: ChargePointServiceFactories = {
  createBehaviorRegistry: (options) => new BehaviorRegistry(options),
  createEngine: (cp) => new ChargerEngine(cp),
  createHeartbeat: (logger, clock) => new HeartbeatService(logger, clock),
  createStateManager: ({ logger, events, chargePoint, clock, rng }) =>
    new StateManager(logger, events, chargePoint, clock, rng),
  createTimeline: ({ cpId, events, connectors, clock, rng }) => {
    const timeline = new OperationalTimeline(cpId, { clock });
    const projector = new OperationalTimelineProjector(
      timeline,
      events,
      connectors,
      clock,
      rng,
    );
    return { timeline, projector };
  },
  transactions: {
    start: startTransaction,
    stop: stopTransaction,
    clean: cleanTransaction,
  },
};
