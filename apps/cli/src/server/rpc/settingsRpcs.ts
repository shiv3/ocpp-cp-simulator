import type { RuntimeSocketIoDeps } from "../socketServer";
import type { CellularPolicySet } from "@ocpp-cp-simulator/core/cp/domain/modem/cellularLink";
import {
  RpcFailure,
  redactSimulatorConfig,
  SCENARIO_RUNS_PAGE_DEFAULT,
  CHARGING_SESSIONS_PAGE_DEFAULT,
  type Params,
  type Result,
} from "@ocpp-cp-simulator/contracts/index";
import type { ScenarioRunPage } from "@ocpp-cp-simulator/core/cp/application/verification/ScenarioRunSummary";
import { TIMELINE_FORMAT_VERSION } from "@ocpp-cp-simulator/core/cp/application/services/OperationalTimeline";
import type { AutoMeterValueConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/MeterValueCurve";
import { type EVSettingsPatch } from "@ocpp-cp-simulator/core/cp/domain/connector/EVSettings";
import { type NetworkSimLayerConfig } from "@ocpp-cp-simulator/core/cp/infrastructure/transport/network-sim/config";
import type { AutoTrafficConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/AutoTraffic";
import { runFacadeOperation } from "./facadeErrors";
import type { RegistryChargePointService } from "../RegistryChargePointService";

export async function getConfig(
  chargePointService: RegistryChargePointService,
): Promise<unknown> {
  const config = await runFacadeOperation(() =>
    chargePointService.loadConfig(),
  );
  return config ? redactSimulatorConfig(config) : null;
}

export async function saveConfig(
  deps: RuntimeSocketIoDeps,
  params: Params<"config.save">,
): Promise<{ ok: true }> {
  const saved = await runFacadeOperation(async () => {
    await deps.chargePointService.saveConfig(params.config);
    return deps.chargePointService.loadConfig();
  });
  deps.registryEvents?.emitConfigChanged(saved);
  return { ok: true };
}

export async function getNetworkSimGlobal(
  deps: RuntimeSocketIoDeps,
): Promise<unknown> {
  const config = await runFacadeOperation(() =>
    deps.chargePointService.getNetworkSimGlobal(),
  );
  return { config };
}

export async function saveNetworkSimGlobal(
  deps: RuntimeSocketIoDeps,
  params: Params<"network_sim.global.save">,
): Promise<{ ok: true }> {
  try {
    await runFacadeOperation(() =>
      deps.chargePointService.saveNetworkSimGlobal(
        params.config as NetworkSimLayerConfig | null,
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    throw new RpcFailure("invalid_params", message);
  }
  return { ok: true };
}

export async function getNetworkSimCp(
  deps: RuntimeSocketIoDeps,
  params: Params<"network_sim.cp.get">,
): Promise<unknown> {
  return runFacadeOperation(() =>
    deps.chargePointService.getNetworkSimCp(params.cpId),
  );
}

export async function saveNetworkSimCp(
  deps: RuntimeSocketIoDeps,
  params: Params<"network_sim.cp.save">,
): Promise<{ ok: true }> {
  try {
    await runFacadeOperation(() =>
      deps.chargePointService.saveNetworkSimCp(
        params.cpId,
        params.config as NetworkSimLayerConfig | null,
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    throw new RpcFailure("invalid_params", message);
  }
  return { ok: true };
}

export async function saveCellularPolicies(
  deps: RuntimeSocketIoDeps,
  params: Params<"network_sim.cellular.save">,
): Promise<{ ok: true }> {
  try {
    await runFacadeOperation(() =>
      deps.chargePointService.saveCellularPolicies(
        params.policies as CellularPolicySet | null,
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    throw new RpcFailure("invalid_params", message);
  }
  return { ok: true };
}

export async function triggerNetworkSimDisconnect(
  deps: RuntimeSocketIoDeps,
  params: Params<"network_sim.disconnect.trigger">,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return runFacadeOperation(() =>
    deps.chargePointService.triggerNetworkSimDisconnect(
      params.cpId,
      params.ruleId,
    ),
  );
}

export async function applyDefaultEVSettingsRpc(
  deps: RuntimeSocketIoDeps,
  params: Params<"ev_settings.apply_default">,
): Promise<undefined> {
  // Possibly partial (#333): the connector merges it onto
  // `defaultEVSettings`, so nothing here asserts a complete `EVSettings`.
  await runFacadeOperation(() =>
    deps.chargePointService.applyDefaultEVSettings(
      params.settings as unknown as EVSettingsPatch,
    ),
  );
  return undefined;
}

export async function listScenarioRuns(
  deps: RuntimeSocketIoDeps,
  params: Params<"scenario.runs.list">,
): Promise<ScenarioRunPage> {
  return deps.chargePointService.listScenarioRuns({
    ...params,
    limit: params.limit ?? SCENARIO_RUNS_PAGE_DEFAULT,
  });
}

/** #448: an unknown cpId is `not_found` — the registry throws, unlike the
 *  stored-logs read behind `logs.get`. */
export async function getTimeline(
  deps: RuntimeSocketIoDeps,
  { cpId, ...query }: Params<"timeline.get">,
): Promise<Result<"timeline.get">> {
  const page = await runFacadeOperation(() =>
    deps.chargePointService.getOperationalTimeline(cpId, query),
  );
  return { version: TIMELINE_FORMAT_VERSION, ...page };
}

/**
 * #447: an unknown cpId is `not_found`, like `timeline.get`. #489: without
 * `cpId` the listing spans the fleet, `labels` narrowing it.
 */
export async function listChargingSessions(
  deps: RuntimeSocketIoDeps,
  { cpId, labels, startedFrom, startedTo, ...query }: Params<"sessions.list">,
): Promise<Result<"sessions.list">> {
  const page = {
    ...query,
    // Normalised to the form `startedAt` is stored in, so a zone offset in
    // the request compares correctly as text.
    ...(startedFrom === undefined
      ? {}
      : { startedFrom: new Date(startedFrom).toISOString() }),
    ...(startedTo === undefined
      ? {}
      : { startedTo: new Date(startedTo).toISOString() }),
    limit: query.limit ?? CHARGING_SESSIONS_PAGE_DEFAULT,
  };
  if (cpId !== undefined) {
    if (labels !== undefined) {
      throw new RpcFailure(
        "invalid_params",
        "labels selects charge points; it cannot be combined with cpId",
      );
    }
    return runFacadeOperation(() =>
      deps.chargePointService.listChargingSessions(cpId, page),
    );
  }
  return runFacadeOperation(() =>
    deps.chargePointService.listFleetChargingSessions({ ...page, labels }),
  );
}

/** #612: an unknown cpId is `not_found`, like `sessions.list`. */
export async function getConfigKeys(
  deps: RuntimeSocketIoDeps,
  { cpId, keys }: Params<"cp.config_keys.get">,
): Promise<Result<"cp.config_keys.get">> {
  const list = await runFacadeOperation(() =>
    deps.chargePointService.getConfigurationKeys(cpId, keys),
  );
  return { keys: [...list.keys], unknown: [...list.unknown] };
}

/** #612: unknown key → `not_found`; read-only key or refused value →
 *  `invalid_params` (see {@link classifyFacadeError}). */
export async function setConfigKey(
  deps: RuntimeSocketIoDeps,
  { cpId, key, value }: Params<"cp.config_keys.set">,
): Promise<Result<"cp.config_keys.set">> {
  const status = await runFacadeOperation(() =>
    deps.chargePointService.setConfigurationKey(cpId, key, value),
  );
  return { key, status };
}

export async function getAutoMeterConfig(
  deps: RuntimeSocketIoDeps,
  params: Params<"connector_settings.auto_meter.get">,
): Promise<AutoMeterValueConfig | null> {
  return runFacadeOperation(() =>
    deps.chargePointService.getAutoMeterConfig(params.cpId, params.connectorId),
  );
}

export async function saveAutoMeterConfig(
  deps: RuntimeSocketIoDeps,
  params: Params<"connector_settings.auto_meter.save">,
): Promise<{ ok: true }> {
  await runFacadeOperation(() =>
    deps.chargePointService.saveAutoMeterConfig(
      params.cpId,
      params.connectorId,
      params.config as unknown as AutoMeterValueConfig,
    ),
  );
  return { ok: true };
}

export async function getAutoTrafficSetting(
  deps: RuntimeSocketIoDeps,
  params: Params<"connector_settings.auto_traffic.get">,
): Promise<AutoTrafficConfig | null> {
  return runFacadeOperation(() =>
    deps.chargePointService.getAutoTrafficConfig(
      params.cpId,
      params.connectorId,
    ),
  );
}

export async function saveAutoTrafficSetting(
  deps: RuntimeSocketIoDeps,
  params: Params<"connector_settings.auto_traffic.save">,
): Promise<{ ok: true }> {
  await runFacadeOperation(() =>
    deps.chargePointService.saveAutoTrafficConfig(
      params.cpId,
      params.connectorId,
      params.config as unknown as AutoTrafficConfig,
    ),
  );
  return { ok: true };
}

export async function getSocMeterSync(
  deps: RuntimeSocketIoDeps,
  params: Params<"connector_settings.soc_meter_sync.get">,
): Promise<boolean> {
  return runFacadeOperation(() =>
    deps.chargePointService.getSocMeterSync(params.cpId, params.connectorId),
  );
}

export async function saveSocMeterSync(
  deps: RuntimeSocketIoDeps,
  params: Params<"connector_settings.soc_meter_sync.save">,
): Promise<{ ok: true }> {
  await runFacadeOperation(() =>
    deps.chargePointService.saveSocMeterSync(
      params.cpId,
      params.connectorId,
      params.enabled,
    ),
  );
  return { ok: true };
}
