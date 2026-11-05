/**
 * #240: a scenario control (stop, step, extend / retry / continue a wait)
 * aimed at a scenario that is not in a state to take it — unknown, loaded on
 * another connector, not running, not parked on a wait, or parked on a wait
 * with no timeout to extend. A caller error, never a fault of the simulator.
 */
export class ScenarioRunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioRunStateError";
  }
}
