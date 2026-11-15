/** Scenario definitions and scenario runs: split out of LocalChargePointService (#877). */
import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import { LocalScenarioRuntime } from "./LocalScenarioRuntime";
import { ScenarioRunRecorder } from "@ocpp-cp-simulator/core/cp/application/verification/ScenarioRunRecorder";
import type {
  ScenarioRunPage,
  ScenarioRunQuery,
} from "@ocpp-cp-simulator/core/cp/application/verification/ScenarioRunSummary";
import { appVersionString } from "../../lib/appBuildLabel";
import type {
  ChargePointEvent,
  ScenarioRunOptions,
  ScenarioListItem,
  ScenarioTemplateInfo,
} from "@ocpp-cp-simulator/client/interfaces/ChargePointService";
import {
  BROWSER_SCENARIO_FILE_UNSUPPORTED_MESSAGE,
  UnsupportedFeatureError,
} from "@ocpp-cp-simulator/client/interfaces/UnsupportedFeatureError";
import {
  getDefaultEVSettings,
  type EVSettings,
} from "@ocpp-cp-simulator/core/cp/domain/connector/EVSettings";
import type {
  ScenarioDefinition,
  ScenarioExecutionContext,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type { ScenarioRunResult } from "@ocpp-cp-simulator/core/cp/application/verification/ScenarioAssertions";
import {
  scenarioTemplates,
  getTemplateById,
} from "@ocpp-cp-simulator/core/utils/scenarioTemplates";
import {
  requireConnector,
  requireScenarioManager,
  scenarioManagerOf,
  type LocalServiceHost,
} from "./localHost";

export async function getScenarioTemplates(
  _host: LocalServiceHost,
): Promise<ScenarioTemplateInfo[]> {
  return scenarioTemplates.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
  }));
}

export async function listScenarioDefinitions(
  host: LocalServiceHost,
  id: string,
  connectorId: number | null,
): Promise<ScenarioDefinition[]> {
  return host.scenarioRepository.listByConnector(id, connectorId);
}

export async function saveScenarioDefinition(
  host: LocalServiceHost,
  id: string,
  connectorId: number | null,
  definition: ScenarioDefinition,
): Promise<ScenarioDefinition> {
  await host.scenarioRepository.save(id, connectorId, definition);
  await host.database?.flush?.();
  return definition;
}

export async function replaceConnectorScenarioDefinitions(
  host: LocalServiceHost,
  id: string,
  connectorId: number | null,
  definitions: readonly ScenarioDefinition[],
): Promise<ScenarioDefinition[]> {
  await host.scenarioRepository.replaceConnector(id, connectorId, definitions);
  await host.database?.flush?.();
  return [...definitions];
}

export async function deleteScenarioDefinition(
  host: LocalServiceHost,
  id: string,
  connectorId: number | null,
  definitionId: string,
): Promise<void> {
  host.scenarioRepository.deleteOne(id, connectorId, definitionId);
  await host.database?.flush?.();
}

export function subscribeScenarioDefinitions(
  host: LocalServiceHost,
  id: string,
  connectorId: number | null,
  handler: (definitions: ScenarioDefinition[]) => void,
): () => void {
  return host.scenarioRepository.subscribe(id, connectorId, () => {
    handler(host.scenarioRepository.listByConnector(id, connectorId));
  });
}

export async function loadScenarioTemplate(
  host: LocalServiceHost,
  id: string,
  templateId: string,
  connectorId: number,
  evSettings?: Partial<EVSettings>,
): Promise<{ scenarioId: string }> {
  const manager = requireScenarioManager(host, id, connectorId);
  const template = getTemplateById(templateId);
  if (!template) throw new Error(`Unknown template: ${templateId}`);
  const definition = template.createScenario(id, connectorId);
  if (evSettings) {
    definition.evSettings = {
      ...(definition.evSettings ?? getDefaultEVSettings()),
      ...evSettings,
    };
  }
  manager.setScenario(definition);
  return { scenarioId: definition.id };
}

export async function loadScenario(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  definition: ScenarioDefinition,
): Promise<{ scenarioId: string }> {
  // Upsert, like the daemon: loading one definition must not unload the
  // connector's other (e.g. status-triggered) scenarios.
  requireScenarioManager(host, id, connectorId).setScenario(definition);
  return { scenarioId: definition.id };
}

export async function listScenarios(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
): Promise<ScenarioListItem[]> {
  const connector = requireConnector(host.chargePoints, id, connectorId);
  const manager = scenarioManagerOf(host, id, connector);
  if (!manager) return [];
  const active = new Set(manager.getActiveScenarioIds());
  return manager.getScenarios().map((s) => {
    // Live executors only: unlike the daemon, the browser-side manager keeps
    // no terminal context once a run ends, so `state`/`mode` go back to null
    // rather than reporting how the last run finished.
    const context = manager.getScenarioExecutionContext(s.id);
    return {
      scenarioId: s.id,
      name: s.name,
      active: active.has(s.id),
      state: context?.state ?? null,
      mode: context?.mode ?? null,
    };
  });
}

export async function runScenario(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  scenarioId: string,
): Promise<void> {
  const manager = requireScenarioManager(host, id, connectorId);
  await manager.executeScenario(scenarioId);
}

export async function runScenarioFile(
  _host: LocalServiceHost,
  _id: string,
  _path: string,
  _opts?: ScenarioRunOptions,
): Promise<{ scenarioId: string }> {
  throw new UnsupportedFeatureError(
    "browser_scenario_file_unsupported",
    BROWSER_SCENARIO_FILE_UNSUPPORTED_MESSAGE,
  );
}

export async function runScenarioTemplate(
  host: LocalServiceHost,
  id: string,
  templateId: string,
  opts: ScenarioRunOptions = {},
): Promise<{ scenarioId: string }> {
  const connectorId = opts.connectorId ?? 1;
  const manager = requireScenarioManager(host, id, connectorId);
  const template = getTemplateById(templateId);
  if (!template) throw new Error(`Unknown template: ${templateId}`);
  const definition = template.createScenario(id, connectorId);
  if (opts.evSettings) {
    definition.evSettings = {
      ...(definition.evSettings ?? getDefaultEVSettings()),
      ...opts.evSettings,
    };
  }
  // #352: `once` loads the instance disabled so the connect-triggered
  // auto-start never re-arms it (LocalScenarioRuntime walks every loaded
  // definition, as the daemon does).
  if (opts.once) definition.enabled = false;
  manager.setScenario(definition);
  await manager.executeScenario(definition.id);
  return { scenarioId: definition.id };
}

export async function stopScenario(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  scenarioId: string,
): Promise<void> {
  const connector = requireConnector(host.chargePoints, id, connectorId);
  const manager = scenarioManagerOf(host, id, connector);
  manager?.stopScenario(scenarioId);
}

export async function resetScenario(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  scenarioId: string,
): Promise<void> {
  const connector = requireConnector(host.chargePoints, id, connectorId);
  const manager = scenarioManagerOf(host, id, connector);
  manager?.stopScenario(scenarioId);
}

export async function stepScenario(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  scenarioId: string,
  force = false,
): Promise<void> {
  const manager = requireScenarioManager(host, id, connectorId);
  // ScenarioManager.stepScenario calls executor.step(); for forceStep we
  // dip into the executor directly via the manager's context.
  if (!force) {
    manager.stepScenario(scenarioId);
    return;
  }
  const ctx = manager.getScenarioExecutionContext(scenarioId);
  if (!ctx) throw new Error(`Scenario ${scenarioId} is not running`);
  const executor = (
    manager as unknown as { executors: Map<string, { forceStep(): void }> }
  ).executors.get(scenarioId);
  executor?.forceStep();
}

export async function extendScenarioWait(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  scenarioId: string,
  seconds: number,
): Promise<void> {
  requireScenarioManager(host, id, connectorId).extendWait(scenarioId, seconds);
}

export async function retryScenarioWait(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  scenarioId: string,
): Promise<void> {
  requireScenarioManager(host, id, connectorId).retryWait(scenarioId);
}

export async function continueScenarioWait(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  scenarioId: string,
): Promise<void> {
  requireScenarioManager(host, id, connectorId).continueWait(scenarioId);
}

export async function stopAllScenarios(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
): Promise<void> {
  const connector = requireConnector(host.chargePoints, id, connectorId);
  const manager = scenarioManagerOf(host, id, connector);
  manager?.stopAllScenarios();
}

export async function removeScenario(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  scenarioId: string,
): Promise<void> {
  const connector = requireConnector(host.chargePoints, id, connectorId);
  const manager = scenarioManagerOf(host, id, connector);
  manager?.removeScenario(scenarioId);
  // Drop the persisted row too so reloads don't resurrect it.
  if (host.database) {
    host.scenarioRepository.deleteOne(id, connectorId, scenarioId);
    await host.database.flush?.();
  }
}

export async function getScenarioStatus(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  scenarioId: string,
): Promise<ScenarioExecutionContext | null> {
  const connector = requireConnector(host.chargePoints, id, connectorId);
  const manager = scenarioManagerOf(host, id, connector);
  if (!manager) return null;
  return manager.getScenarioExecutionContext(scenarioId) ?? null;
}

export async function getScenarioReport(
  host: LocalServiceHost,
  id: string,
  _connectorId: number,
  scenarioId: string,
  runId?: string,
): Promise<ScenarioRunResult | null> {
  // #394: the same lookup as the daemon's (runs are keyed by scenarioId;
  // no runId means the latest recorded run).
  const result =
    runId === undefined
      ? host.scenarioRuns.latest(id, scenarioId)
      : host.scenarioRuns.get(id, runId);
  if (!result || result.scenarioId !== scenarioId) return null;
  return result;
}

/** #394: the run history, paged like the daemon's `scenario.runs.list`. */
export async function listScenarioRuns(
  host: LocalServiceHost,
  query: ScenarioRunQuery,
): Promise<ScenarioRunPage> {
  return host.scenarioRuns.list(query);
}

export async function getScenario(
  host: LocalServiceHost,
  id: string,
  connectorId: number,
  scenarioId: string,
): Promise<ScenarioDefinition | null> {
  const connector = requireConnector(host.chargePoints, id, connectorId);
  const manager = scenarioManagerOf(host, id, connector);
  if (!manager) return null;
  return manager.getScenario(scenarioId) ?? null;
}

/** Build the browser scenario runtime of one registered charge point. */
export function createScenarioRuntime(
  host: LocalServiceHost,
  chargePoint: ChargePoint,
  emit: (id: string, event: ChargePointEvent) => void,
): LocalScenarioRuntime {
  return new LocalScenarioRuntime(
    chargePoint,
    host.scenarioRepository,
    (event) => emit(chargePoint.id, event),
    new ScenarioRunRecorder({
      chargePoint,
      runs: host.scenarioRuns,
      simulatorVersion: appVersionString,
      ocppVersion: () => chargePoint.ocppVersion,
      onRecorded: (result) => {
        // Persist before announcing: a reload right after must find it.
        const announce = () =>
          emit(chargePoint.id, {
            type: "scenario-run-recorded",
            connectorId: result.connectorId,
            scenarioId: result.scenarioId,
            runId: result.runId,
          });
        const flushed = host.database?.flush?.();
        if (!flushed) {
          announce();
          return;
        }
        void Promise.resolve(flushed)
          .catch((error) =>
            console.error("Failed to persist the scenario run", error),
          )
          .then(announce);
      },
    }),
  );
}
