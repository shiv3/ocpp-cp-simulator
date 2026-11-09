import { evaluateVehicleBehavior, startVehicleSession } from "./evaluate";
import type {
  VehicleBehaviorSpec,
  VehicleObservation,
  VehicleProfile,
  VehicleSessionState,
  VehicleSnapshot,
} from "./contracts";

/**
 * One vehicle session with an injected clock: the stateful face of
 * {@link evaluateVehicleBehavior} for a consumer that does not want to carry
 * the session state itself. Two engines built with the same spec, profile,
 * start and clock readings produce the same snapshots (replay).
 */
export class VehicleBehaviorEngine {
  private state: VehicleSessionState;

  constructor(
    private readonly spec: VehicleBehaviorSpec,
    private readonly profile: VehicleProfile,
    private readonly now: () => number,
    state?: VehicleSessionState,
  ) {
    this.state = state ?? startVehicleSession(now());
  }

  /** The explicit session state, for storing or replaying a session. */
  get sessionState(): VehicleSessionState {
    return this.state;
  }

  /** What the vehicle wants now, given what the host observed. */
  evaluate(observation: VehicleObservation): VehicleSnapshot {
    return evaluateVehicleBehavior(
      this.spec,
      this.profile,
      this.state,
      observation,
      this.now(),
    );
  }
}
