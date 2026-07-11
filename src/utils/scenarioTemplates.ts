import { ScenarioDefinition } from "../cp/application/scenario/ScenarioTypes";

import essentialCpBehaviorJson from "./scenarios/essential-cp-behavior.json";
import fullChargingCycleJson from "./scenarios/full-charging-cycle.json";
import smartChargingJson from "./scenarios/smart-charging.json";
import multiStatusMonitorJson from "./scenarios/multi-status-monitor.json";
import statusTriggeredActionsJson from "./scenarios/status-triggered-actions.json";
import remoteStartAutoMeterJson from "./scenarios/remote-start-auto-meter.json";

// OCPP 1.6 Core certification scenarios (issue #110, first slice). TC
// numbers follow the issue's own numbering, not an external test suite.
import cert16Tc001ColdBootJson from "./scenarios/cert16-tc001-cold-boot.json";
import cert16Tc003ChargingPluginFirstJson from "./scenarios/cert16-tc003-charging-plugin-first.json";
import cert16Tc004ChargingIdFirstJson from "./scenarios/cert16-tc004-charging-id-first.json";
import cert16Tc005EvSideDisconnectJson from "./scenarios/cert16-tc005-ev-side-disconnect.json";
import cert16Tc010RemoteStartJson from "./scenarios/cert16-tc010-remote-start.json";
import cert16Tc011RemoteStartStopJson from "./scenarios/cert16-tc011-remote-start-stop.json";
import cert16Tc012RemoteStopJson from "./scenarios/cert16-tc012-remote-stop.json";
import cert16Tc013HardResetJson from "./scenarios/cert16-tc013-hard-reset.json";
import cert16Tc014SoftResetJson from "./scenarios/cert16-tc014-soft-reset.json";
import cert16Tc017UnlockOccupiedJson from "./scenarios/cert16-tc017-unlock-occupied.json";
import cert16Tc018UnlockFailureJson from "./scenarios/cert16-tc018-unlock-failure.json";
import cert16Tc019GetConfigAllJson from "./scenarios/cert16-tc019-get-configuration-all.json";
import cert16Tc019GetConfigKeyJson from "./scenarios/cert16-tc019-get-configuration-key.json";
import cert16Tc021ChangeConfigJson from "./scenarios/cert16-tc021-change-configuration.json";
import cert16Tc031UnlockUnknownJson from "./scenarios/cert16-tc031-unlock-unknown-connector.json";
import cert16Tc061ClearCacheJson from "./scenarios/cert16-tc061-clear-cache.json";
import cert16Tc064DataTransferJson from "./scenarios/cert16-tc064-data-transfer.json";
import cert16Tc024LockFailureJson from "./scenarios/cert16-tc024-lock-failure.json";
import cert16Tc026RemoteStartRejectedJson from "./scenarios/cert16-tc026-remote-start-rejected.json";
import cert16Tc028RemoteStopRejectedJson from "./scenarios/cert16-tc028-remote-stop-rejected.json";
import cert16ReservationBasicJson from "./scenarios/cert16-reservation-basic.json";

// OCPP 1.6 LocalList certification scenarios (issue #110, PR 3).
import cert16Tc042_1GetLocalListVersionNotSupportedJson from "./scenarios/cert16-tc042-1-get-local-list-version-not-supported.json";
import cert16Tc042_2GetLocalListVersionEmptyJson from "./scenarios/cert16-tc042-2-get-local-list-version-empty.json";
import cert16Tc043_1SendLocalListNotSupportedJson from "./scenarios/cert16-tc043-1-send-local-list-not-supported.json";
import cert16Tc043_3SendLocalListFailedJson from "./scenarios/cert16-tc043-3-send-local-list-failed.json";
import cert16Tc043_4SendLocalListFullJson from "./scenarios/cert16-tc043-4-send-local-list-full.json";
import cert16Tc043_5SendLocalListDifferentialJson from "./scenarios/cert16-tc043-5-send-local-list-differential.json";

// OCPP 1.6 Reservation certification scenarios (issue #110, PR 3).
import cert16Tc048_1ReserveNowFaultedJson from "./scenarios/cert16-tc048-1-reserve-now-faulted.json";
import cert16Tc048_2ReserveNowOccupiedJson from "./scenarios/cert16-tc048-2-reserve-now-occupied.json";
import cert16Tc048_3ReserveNowUnavailableJson from "./scenarios/cert16-tc048-3-reserve-now-unavailable.json";
import cert16Tc048_4ReserveNowRejectedJson from "./scenarios/cert16-tc048-4-reserve-now-rejected.json";
import cert16Tc051CancelReservationJson from "./scenarios/cert16-tc051-cancel-reservation.json";
import cert16Tc052CancelReservationRejectedJson from "./scenarios/cert16-tc052-cancel-reservation-rejected.json";

// OCPP 1.6 RemoteTrigger certification scenarios (issue #110, PR 4).
import cert16Tc054TriggerMessageJson from "./scenarios/cert16-tc054-trigger-message.json";
import cert16Tc055TriggerMessageRejectedJson from "./scenarios/cert16-tc055-trigger-message-rejected.json";

// OCPP 1.6 SmartCharging certification scenarios (issue #110, PR 4).
import cert16Tc056CentralSmartChargingTxDefaultJson from "./scenarios/cert16-tc056-central-smart-charging-txdefault.json";
import cert16Tc057CentralSmartChargingTxProfileJson from "./scenarios/cert16-tc057-central-smart-charging-txprofile.json";
import cert16Tc059RemoteStartWithProfileJson from "./scenarios/cert16-tc059-remote-start-with-profile.json";
import cert16Tc066GetCompositeScheduleJson from "./scenarios/cert16-tc066-get-composite-schedule.json";
import cert16Tc067ClearChargingProfileJson from "./scenarios/cert16-tc067-clear-charging-profile.json";

export interface ScenarioTemplate {
  id: string;
  name: string;
  description: string;
  targetType: "chargePoint" | "connector";
  createScenario: (
    chargePointId: string,
    connectorId: number | null,
  ) => ScenarioDefinition;
}

/**
 * Each built-in template is a flat ScenarioDefinition JSON file under
 * ./scenarios/. The same shape that
 * docs/examples/scenarios/demo-charging.json uses, so the daemon's
 * --scenario-template-file path can load any of these straight off
 * disk without going through this loader.
 *
 * `templateFromJson` wraps the JSON in the editor-facing ScenarioTemplate
 * interface and `createScenario` deep-clones the nodes/edges + synthesizes
 * a per-instance `id` so:
 *   1. the daemon's per-connector seed loop in CPRegistry.create doesn't
 *      collide on Date.now() and overwrite earlier connectors' rows
 *   2. editing one loaded instance doesn't leak mutations back into the
 *      shared JSON module.
 */
function templateFromJson(json: ScenarioDefinition): ScenarioTemplate {
  return {
    id: json.id,
    name: json.name,
    description: json.description ?? "",
    targetType: json.targetType,
    createScenario: (chargePointId, connectorId) => {
      const now = new Date().toISOString();
      const suffix = Math.random().toString(36).slice(2, 8);
      return {
        ...json,
        id: `${json.id}-${chargePointId}-c${connectorId ?? "cp"}-${Date.now()}-${suffix}`,
        targetType: json.targetType,
        targetId: connectorId ?? undefined,
        nodes: structuredClone(json.nodes),
        edges: structuredClone(json.edges),
        trigger: json.trigger ?? { type: "manual" },
        defaultExecutionMode: json.defaultExecutionMode ?? "oneshot",
        enabled: json.enabled ?? true,
        evSettings: json.evSettings
          ? structuredClone(json.evSettings)
          : undefined,
        createdAt: now,
        updatedAt: now,
      };
    },
  };
}

/**
 * All available templates. Essential first so it surfaces at the top of
 * the template picker and as the seed in CPRegistry.create.
 */
export const scenarioTemplates: ScenarioTemplate[] = [
  templateFromJson(essentialCpBehaviorJson as ScenarioDefinition),
  templateFromJson(fullChargingCycleJson as ScenarioDefinition),
  templateFromJson(smartChargingJson as ScenarioDefinition),
  templateFromJson(multiStatusMonitorJson as ScenarioDefinition),
  templateFromJson(statusTriggeredActionsJson as ScenarioDefinition),
  templateFromJson(remoteStartAutoMeterJson as ScenarioDefinition),

  // OCPP 1.6 Core certification scenarios (issue #110, first slice) —
  // grouped together so they surface as a block in the template picker.
  templateFromJson(cert16Tc001ColdBootJson as ScenarioDefinition),
  templateFromJson(cert16Tc003ChargingPluginFirstJson as ScenarioDefinition),
  templateFromJson(cert16Tc004ChargingIdFirstJson as ScenarioDefinition),
  templateFromJson(cert16Tc005EvSideDisconnectJson as ScenarioDefinition),
  templateFromJson(cert16Tc010RemoteStartJson as ScenarioDefinition),
  templateFromJson(cert16Tc011RemoteStartStopJson as ScenarioDefinition),
  templateFromJson(cert16Tc012RemoteStopJson as ScenarioDefinition),
  templateFromJson(cert16Tc013HardResetJson as ScenarioDefinition),
  templateFromJson(cert16Tc014SoftResetJson as ScenarioDefinition),
  templateFromJson(cert16Tc017UnlockOccupiedJson as ScenarioDefinition),
  templateFromJson(cert16Tc018UnlockFailureJson as ScenarioDefinition),
  templateFromJson(cert16Tc019GetConfigAllJson as ScenarioDefinition),
  templateFromJson(cert16Tc019GetConfigKeyJson as ScenarioDefinition),
  templateFromJson(cert16Tc021ChangeConfigJson as ScenarioDefinition),
  templateFromJson(cert16Tc024LockFailureJson as ScenarioDefinition),
  templateFromJson(cert16Tc026RemoteStartRejectedJson as ScenarioDefinition),
  templateFromJson(cert16Tc028RemoteStopRejectedJson as ScenarioDefinition),
  templateFromJson(cert16Tc031UnlockUnknownJson as ScenarioDefinition),
  templateFromJson(cert16Tc061ClearCacheJson as ScenarioDefinition),
  templateFromJson(cert16Tc064DataTransferJson as ScenarioDefinition),
  templateFromJson(cert16ReservationBasicJson as ScenarioDefinition),

  // OCPP 1.6 LocalList certification scenarios (issue #110, PR 3) —
  // grouped together so they surface as a block in the template picker.
  templateFromJson(
    cert16Tc042_1GetLocalListVersionNotSupportedJson as ScenarioDefinition,
  ),
  templateFromJson(
    cert16Tc042_2GetLocalListVersionEmptyJson as ScenarioDefinition,
  ),
  templateFromJson(
    cert16Tc043_1SendLocalListNotSupportedJson as ScenarioDefinition,
  ),
  templateFromJson(cert16Tc043_3SendLocalListFailedJson as ScenarioDefinition),
  templateFromJson(cert16Tc043_4SendLocalListFullJson as ScenarioDefinition),
  templateFromJson(
    cert16Tc043_5SendLocalListDifferentialJson as ScenarioDefinition,
  ),

  // OCPP 1.6 Reservation certification scenarios (issue #110, PR 3) —
  // grouped together so they surface as a block in the template picker.
  templateFromJson(cert16Tc048_1ReserveNowFaultedJson as ScenarioDefinition),
  templateFromJson(cert16Tc048_2ReserveNowOccupiedJson as ScenarioDefinition),
  templateFromJson(
    cert16Tc048_3ReserveNowUnavailableJson as ScenarioDefinition,
  ),
  templateFromJson(cert16Tc048_4ReserveNowRejectedJson as ScenarioDefinition),
  templateFromJson(cert16Tc051CancelReservationJson as ScenarioDefinition),
  templateFromJson(
    cert16Tc052CancelReservationRejectedJson as ScenarioDefinition,
  ),

  // OCPP 1.6 RemoteTrigger certification scenarios (issue #110, PR 4) —
  // grouped together so they surface as a block in the template picker.
  templateFromJson(cert16Tc054TriggerMessageJson as ScenarioDefinition),
  templateFromJson(cert16Tc055TriggerMessageRejectedJson as ScenarioDefinition),

  // OCPP 1.6 SmartCharging certification scenarios (issue #110, PR 4) —
  // grouped together so they surface as a block in the template picker.
  templateFromJson(
    cert16Tc056CentralSmartChargingTxDefaultJson as ScenarioDefinition,
  ),
  templateFromJson(
    cert16Tc057CentralSmartChargingTxProfileJson as ScenarioDefinition,
  ),
  templateFromJson(cert16Tc059RemoteStartWithProfileJson as ScenarioDefinition),
  templateFromJson(cert16Tc066GetCompositeScheduleJson as ScenarioDefinition),
  templateFromJson(cert16Tc067ClearChargingProfileJson as ScenarioDefinition),
];

export function getTemplateById(
  templateId: string,
): ScenarioTemplate | undefined {
  return scenarioTemplates.find((t) => t.id === templateId);
}
