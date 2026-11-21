import type {
  BootNotificationResult,
  ChargePointEvents,
  IncomingCallCompletion,
} from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePointEvents";
import type { ChargingSession } from "@ocpp-cp-simulator/core/cp/domain/session/ChargingSession";
import type { EVSettings } from "@ocpp-cp-simulator/core/cp/domain/connector/EVSettings";
import type { ActiveChargingProfile } from "@ocpp-cp-simulator/core/cp/domain/connector/Connector";
import type { AutoMeterValueConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/MeterValueCurve";
import type {
  ScenarioExpectation,
  ScenarioWaitIntervention,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import type { StateHistoryEntry } from "@ocpp-cp-simulator/core/cp/domain/services/StateSnapshot";
import type { TimelineEntry } from "@ocpp-cp-simulator/core/cp/application/services/OperationalTimeline";

export type CLIEvent =
  | { readonly event: "connected"; readonly data: Record<string, never> }
  | {
      // #395: the CSMS's answer to BootNotification, once processed.
      // `connected` stays transport-only.
      readonly event: "boot_notification";
      readonly data: Readonly<BootNotificationResult>;
    }
  | {
      readonly event: "disconnected";
      readonly data: { readonly code: number; readonly reason: string };
    }
  | {
      readonly event: "status_change";
      readonly data: { readonly status: string };
    }
  | { readonly event: "error"; readonly data: { readonly error: string } }
  | {
      readonly event: "connector_status";
      readonly data: {
        readonly connectorId: number;
        readonly status: string;
        readonly previousStatus: string;
      };
    }
  | {
      // #618: an out-of-table OCPP 1.6 §4.9 transition changed the connector
      // but its StatusNotification was kept off the wire
      // (`capabilityProfile.statusTransitions: "enforce"`).
      readonly event: "status_notification_suppressed";
      readonly data: ChargePointEvents["statusNotificationSuppressed"];
    }
  | {
      readonly event: "transaction_started";
      readonly data: {
        readonly connectorId: number;
        readonly transactionId: number;
        readonly tagId: string;
      };
    }
  | {
      readonly event: "transaction_stopped";
      readonly data: {
        readonly connectorId: number;
        readonly transactionId: number;
      };
    }
  | {
      readonly event: "meter_value";
      readonly data: {
        readonly connectorId: number;
        readonly meterValue: number;
      };
    }
  | {
      readonly event: "log";
      readonly data: {
        readonly level: number;
        readonly type: string;
        readonly message: string;
      };
    }
  | {
      readonly event: "scenario_started";
      readonly data: {
        readonly connectorId: number;
        readonly scenarioId: string;
        // #179: stable per-run identifier, correlates events/logs/reports.
        readonly runId: string;
      };
    }
  | {
      readonly event: "scenario_completed";
      readonly data: {
        readonly connectorId: number;
        readonly scenarioId: string;
        readonly runId: string;
      };
    }
  | {
      readonly event: "scenario_error";
      readonly data: {
        readonly connectorId: number;
        readonly scenarioId: string;
        readonly error: string;
        readonly runId: string;
      };
    }
  | {
      // #1090: the scenario's execution state changed (idle, running,
      // waiting, paused, completed, error, ...). `nodeId` is the current
      // node; `expectation` describes the condition a parked wait awaits.
      readonly event: "scenario_state_changed";
      readonly data: {
        readonly connectorId: number;
        readonly scenarioId: string;
        readonly runId: string;
        readonly state: string;
        readonly nodeId: string | null;
        readonly expectation: ScenarioExpectation | null;
        readonly error?: string;
      };
    }
  | {
      readonly event: "scenario_node_execute";
      readonly data: {
        readonly connectorId: number;
        readonly scenarioId: string;
        readonly nodeId: string;
        readonly runId: string;
      };
    }
  | {
      // #448: an entry was added to the charge point's operational timeline.
      readonly event: "timeline_entry";
      readonly data: TimelineEntry;
    }
  | {
      // #447: a charging session was opened, updated or closed.
      readonly event: "charging_session";
      readonly data: ChargingSession;
    }
  | {
      // #388: a finished run's report is in the run history, so a client
      // listing runs (scenario.runs.list) can refresh.
      readonly event: "scenario_run_recorded";
      readonly data: {
        readonly connectorId: number;
        readonly scenarioId: string;
        readonly runId: string;
      };
    }
  | {
      // #240: an operator extended, retried or continued the parked wait,
      // so a client showing its countdown must re-read scenario_status.
      readonly event: "scenario_wait_changed";
      readonly data: {
        readonly connectorId: number;
        readonly scenarioId: string;
        readonly runId: string;
        readonly nodeId: string;
        readonly kind: ScenarioWaitIntervention["kind"];
      };
    }
  | {
      readonly event: "connector_availability";
      readonly data: {
        readonly connectorId: number;
        readonly availability: string;
      };
    }
  | {
      readonly event: "connector_soc";
      readonly data: {
        readonly connectorId: number;
        readonly soc: number | null;
      };
    }
  | {
      readonly event: "connector_mode";
      readonly data: { readonly connectorId: number; readonly mode: string };
    }
  | {
      readonly event: "connector_auto_reset";
      readonly data: {
        readonly connectorId: number;
        readonly enabled: boolean;
      };
    }
  | {
      readonly event: "connector_auto_meter";
      readonly data: {
        readonly connectorId: number;
        readonly config: AutoMeterValueConfig;
      };
    }
  | {
      readonly event: "connector_ev_settings";
      readonly data: {
        readonly connectorId: number;
        readonly settings: EVSettings;
      };
    }
  | {
      readonly event: "connector_charging_profile";
      readonly data: {
        readonly connectorId: number;
        readonly profile: ActiveChargingProfile | null;
      };
    }
  | {
      readonly event: "connector_charging_profiles";
      readonly data: {
        readonly connectorId: number;
        readonly profiles: ReadonlyArray<ActiveChargingProfile>;
      };
    }
  | {
      readonly event: "state_history_entry";
      readonly data: { readonly entry: StateHistoryEntry };
    }
  | {
      readonly event: "connector_removed";
      readonly data: { readonly connectorId: number };
    }
  | {
      readonly event: "heartbeat";
      readonly data: {
        readonly intervalSeconds: number;
        readonly lastSentAt: string | null;
      };
    }
  | {
      // #396: a CSMS CALL entered dispatch, before any inbound policy,
      // response override or handler ran. The payload is redacted.
      readonly event: "csms_call_received";
      readonly data: ChargePointEvents["incomingCallReceived"];
    }
  | {
      // #396: the answer to that CALL is decided and about to be sent.
      readonly event: "csms_call_completed";
      readonly data: IncomingCallCompletion;
    };

export type EventHandler = (evt: CLIEvent) => void;

/**
 * Something that could have been holding a `--watch` reload back has finished,
 * and the state it was blocking on is *already cleared* by the time this is
 * reported. See {@link CLIChargePointService.onSessionSettled}.
 *
 * `scenarioId` names the run that wound up, or is null when what settled was a
 * connector's transaction rather than a scenario run.
 */
export interface SessionSettledInfo {
  readonly connectorId: number;
  readonly scenarioId: string | null;
}

export type SessionSettledHandler = (info: SessionSettledInfo) => void;
