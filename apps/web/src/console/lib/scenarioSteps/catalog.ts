import type { MessageKey } from "../../../i18n";
import {
  type AnyScenarioNodeType,
  ScenarioFlowNodeType,
  ScenarioNodeType,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

/**
 * Palette groupings for the list-based step editor's "add step" picker.
 * Every `ScenarioNodeType` except START/END (which are implicit chain
 * endpoints, not user-insertable steps) appears in exactly one bucket.
 */
/** Step types that wait (a delay or a trigger) before the run goes on. */
export const WAIT_STEP_TYPES: ScenarioNodeType[] = [
  ScenarioNodeType.DELAY,
  ScenarioNodeType.REMOTE_START_TRIGGER,
  ScenarioNodeType.REMOTE_STOP_TRIGGER,
  ScenarioNodeType.STATUS_TRIGGER,
  ScenarioNodeType.CSMS_CALL_TRIGGER,
  ScenarioNodeType.RESERVATION_TRIGGER,
  ScenarioNodeType.CONNECTION_TRIGGER,
];

export const STEP_CATEGORIES: ReadonlyArray<{
  /** Stable English id (also keys the tile styles); show `labelKey`. */
  label: string;
  labelKey: MessageKey;
  types: AnyScenarioNodeType[];
}> = [
  {
    label: "Status",
    labelKey: "scenarios.category.status",
    types: [
      ScenarioNodeType.STATUS_CHANGE,
      ScenarioNodeType.STATUS_NOTIFICATION,
    ],
  },
  {
    label: "Transaction",
    labelKey: "scenarios.category.transaction",
    types: [
      ScenarioNodeType.TRANSACTION,
      ScenarioNodeType.RESERVE_NOW,
      ScenarioNodeType.CANCEL_RESERVATION,
    ],
  },
  {
    label: "Meter & EV",
    labelKey: "scenarios.category.meterEv",
    types: [ScenarioNodeType.METER_VALUE, ScenarioNodeType.CONNECTOR_PLUG],
  },
  {
    label: "Wait & Trigger",
    labelKey: "scenarios.category.waitTrigger",
    types: WAIT_STEP_TYPES,
  },
  {
    // Branching and run-state steps, and `parallel` / `join` (schema 1.9).
    // Loops are not nodes: they are back edges the block tree draws
    // (`wrapInLoop`), so they are not offered here.
    label: "Flow control",
    labelKey: "scenarios.category.flowControl",
    types: [
      ScenarioNodeType.SWITCH,
      ScenarioNodeType.CHOICE,
      ScenarioNodeType.SET_STATE,
      ScenarioFlowNodeType.PARALLEL,
      ScenarioFlowNodeType.JOIN,
    ],
  },
  {
    label: "OCPP messages",
    labelKey: "scenarios.category.ocppMessages",
    types: [
      ScenarioNodeType.OCPP_CALL,
      ScenarioNodeType.CALL_RESPONSE,
      ScenarioNodeType.NOTIFICATION,
      ScenarioNodeType.NOTIFY,
      ScenarioNodeType.DATA_TRANSFER,
    ],
  },
  {
    label: "Station quirks & config",
    labelKey: "scenarios.category.stationConfig",
    types: [
      ScenarioNodeType.CONFIG_SET,
      ScenarioNodeType.USE_BEHAVIOR,
      ScenarioNodeType.UNLOCK_OUTCOME,
      ScenarioNodeType.RESPONSE_OVERRIDE,
      ScenarioNodeType.INBOUND_POLICY,
      ScenarioNodeType.CERT_QUIRKS,
    ],
  },
];

/** Every user-insertable step type's one-to-three sentence help text, shown
 *  in the "add a step" picker's description pane. */
export const STEP_HELP: Readonly<
  Record<
    | Exclude<ScenarioNodeType, ScenarioNodeType.START | ScenarioNodeType.END>
    | ScenarioFlowNodeType,
    MessageKey
  >
> = {
  [ScenarioNodeType.STATUS_CHANGE]: "scenarios.stepHelp.statusChange",
  [ScenarioNodeType.STATUS_NOTIFICATION]:
    "scenarios.stepHelp.statusNotification",
  [ScenarioNodeType.TRANSACTION]: "scenarios.stepHelp.transaction",
  [ScenarioNodeType.UNLOCK_OUTCOME]: "scenarios.stepHelp.unlockOutcome",
  [ScenarioNodeType.METER_VALUE]: "scenarios.stepHelp.meterValue",
  [ScenarioNodeType.CONNECTOR_PLUG]: "scenarios.stepHelp.connectorPlug",
  [ScenarioNodeType.DELAY]: "scenarios.stepHelp.delay",
  [ScenarioNodeType.REMOTE_START_TRIGGER]:
    "scenarios.stepHelp.remoteStartTrigger",
  [ScenarioNodeType.REMOTE_STOP_TRIGGER]:
    "scenarios.stepHelp.remoteStopTrigger",
  [ScenarioNodeType.STATUS_TRIGGER]: "scenarios.stepHelp.statusTrigger",
  [ScenarioNodeType.CSMS_CALL_TRIGGER]: "scenarios.stepHelp.csmsCallTrigger",
  [ScenarioNodeType.RESERVATION_TRIGGER]:
    "scenarios.stepHelp.reservationTrigger",
  [ScenarioNodeType.CONNECTION_TRIGGER]: "scenarios.stepHelp.connectionTrigger",
  [ScenarioNodeType.SWITCH]: "scenarios.stepHelp.switch",
  [ScenarioNodeType.CHOICE]: "scenarios.stepHelp.choice",
  [ScenarioNodeType.SET_STATE]: "scenarios.stepHelp.setState",
  [ScenarioFlowNodeType.PARALLEL]: "scenarios.stepHelp.parallel",
  [ScenarioFlowNodeType.JOIN]: "scenarios.stepHelp.join",
  [ScenarioNodeType.OCPP_CALL]: "scenarios.stepHelp.ocppCall",
  [ScenarioNodeType.CALL_RESPONSE]: "scenarios.stepHelp.callResponse",
  [ScenarioNodeType.NOTIFICATION]: "scenarios.stepHelp.notification",
  [ScenarioNodeType.NOTIFY]: "scenarios.stepHelp.notify",
  [ScenarioNodeType.DATA_TRANSFER]: "scenarios.stepHelp.dataTransfer",
  [ScenarioNodeType.RESERVE_NOW]: "scenarios.stepHelp.reserveNow",
  [ScenarioNodeType.CANCEL_RESERVATION]: "scenarios.stepHelp.cancelReservation",
  [ScenarioNodeType.CONFIG_SET]: "scenarios.stepHelp.configSet",
  [ScenarioNodeType.USE_BEHAVIOR]: "scenarios.stepHelp.useBehavior",
  [ScenarioNodeType.RESPONSE_OVERRIDE]: "scenarios.stepHelp.responseOverride",
  [ScenarioNodeType.INBOUND_POLICY]: "scenarios.stepHelp.inboundPolicy",
  [ScenarioNodeType.CERT_QUIRKS]: "scenarios.stepHelp.certQuirks",
};

/** The step type a branch structure stands for. */
export const STRUCTURE_TYPE: Partial<
  Record<"loop" | "switch" | "choice", ScenarioNodeType>
> = {
  switch: ScenarioNodeType.SWITCH,
  choice: ScenarioNodeType.CHOICE,
};
