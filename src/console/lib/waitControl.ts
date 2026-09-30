import type { ChargePointService } from "../../data/interfaces/ChargePointService";

/** #240: what an operator can do with a run's parked wait. */
export type WaitControlAction = "extend" | "retry" | "continue";

/** Sends one wait control for `scenarioId` (`seconds`: extend only). */
export function controlScenarioWait(
  service: ChargePointService,
  cpId: string,
  connectorId: number,
  scenarioId: string,
  action: WaitControlAction,
  seconds = 0,
): Promise<void> {
  switch (action) {
    case "extend":
      return service.extendScenarioWait(cpId, connectorId, scenarioId, seconds);
    case "retry":
      return service.retryScenarioWait(cpId, connectorId, scenarioId);
    case "continue":
      return service.continueScenarioWait(cpId, connectorId, scenarioId);
  }
}
