import type { RuntimeSocketIoDeps } from "../socketServer";
import { runCpBatch, runCpBulk } from "../cpBulk";
import {
  RpcFailure,
  ARRAY_MAX_ITEMS,
  CP_BULK_WAIT_MS,
  type CpBulkResult,
  type CpScenarioRunResult,
  type CpListItem,
  type Params,
} from "@ocpp-cp-simulator/contracts/index";
import { type EVSettings } from "@ocpp-cp-simulator/core/cp/domain/connector/EVSettings";
import { runFacadeOperation } from "./facadeErrors";
import { snapshotToRegistryCpWire } from "./wireSnapshot";
import { batchFailureReason } from "./cpProvisioning";
import { selectLogWindow } from "@ocpp-cp-simulator/core/cp/shared/window";
import type { RegistryChargePointService } from "../RegistryChargePointService";

export async function listCps(
  chargePointService: RegistryChargePointService,
  params: Params<"cp.list">,
): Promise<CpListItem[]> {
  // #470: the selector is applied before any status snapshot is built.
  return runFacadeOperation(async () =>
    (await chargePointService.listChargePoints(params.labels)).map(
      snapshotToRegistryCpWire,
    ),
  );
}

/**
 * `cp.bulk` (#470): one lifecycle action on every charge point a label
 * selector matches, each through the same facade call — and so the same error
 * classification — as the per-CP method of that name.
 */
export async function bulkCps(
  deps: RuntimeSocketIoDeps,
  { labels, action }: Params<"cp.bulk">,
): Promise<CpBulkResult> {
  const service = deps.chargePointService;
  const cpIds = service.selectChargePointIds(labels);
  // Refused before acting: nothing caps the registry, and a match the result
  // arrays cannot hold would fail result validation after every action ran.
  if (cpIds.length > ARRAY_MAX_ITEMS) {
    throw new RpcFailure(
      "invalid_params",
      `the selector matches ${cpIds.length} charge points, more than ${ARRAY_MAX_ITEMS}; narrow it`,
    );
  }
  // Each action is named after the facade method that runs it.
  return runCpBulk(
    cpIds,
    (cpId) => runFacadeOperation(() => service[action](cpId)),
    {
      waitMs: deps.cpBulkWaitMs ?? CP_BULK_WAIT_MS,
      failureReason: batchFailureReason,
    },
  );
}

/**
 * `cp.scenario.run` (#486): `run_scenario_template` on every charge point a
 * label selector matches, through the same facade call as the per-CP method.
 * Each entry reports the scenario id its charge point started, to follow with
 * `scenario_status` / `scenario.runs.list`. Selection, the over-1,000 refusal
 * and the fan-out are `cp.bulk`'s.
 */
export async function runScenarioOnSelector(
  deps: RuntimeSocketIoDeps,
  params: Params<"cp.scenario.run">,
): Promise<CpScenarioRunResult> {
  const service = deps.chargePointService;
  const cpIds = service.selectChargePointIds(params.labels);
  if (cpIds.length > ARRAY_MAX_ITEMS) {
    throw new RpcFailure(
      "invalid_params",
      `the selector matches ${cpIds.length} charge points, more than ${ARRAY_MAX_ITEMS}; narrow it`,
    );
  }
  const { once } = params;
  const batch = await runCpBatch(
    cpIds,
    (cpId) =>
      runFacadeOperation(() =>
        service.runScenarioTemplate(cpId, params.templateId, {
          connectorId: params.connector,
          evSettings: params.evSettings as Partial<EVSettings> | undefined,
          strict: params.strict,
          ...(once === undefined ? {} : { once }),
        }),
      ),
    {
      waitMs: deps.cpBulkWaitMs ?? CP_BULK_WAIT_MS,
      failureReason: batchFailureReason,
    },
  );
  return {
    matched: batch.matched,
    started: batch.succeeded.map(({ cpId, value }) => ({
      cpId,
      scenarioId: value.scenarioId,
    })),
    failed: batch.failed,
  };
}

export async function deleteCp(
  deps: RuntimeSocketIoDeps,
  { cpId, stopTransactions, reason }: Params<"cp.delete">,
): Promise<{ ok: true }> {
  await runFacadeOperation(() =>
    stopTransactions === true
      ? deps.chargePointService.stopTransactionsThenClose(
          cpId,
          "remove",
          reason,
        )
      : deps.chargePointService.removeChargePoint(cpId),
  );
  return { ok: true };
}

export async function getLogs(
  deps: RuntimeSocketIoDeps,
  params: Params<"logs.get">,
): Promise<ReadonlyArray<unknown>> {
  const entries = await runFacadeOperation(() =>
    deps.chargePointService.listStoredLogs(params.cpId),
  );
  // `limit` selects the NEWEST n (see selectLogWindow). It used to take the
  // oldest n, which made the parameter useless on a long-running charge point:
  // no limit could reach recent activity.
  return selectLogWindow(entries, {
    limit: params.limit,
    offset: params.offset,
    order: params.order ?? "asc",
  });
}

export async function clearLogs(
  deps: RuntimeSocketIoDeps,
  { cpId }: Params<"logs.clear">,
): Promise<{ ok: true }> {
  await runFacadeOperation(() => deps.chargePointService.clearStoredLogs(cpId));
  return { ok: true };
}

export async function resetState(
  deps: RuntimeSocketIoDeps,
): Promise<{ ok: true }> {
  await runFacadeOperation(() => deps.chargePointService.resetAllState());
  // The table is truncated with the others; without --state-db the profiles
  // live in the repository's memory, which only the repository can empty.
  deps.vehicleProfiles.clear();
  deps.registryEvents?.emitReset();
  return { ok: true };
}
