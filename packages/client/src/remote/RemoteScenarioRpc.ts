import type {
  ScenarioRunOptions,
  ScenarioListItem,
  ScenarioTemplateInfo,
} from "../interfaces/ChargePointService";
import type { EVSettings } from "@ocpp-cp-simulator/core/cp/domain/connector/EVSettings";
import type {
  ScenarioDefinition,
  ScenarioExecutionContext,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type { ScenarioRunResult } from "@ocpp-cp-simulator/core/cp/application/verification/ScenarioAssertions";
import {
  type Params,
  type Result,
  type RpcMethod,
} from "@ocpp-cp-simulator/contracts/index";

import type { ScenarioStatusRequest } from "./RemoteSubscriptions";

/** Scenario RPC wrappers of RemoteChargePointService (split out in #877). */
export interface RemoteScenarioRpcHost {
  rpc<M extends RpcMethod>(
    method: M,
    params: Params<M>,
    cpId?: string,
  ): Promise<Result<M>>;
  runCpRpc<M extends RpcMethod>(
    id: string,
    method: M,
    params?: Params<M>,
  ): Promise<Result<M>>;
  setBounded<K, V>(map: Map<K, V>, key: K, value: V): void;
  readonly activeScenarioStatus: Map<string, ScenarioStatusRequest>;
}

export class RemoteScenarioRpc {
  constructor(private readonly host: RemoteScenarioRpcHost) {}

  async getScenarioTemplates(): Promise<ScenarioTemplateInfo[]> {
    const data = await this.host.rpc("scenario.templates", {});
    return data ?? [];
  }

  async listScenarioDefinitions(
    id: string,
    connectorId: number | null,
  ): Promise<ScenarioDefinition[]> {
    const data = await this.host.rpc("scenario.definitions.list", {
      cpId: id,
      connectorId,
    });
    return (data as unknown as ScenarioDefinition[]) ?? [];
  }

  async saveScenarioDefinition(
    id: string,
    connectorId: number | null,
    definition: ScenarioDefinition,
  ): Promise<ScenarioDefinition> {
    const data = await this.host.rpc("scenario.definitions.save", {
      cpId: id,
      connectorId,
      definition: definition as unknown as Record<string, unknown>,
    });
    return (data as unknown as ScenarioDefinition) ?? definition;
  }

  async replaceConnectorScenarioDefinitions(
    id: string,
    connectorId: number | null,
    definitions: readonly ScenarioDefinition[],
  ): Promise<ScenarioDefinition[]> {
    const data = await this.host.rpc("scenario.definitions.replace", {
      cpId: id,
      connectorId,
      definitions: definitions as unknown as Record<string, unknown>[],
    });
    return (data as unknown as ScenarioDefinition[]) ?? [...definitions];
  }

  async deleteScenarioDefinition(
    id: string,
    connectorId: number | null,
    definitionId: string,
  ): Promise<void> {
    await this.host.rpc("scenario.definitions.delete", {
      cpId: id,
      connectorId,
      definitionId,
    });
  }

  async loadScenarioTemplate(
    id: string,
    templateId: string,
    connectorId: number,
    evSettings?: Partial<EVSettings>,
  ): Promise<{ scenarioId: string }> {
    const data = await this.host.runCpRpc(id, "load_scenario_template", {
      templateId,
      connector: connectorId,
      ...(evSettings ? { evSettings } : {}),
    });
    return (data as { scenarioId: string }) ?? { scenarioId: "" };
  }

  async loadScenario(
    id: string,
    connectorId: number,
    definition: ScenarioDefinition,
  ): Promise<{ scenarioId: string }> {
    const data = await this.host.runCpRpc(id, "load_scenario", {
      connector: connectorId,
      // ScenarioDefinition structurally satisfies the method's required fields
      // (id / name / targetType / nodes / edges); the cast is only needed
      // because an interface has no index signature to match the bounded
      // record half of the param type.
      scenario: definition as unknown as Params<"load_scenario">["scenario"],
    });
    return (data as { scenarioId: string }) ?? { scenarioId: "" };
  }

  async listScenarios(
    id: string,
    connectorId: number,
  ): Promise<ScenarioListItem[]> {
    const data = await this.host.runCpRpc(id, "list_scenarios", {
      connector: connectorId,
    });
    return (data as ScenarioListItem[]) ?? [];
  }

  async runScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    await this.host.runCpRpc(id, "run_scenario", {
      connector: connectorId,
      scenarioId,
    });
  }

  async runScenarioFile(
    id: string,
    path: string,
    opts: ScenarioRunOptions = {},
  ): Promise<{ scenarioId: string }> {
    const data = await this.host.runCpRpc(id, "run_scenario_file", {
      connector: opts.connectorId ?? 1,
      file: path,
    });
    return (data as { scenarioId: string }) ?? { scenarioId: "" };
  }

  async runScenarioTemplate(
    id: string,
    templateId: string,
    opts: ScenarioRunOptions = {},
  ): Promise<{ scenarioId: string }> {
    const data = await this.host.runCpRpc(id, "run_scenario_template", {
      connector: opts.connectorId ?? 1,
      templateId,
      ...(opts.evSettings !== undefined
        ? {
            evSettings: opts.evSettings as unknown as Record<string, unknown>,
          }
        : {}),
      ...(opts.strict !== undefined ? { strict: opts.strict } : {}),
      ...(opts.once !== undefined ? { once: opts.once } : {}),
    });
    return (data as { scenarioId: string }) ?? { scenarioId: "" };
  }

  async stopScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    await this.host.runCpRpc(id, "stop_scenario", {
      connector: connectorId,
      scenarioId,
    });
  }

  async resetScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    await this.host.runCpRpc(id, "scenario_reset", {
      connector: connectorId,
      scenarioId,
    });
  }

  async stepScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
    force = false,
  ): Promise<void> {
    await this.host.runCpRpc(id, "step_scenario", {
      connector: connectorId,
      scenarioId,
      force,
    });
  }

  async extendScenarioWait(
    id: string,
    connectorId: number,
    scenarioId: string,
    seconds: number,
  ): Promise<void> {
    await this.host.runCpRpc(id, "extend_scenario_wait", {
      connector: connectorId,
      scenarioId,
      seconds,
    });
  }

  async retryScenarioWait(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    await this.host.runCpRpc(id, "retry_scenario_wait", {
      connector: connectorId,
      scenarioId,
    });
  }

  async continueScenarioWait(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    await this.host.runCpRpc(id, "continue_scenario_wait", {
      connector: connectorId,
      scenarioId,
    });
  }

  async stopAllScenarios(id: string, connectorId: number): Promise<void> {
    await this.host.runCpRpc(id, "stop_all_scenarios", {
      connector: connectorId,
    });
  }

  async removeScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<void> {
    await this.host.runCpRpc(id, "remove_scenario", {
      connector: connectorId,
      scenarioId,
    });
  }

  async getScenarioStatus(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<ScenarioExecutionContext | null> {
    const key = `${id}\u0000${connectorId}\u0000${scenarioId}`;
    this.host.setBounded(this.host.activeScenarioStatus, key, {
      cpId: id,
      connector: connectorId,
      scenarioId,
    });
    const data = await this.host.runCpRpc(id, "scenario_status", {
      connector: connectorId,
      scenarioId,
    });
    return (data as ScenarioExecutionContext | null) ?? null;
  }

  async getScenarioReport(
    id: string,
    connectorId: number,
    scenarioId: string,
    runId?: string,
  ): Promise<ScenarioRunResult | null> {
    const data = await this.host.runCpRpc(id, "scenario_report", {
      connector: connectorId,
      scenarioId,
      ...(runId === undefined ? {} : { runId }),
    });
    return (data as ScenarioRunResult | null) ?? null;
  }

  async getScenario(
    id: string,
    connectorId: number,
    scenarioId: string,
  ): Promise<ScenarioDefinition | null> {
    const data = await this.host.runCpRpc(id, "get_scenario", {
      connector: connectorId,
      scenarioId,
    });
    return (data as ScenarioDefinition | null) ?? null;
  }
}
