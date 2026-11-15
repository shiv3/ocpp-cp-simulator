import * as fs from "fs";
import {
  RpcFailure,
  type Params,
  type RpcCall,
} from "@ocpp-cp-simulator/contracts/index";
import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import {
  isScenarioDefinitionShape,
  type ScenarioDefinition,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { validateScenarioSchema } from "@ocpp-cp-simulator/core/scenario/scenarioSchemaValidator";
import type { AutoMeterValueConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/MeterValueCurve";
import { type EVSettings } from "@ocpp-cp-simulator/core/cp/domain/connector/EVSettings";
import type { HistoryOptions } from "@ocpp-cp-simulator/core/cp/domain/services/StateSnapshot";
import {
  hasStatusNotificationOptions,
  type StatusNotificationOptions,
} from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import type { AutoTrafficConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/AutoTraffic";
import { requireChargePointSnapshot, runFacadeOperation } from "./facadeErrors";
import { snapshotToWireStatus } from "./wireSnapshot";
import { stripUndefined } from "./cpProvisioning";
import type { FileReloadManager } from "../FileReloadManager";
import { attachScenarioFile, detachScenarioFile } from "./scenarioDefinitions";
import type { RegistryChargePointService } from "../RegistryChargePointService";
export type FacadeDispatchResult =
  | { readonly handled: true; readonly value: unknown }
  | { readonly handled: false };

/**
 * Issue #214: advisory (warning-only) schema check for a scenario value
 * received over the `load_scenario` RPC. Never throws and never blocks
 * loading — a schema mismatch is logged and the caller proceeds exactly as
 * it would have before this check existed.
 */
function warnOnScenarioSchemaMismatch(source: string, value: unknown): void {
  const result = validateScenarioSchema(value);
  if (!result.valid) {
    console.warn(
      `[socketServer] "${source}" does not match packages/core/schema/scenario.schema.json (loading anyway): ${result.errors.slice(0, 5).join("; ")}`,
    );
  }
}

export async function dispatchFacadeCpCommand(
  chargePointService: RegistryChargePointService,
  call: RpcCall,
  id: string,
  /** Null unless the daemon runs with `--watch` (#314). */
  fileReload: FileReloadManager | null = null,
  /** The `--state-db`, when there is one. Separate from `fileReload` on
   *  purpose: a `watched_scenario_files` row is a fact about stored state, so
   *  invalidating it must not depend on this daemon happening to watch (#314). */
  database: Database | null = null,
): Promise<FacadeDispatchResult> {
  switch (call.method) {
    case "connect": {
      await runFacadeOperation(() => chargePointService.connect(id));
      return handled(undefined);
    }
    case "disconnect": {
      const { stopTransactions, reason } = call.params;
      await runFacadeOperation(() =>
        stopTransactions === true
          ? chargePointService.stopTransactionsThenClose(
              id,
              "disconnect",
              reason,
            )
          : chargePointService.disconnect(id),
      );
      return handled(undefined);
    }
    case "reset": {
      // Declared in METHODS but never routed: it fell through to JSON Lines,
      // which has no `reset` command, and answered `internal`.
      await runFacadeOperation(() => chargePointService.reset(id));
      return handled(undefined);
    }
    case "status": {
      const snapshot = await requireChargePointSnapshot(chargePointService, id);
      return handled(snapshotToWireStatus(snapshot));
    }
    case "heartbeat": {
      await runFacadeOperation(() => chargePointService.sendHeartbeat(id));
      return handled(undefined);
    }
    case "start_heartbeat": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.startHeartbeat(id, params.interval),
      );
      return handled(undefined);
    }
    case "stop_heartbeat": {
      await runFacadeOperation(() => chargePointService.stopHeartbeat(id));
      return handled(undefined);
    }
    case "start_transaction": {
      const { params } = call;
      await runFacadeOperation(() => {
        const connectorId = params.connector;
        return chargePointService.startTransaction(
          id,
          connectorId,
          // Optional on the control plane since #299 but not in OCPP's
          // StartTransaction.req, so a missing one is drawn from the pool here.
          chargePointService.resolveIdTag(id, params.tagId, connectorId),
          {
            triggerReason: params.triggerReason,
            chargingState: params.chargingState,
            idTokenType: params.idTokenType,
          },
        );
      });
      return handled(undefined);
    }
    case "stop_transaction": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.stopTransaction(id, params.connector, {
          reason: params.reason,
          triggerReason: params.triggerReason,
        }),
      );
      return handled(undefined);
    }
    case "transaction_event": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.sendTransactionUpdate(id, params.connector, {
          triggerReason: params.triggerReason,
          chargingState: params.chargingState,
          meterValues: params.meterValues,
          context: params.context,
        }),
      );
      return handled(undefined);
    }
    case "authorize": {
      const { params } = call;
      // `tagId` is optional on the control plane (#299) but not in OCPP's
      // Authorize.req, so a missing one is drawn from the pool here.
      await runFacadeOperation(() =>
        chargePointService.authorize(
          id,
          chargePointService.resolveIdTag(id, params.tagId),
          params.idTokenType,
        ),
      );
      return handled(undefined);
    }
    case "data_transfer": {
      const { params } = call;
      // #348: the answer is the point of the message, so it is the result.
      return handled(
        await runFacadeOperation(() =>
          chargePointService.sendDataTransfer(
            id,
            params.vendorId,
            params.messageId,
            params.data,
          ),
        ),
      );
    }
    case "send_ocpp_call": {
      const { params } = call;
      // #389: a CALLERROR is an answer too, so it comes back as the result.
      return handled(
        await runFacadeOperation(() =>
          chargePointService.sendOcppCall(id, params),
        ),
      );
    }
    case "send_raw_frame": {
      const { params } = call;
      // #393: no reply is a result too (reply null), as is a close.
      return handled(
        await runFacadeOperation(() =>
          chargePointService.sendRawFrame(id, params),
        ),
      );
    }
    case "get_15118_ev_certificate": {
      const { params } = call;
      // #537: the CSMS's answers (a CALLERROR included) are the result.
      return handled(
        await runFacadeOperation(() =>
          chargePointService.get15118EVCertificate(id, params),
        ),
      );
    }
    // #452: the Authorization Cache test seam.
    case "get_auth_cache":
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getAuthorizationCache(id),
        ),
      );
    case "seed_auth_cache": {
      const { params } = call;
      const seeded = await runFacadeOperation(() =>
        chargePointService.seedAuthorizationCache(id, params.entries),
      );
      return handled({ seeded });
    }
    case "clear_auth_cache": {
      const cleared = await runFacadeOperation(() =>
        chargePointService.clearAuthorizationCache(id),
      );
      return handled({ cleared });
    }
    case "diagnostics_status_notification": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.sendDiagnosticsStatusNotification(id, params.status),
      );
      return handled(undefined);
    }
    case "firmware_status_notification": {
      const { params } = call;
      const { status, requestId } = params;
      await runFacadeOperation(() =>
        requestId === undefined
          ? chargePointService.sendFirmwareStatusNotification(id, status)
          : chargePointService.sendFirmwareStatusNotification(
              id,
              status,
              requestId,
            ),
      );
      return handled(undefined);
    }
    case "log_status_notification": {
      const { params } = call;
      // #345: the schema already holds `status` to the 2.0.1 vocabulary.
      await runFacadeOperation(() =>
        chargePointService.sendLogStatusNotification(
          id,
          params.status,
          params.requestId,
        ),
      );
      return handled(undefined);
    }
    case "security_event_notification": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.sendSecurityEventNotification(
          id,
          params.type,
          params.techInfo,
        ),
      );
      return handled(undefined);
    }
    case "sign_certificate": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.sendSignCertificate(id, params.csr),
      );
      return handled(undefined);
    }
    case "update_connector_status": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.sendStatusNotification(
          id,
          params.connector,
          params.status,
          readStatusNotificationOptions(params),
        ),
      );
      return handled(undefined);
    }
    case "ev_disconnected": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.evDisconnected(id, params.connector),
      );
      return handled(undefined);
    }
    case "ev_plug_in": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.evPlugIn(id, params.connector),
      );
      return handled(undefined);
    }
    case "ev_ready": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.evSetReady(id, params.connector, params.ready),
      );
      return handled(undefined);
    }
    case "set_meter_value": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.setMeterValue(id, params.connector, params.value),
      );
      return handled(undefined);
    }
    case "send_meter_value": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.sendMeterValue(id, params.connector, params.context),
      );
      return handled(undefined);
    }
    case "remove_connector": {
      const { params } = call;
      const connectorId = params.connector;
      const before = await requireChargePointSnapshot(chargePointService, id);
      await runFacadeOperation(() =>
        chargePointService.removeConnector(id, connectorId),
      );
      const after = await chargePointService.getChargePoint(id);
      return handled({
        removed:
          before.connectors.some((connector) => connector.id === connectorId) &&
          !after?.connectors.some((connector) => connector.id === connectorId),
      });
    }
    case "set_ev_settings": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.setEVSettings(
          id,
          params.connector,
          params.settings as unknown as EVSettings,
        ),
      );
      return handled(undefined);
    }
    case "get_ev_settings": {
      const { params } = call;
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getEVSettings(id, params.connector),
        ),
      );
    }
    case "set_auto_traffic_config": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.setAutoTrafficConfig(
          id,
          params.connector,
          params.config as unknown as AutoTrafficConfig,
        ),
      );
      return handled(undefined);
    }
    case "get_auto_traffic_config": {
      const { params } = call;
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getAutoTrafficConfig(id, params.connector),
        ),
      );
    }
    case "set_auto_meter_config": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.setAutoMeterValueConfig(
          id,
          params.connector,
          params.config as unknown as AutoMeterValueConfig,
        ),
      );
      return handled(undefined);
    }
    case "get_auto_meter_config": {
      const { params } = call;
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getAutoMeterValueConfig(id, params.connector),
        ),
      );
    }
    case "set_auto_reset_to_available": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.setAutoResetToAvailable(
          id,
          params.connector,
          params.enabled,
        ),
      );
      return handled(undefined);
    }
    case "set_mode": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.setConnectorMode(id, params.connector, params.mode),
      );
      return handled(undefined);
    }
    case "set_soc": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.setConnectorSoc(id, params.connector, params.soc),
      );
      return handled(undefined);
    }
    case "set_soc_meter_sync": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.setConnectorSocMeterSync(
          id,
          params.connector,
          params.enabled,
        ),
      );
      return handled(undefined);
    }
    case "get_charging_profiles": {
      const { params } = call;
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getChargingProfiles(id, params.connector),
        ),
      );
    }
    case "get_state_history": {
      const { params } = call;
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getStateHistory(
            id,
            parseHistoryOptions(params.options),
          ),
        ),
      );
    }
    case "list_scenario_templates": {
      await requireChargePointSnapshot(chargePointService, id);
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getScenarioTemplates(),
        ),
      );
    }
    case "load_scenario_template": {
      const { params } = call;
      return handled(
        await runFacadeOperation(() =>
          chargePointService.loadScenarioTemplate(
            id,
            params.templateId,
            params.connector,
            params.evSettings as Partial<EVSettings> | undefined,
          ),
        ),
      );
    }
    case "load_scenario": {
      const { params } = call;
      const connectorId = params.connector;
      if (typeof params.file === "string") {
        // Kept, not re-read: the reload baseline has to be the bytes this
        // definition came from, or a write between here and the watch starting
        // is recorded as already-seen and never applied (#314).
        const loadedText = fs.readFileSync(params.file, "utf-8");
        const parsed: unknown = JSON.parse(loadedText);
        if (!isScenarioDefinitionShape(parsed)) {
          throw new RpcFailure("invalid_params", "");
        }
        warnOnScenarioSchemaMismatch(params.file, parsed);
        const loaded = await runFacadeOperation(() =>
          chargePointService.loadScenario(id, connectorId, parsed),
        );
        // #314: a scenario loaded *from a path* is watchable; the inline
        // `params.scenario` branch below has no file behind it and is not.
        attachScenarioFile(fileReload, database, {
          filePath: params.file,
          cpId: id,
          connectorId,
          scenarioId: loaded.scenarioId,
          loadedText,
        });
        return handled(loaded);
      }
      if (params.scenario) {
        warnOnScenarioSchemaMismatch(
          "load_scenario params.scenario",
          params.scenario,
        );
        const loaded = await runFacadeOperation(() =>
          chargePointService.loadScenario(
            id,
            connectorId,
            params.scenario as unknown as ScenarioDefinition,
          ),
        );
        // #314: an inline definition replaces whatever was under this id, file
        // or not. Leaving an earlier `load_scenario { file }` watch in place
        // would let the next edit of that file overwrite the definition the
        // operator just installed by hand — and leaving its persisted row in
        // place would let a later `--watch` restart do the same, which is why
        // that goes whether or not this daemon is watching anything.
        detachScenarioFile(
          fileReload,
          database,
          id,
          connectorId,
          loaded.scenarioId,
        );
        return handled(loaded);
      }
      throw new Error("Either 'file' or 'scenario' parameter is required");
    }
    case "list_scenarios": {
      const { params } = call;
      return handled(
        await runFacadeOperation(() =>
          chargePointService.listScenarios(id, params.connector),
        ),
      );
    }
    case "run_scenario": {
      const { params } = call;
      const { strict, awaitArmed } = params;
      await runFacadeOperation(() =>
        chargePointService.runScenario(
          id,
          params.connector,
          params.scenarioId,
          strict !== undefined || awaitArmed !== undefined
            ? { strict, awaitArmed }
            : undefined,
        ),
      );
      return handled(undefined);
    }
    case "scenario_status": {
      const { params } = call;
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getScenarioStatus(
            id,
            params.connector,
            params.scenarioId,
          ),
        ),
      );
    }
    case "scenario_report": {
      const { params } = call;
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getScenarioReport(
            id,
            params.connector,
            params.scenarioId,
            params.runId,
          ),
        ),
      );
    }
    case "get_scenario": {
      const { params } = call;
      return handled(
        await runFacadeOperation(() =>
          chargePointService.getScenario(
            id,
            params.connector,
            params.scenarioId,
          ),
        ),
      );
    }
    case "stop_scenario": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.stopScenario(
          id,
          params.connector,
          params.scenarioId,
        ),
      );
      return handled(undefined);
    }
    case "scenario_reset": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.resetScenario(
          id,
          params.connector,
          params.scenarioId,
        ),
      );
      return handled(undefined);
    }
    case "step_scenario": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.stepScenario(
          id,
          params.connector,
          params.scenarioId,
          params.force === true,
        ),
      );
      return handled(undefined);
    }
    case "extend_scenario_wait": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.extendScenarioWait(
          id,
          params.connector,
          params.scenarioId,
          params.seconds,
        ),
      );
      return handled(undefined);
    }
    case "retry_scenario_wait": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.retryScenarioWait(
          id,
          params.connector,
          params.scenarioId,
        ),
      );
      return handled(undefined);
    }
    case "continue_scenario_wait": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.continueScenarioWait(
          id,
          params.connector,
          params.scenarioId,
        ),
      );
      return handled(undefined);
    }
    case "stop_all_scenarios": {
      const { params } = call;
      await runFacadeOperation(() =>
        chargePointService.stopAllScenarios(id, params.connector),
      );
      return handled(undefined);
    }
    case "remove_scenario": {
      const { params } = call;
      const connectorId = params.connector;
      const scenarioId = params.scenarioId;
      const before = await runFacadeOperation(() =>
        chargePointService.listScenarios(id, connectorId),
      );
      await runFacadeOperation(() =>
        chargePointService.removeScenario(id, connectorId, scenarioId),
      );
      const after = await chargePointService.listScenarios(id, connectorId);
      // #314: the file behind a removed scenario stops being watched, or the
      // next edit would re-create the scenario that was just deleted. The
      // persisted row goes unconditionally — it is a fact about stored state,
      // not about `--watch`, and a daemon running without the flag would
      // otherwise leave it for a later watched restart to reattach.
      detachScenarioFile(fileReload, database, id, connectorId, scenarioId);
      return handled({
        removed:
          before.some((scenario) => scenario.scenarioId === scenarioId) &&
          !after.some((scenario) => scenario.scenarioId === scenarioId),
      });
    }
    case "run_scenario_file": {
      const { params } = call;
      const filePath = params.file;
      const connectorId = params.connector;
      let loadedText: string | undefined;
      const started = await runFacadeOperation(() =>
        chargePointService.runScenarioFile(id, filePath, {
          connectorId,
          strict: params.strict,
          onSourceText: (text) => {
            loadedText = text;
          },
        }),
      );
      attachScenarioFile(fileReload, database, {
        filePath,
        cpId: id,
        connectorId,
        scenarioId: started.scenarioId,
        loadedText,
      });
      return handled(started);
    }
    case "run_scenario_template": {
      const { params } = call;
      const once = params.once;
      return handled(
        await runFacadeOperation(() =>
          chargePointService.runScenarioTemplate(id, params.templateId, {
            connectorId: params.connector,
            evSettings: params.evSettings as Partial<EVSettings> | undefined,
            strict: params.strict,
            ...(once === undefined ? {} : { once }),
          }),
        ),
      );
    }
    default:
      return { handled: false };
  }
}

function handled(value: unknown): FacadeDispatchResult {
  return { handled: true, value };
}

function readStatusNotificationOptions({
  errorCode,
  info,
  vendorErrorCode,
  vendorId,
  timestamp,
  suppressChargingStateTransactionEvent,
  allowInvalidTransition,
}: Params<"update_connector_status">): StatusNotificationOptions | undefined {
  const opts: StatusNotificationOptions = stripUndefined({
    errorCode,
    info,
    vendorErrorCode,
    vendorId,
    timestamp: timestamp === undefined ? undefined : new Date(timestamp),
    suppressChargingStateTransactionEvent,
    allowInvalidTransition,
  });
  return opts.allowInvalidTransition || hasStatusNotificationOptions(opts)
    ? opts
    : undefined;
}

function parseHistoryOptions(raw: unknown): HistoryOptions | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: HistoryOptions = {};
  if (typeof src.entity === "string") {
    out.entity = src.entity as HistoryOptions["entity"];
  }
  if (typeof src.entityId === "number") {
    out.entityId = src.entityId;
  }
  if (typeof src.transitionType === "string") {
    out.transitionType = src.transitionType as HistoryOptions["transitionType"];
  }
  if (typeof src.limit === "number") {
    out.limit = src.limit;
  }
  if (typeof src.fromTimestamp === "string") {
    out.fromTimestamp = new Date(src.fromTimestamp);
  } else if (src.fromTimestamp instanceof Date) {
    out.fromTimestamp = src.fromTimestamp;
  }
  if (typeof src.toTimestamp === "string") {
    out.toTimestamp = new Date(src.toTimestamp);
  } else if (src.toTimestamp instanceof Date) {
    out.toTimestamp = src.toTimestamp;
  }
  return out;
}
