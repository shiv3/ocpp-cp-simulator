import {
  ScenarioDefinition,
  ScenarioNodeType,
} from "../cp/application/scenario/ScenarioTypes";
import { OCPPStatus } from "../cp/domain/types/OcppTypes";

export interface ScenarioTemplate {
  id: string;
  name: string;
  description: string;
  targetType: "chargePoint" | "connector";
  createScenario: (chargePointId: string, connectorId: number | null) => ScenarioDefinition;
}

/**
 * Template: Smart Charging with Auto MeterValue
 * ステータス変化をトリガーにして、自動的にMeterValueを増やす実用的なシナリオ
 */
const smartChargingTemplate: ScenarioTemplate = {
  id: "smart-charging",
  name: "Smart Charging (Auto MeterValue)",
  description: "Chargingになったら自動的にMeterValueを増やし、Finishingで停止",
  targetType: "connector",
  createScenario: (chargePointId, connectorId) => ({
    id: `scenario-${Date.now()}`,
    name: "Smart Charging",
    description: "Auto MeterValue with status triggers",
    targetType: "connector",
    targetId: connectorId ?? undefined,
    nodes: [
      {
        id: "start-1",
        type: ScenarioNodeType.START,
        position: { x: 400, y: 50 },
        data: { label: "Start" },
      },
      // Charging開始を待機
      {
        id: "trigger-charging",
        type: ScenarioNodeType.STATUS_TRIGGER,
        position: { x: 400, y: 150 },
        data: { label: "Wait for Charging", targetStatus: OCPPStatus.Charging, timeout: 0 },
      },
      // AutoMeterValueを開始（1kW/10秒、最大30kWh）
      {
        id: "meter-auto",
        type: ScenarioNodeType.METER_VALUE,
        position: { x: 400, y: 250 },
        data: {
          label: "Start Auto MeterValue",
          value: 0,
          sendMessage: true,
          autoIncrement: true,
          incrementInterval: 10,
          incrementAmount: 1000,
          maxValue: 30000,
          maxTime: 0,
        },
      },
      // Finishing/Availableを待機してAutoMeterValueを停止
      {
        id: "trigger-finish",
        type: ScenarioNodeType.STATUS_TRIGGER,
        position: { x: 400, y: 350 },
        data: { label: "Wait for Finishing", targetStatus: OCPPStatus.Finishing, timeout: 0 },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 400, y: 450 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e-start-charging", source: "start-1", target: "trigger-charging" },
      { id: "e-charging-meter", source: "trigger-charging", target: "meter-auto" },
      { id: "e-meter-finish", source: "meter-auto", target: "trigger-finish" },
      { id: "e-finish-end", source: "trigger-finish", target: "end-1" },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    trigger: {
      type: "manual",
    },
    defaultExecutionMode: "oneshot",
    enabled: true,
  }),
};

/**
 * Template: Multi-Status Monitor (Parallel)
 * 並列実行を活用して、複数のステータスを同時に監視
 */
const multiStatusMonitorTemplate: ScenarioTemplate = {
  id: "multi-status-monitor",
  name: "Multi-Status Monitor (Parallel)",
  description: "複数のステータスを並列で監視し、それぞれ異なる処理を実行",
  targetType: "connector",
  createScenario: (chargePointId, connectorId) => ({
    id: `scenario-${Date.now()}`,
    name: "Multi-Status Monitor",
    description: "Parallel status monitoring",
    targetType: "connector",
    targetId: connectorId ?? undefined,
    nodes: [
      {
        id: "start-1",
        type: ScenarioNodeType.START,
        position: { x: 400, y: 50 },
        data: { label: "Start" },
      },
      // Branch 1: Available -> Heartbeat送信
      {
        id: "trigger-available",
        type: ScenarioNodeType.STATUS_TRIGGER,
        position: { x: 150, y: 200 },
        data: { label: "Wait: Available", targetStatus: OCPPStatus.Available, timeout: 0 },
      },
      {
        id: "notify-available",
        type: ScenarioNodeType.NOTIFICATION,
        position: { x: 150, y: 300 },
        data: { label: "Send Heartbeat", messageType: "Heartbeat", payload: {} },
      },
      {
        id: "end-available",
        type: ScenarioNodeType.END,
        position: { x: 150, y: 400 },
        data: { label: "End" },
      },
      // Branch 2: Charging -> AutoMeterValue開始
      {
        id: "trigger-charging",
        type: ScenarioNodeType.STATUS_TRIGGER,
        position: { x: 400, y: 200 },
        data: { label: "Wait: Charging", targetStatus: OCPPStatus.Charging, timeout: 0 },
      },
      {
        id: "meter-charging",
        type: ScenarioNodeType.METER_VALUE,
        position: { x: 400, y: 300 },
        data: {
          label: "Auto MeterValue",
          value: 0,
          sendMessage: true,
          autoIncrement: true,
          incrementInterval: 10,
          incrementAmount: 1000,
          maxValue: 20000,
          maxTime: 0,
        },
      },
      {
        id: "end-charging",
        type: ScenarioNodeType.END,
        position: { x: 400, y: 400 },
        data: { label: "End" },
      },
      // Branch 3: Faulted -> エラーログ送信
      {
        id: "trigger-faulted",
        type: ScenarioNodeType.STATUS_TRIGGER,
        position: { x: 650, y: 200 },
        data: { label: "Wait: Faulted", targetStatus: OCPPStatus.Faulted, timeout: 0 },
      },
      {
        id: "notify-faulted",
        type: ScenarioNodeType.NOTIFICATION,
        position: { x: 650, y: 300 },
        data: { label: "Send Status", messageType: "StatusNotification", payload: { status: "Faulted" } },
      },
      {
        id: "end-faulted",
        type: ScenarioNodeType.END,
        position: { x: 650, y: 400 },
        data: { label: "End" },
      },
    ],
    edges: [
      // Branch 1
      { id: "e-start-available", source: "start-1", target: "trigger-available" },
      { id: "e-available-notify", source: "trigger-available", target: "notify-available" },
      { id: "e-notify-end1", source: "notify-available", target: "end-available" },
      // Branch 2
      { id: "e-start-charging", source: "start-1", target: "trigger-charging" },
      { id: "e-charging-meter", source: "trigger-charging", target: "meter-charging" },
      { id: "e-meter-end2", source: "meter-charging", target: "end-charging" },
      // Branch 3
      { id: "e-start-faulted", source: "start-1", target: "trigger-faulted" },
      { id: "e-faulted-notify", source: "trigger-faulted", target: "notify-faulted" },
      { id: "e-notify-end3", source: "notify-faulted", target: "end-faulted" },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    trigger: {
      type: "manual",
    },
    defaultExecutionMode: "oneshot",
    enabled: true,
  }),
};

/**
 * Template: Full Charging Cycle
 * 完全な充電サイクル：Available → Preparing → Charging(AutoMeterValue) → Finishing → Available
 */
const fullChargingCycleTemplate: ScenarioTemplate = {
  id: "full-charging-cycle",
  name: "Full Charging Cycle",
  description: "完全な充電サイクル with AutoMeterValue",
  targetType: "connector",
  createScenario: (chargePointId, connectorId) => ({
    id: `scenario-${Date.now()}`,
    name: "Full Charging Cycle",
    description: "Complete charging cycle",
    targetType: "connector",
    targetId: connectorId ?? undefined,
    nodes: [
      {
        id: "start-1",
        type: ScenarioNodeType.START,
        position: { x: 400, y: 50 },
        data: { label: "Start" },
      },
      {
        id: "status-available",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: { x: 400, y: 150 },
        data: { label: "Set Available", status: OCPPStatus.Available },
      },
      {
        id: "status-preparing",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: { x: 400, y: 250 },
        data: { label: "Set Preparing", status: OCPPStatus.Preparing },
      },
      {
        id: "transaction-start",
        type: ScenarioNodeType.TRANSACTION,
        position: { x: 400, y: 350 },
        data: {
          label: "Start Transaction",
          action: "start",
          tagId: "USER001",
          batteryCapacityKwh: 60,
          initialSoc: 20,
        },
      },
      {
        id: "status-charging",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: { x: 400, y: 450 },
        data: { label: "Set Charging", status: OCPPStatus.Charging },
      },
      {
        id: "meter-auto",
        type: ScenarioNodeType.METER_VALUE,
        position: { x: 400, y: 550 },
        data: {
          label: "Auto MeterValue",
          value: 0,
          sendMessage: true,
          autoIncrement: true,
          incrementInterval: 5,
          incrementAmount: 500,
          maxValue: 25000, // 25kWh
          maxTime: 300, // 5分
        },
      },
      {
        id: "delay-charging",
        type: ScenarioNodeType.DELAY,
        position: { x: 400, y: 650 },
        data: { label: "Charging Complete", delaySeconds: 5 },
      },
      {
        id: "transaction-stop",
        type: ScenarioNodeType.TRANSACTION,
        position: { x: 400, y: 750 },
        data: { label: "Stop Transaction", action: "stop" },
      },
      {
        id: "status-finishing",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: { x: 400, y: 850 },
        data: { label: "Set Finishing", status: OCPPStatus.Finishing },
      },
      {
        id: "status-available2",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: { x: 400, y: 950 },
        data: { label: "Set Available", status: OCPPStatus.Available },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 400, y: 1050 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e-start-available", source: "start-1", target: "status-available" },
      { id: "e-available-preparing", source: "status-available", target: "status-preparing" },
      { id: "e-preparing-txstart", source: "status-preparing", target: "transaction-start" },
      { id: "e-txstart-charging", source: "transaction-start", target: "status-charging" },
      { id: "e-charging-meter", source: "status-charging", target: "meter-auto" },
      { id: "e-meter-delay", source: "meter-auto", target: "delay-charging" },
      { id: "e-delay-txstop", source: "delay-charging", target: "transaction-stop" },
      { id: "e-txstop-finishing", source: "transaction-stop", target: "status-finishing" },
      { id: "e-finishing-available2", source: "status-finishing", target: "status-available2" },
      { id: "e-available2-end", source: "status-available2", target: "end-1" },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    trigger: {
      type: "manual",
    },
    defaultExecutionMode: "oneshot",
    enabled: true,
  }),
};

/**
 * Template: Status-Triggered Auto Actions
 * ステータス変化で自動実行される並列アクション
 */
const statusTriggeredActionsTemplate: ScenarioTemplate = {
  id: "status-triggered-actions",
  name: "Status-Triggered Auto Actions",
  description: "ステータス変化をトリガーに自動実行（Available時にHeartbeat送信ループ）",
  targetType: "connector",
  createScenario: (chargePointId, connectorId) => ({
    id: `scenario-${Date.now()}`,
    name: "Auto Heartbeat",
    description: "Periodic Heartbeat sender",
    targetType: "connector",
    targetId: connectorId ?? undefined,
    nodes: [
      {
        id: "start-1",
        type: ScenarioNodeType.START,
        position: { x: 400, y: 50 },
        data: { label: "Start" },
      },
      {
        id: "trigger-available",
        type: ScenarioNodeType.STATUS_TRIGGER,
        position: { x: 400, y: 150 },
        data: { label: "Wait for Available", targetStatus: OCPPStatus.Available, timeout: 0 },
      },
      {
        id: "notification-heartbeat",
        type: ScenarioNodeType.NOTIFICATION,
        position: { x: 400, y: 250 },
        data: { label: "Send Heartbeat", messageType: "Heartbeat", payload: {} },
      },
      {
        id: "delay-10s",
        type: ScenarioNodeType.DELAY,
        position: { x: 400, y: 350 },
        data: { label: "Wait 10s", delaySeconds: 10 },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 400, y: 450 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e-start-trigger", source: "start-1", target: "trigger-available" },
      { id: "e-trigger-notify", source: "trigger-available", target: "notification-heartbeat" },
      { id: "e-notify-delay", source: "notification-heartbeat", target: "delay-10s" },
      { id: "e-delay-notify", source: "delay-10s", target: "notification-heartbeat" }, // Loop back
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    trigger: {
      type: "statusChange",
      conditions: {
        toStatus: OCPPStatus.Available,
      },
    },
    defaultExecutionMode: "oneshot",
    enabled: true,
  }),
};

/**
 * Template: Remote Start with Auto MeterValue
 * RemoteStartをトリガーに充電開始＋AutoMeterValue
 */
const remoteStartAutoMeterTemplate: ScenarioTemplate = {
  id: "remote-start-auto-meter",
  name: "Remote Start + Auto MeterValue",
  description: "RemoteStartTransaction待機 → 充電開始 → AutoMeterValue",
  targetType: "connector",
  createScenario: (chargePointId, connectorId) => ({
    id: `scenario-${Date.now()}`,
    name: "Remote Start + Auto Meter",
    description: "Remote start with automatic meter value",
    targetType: "connector",
    targetId: connectorId ?? undefined,
    nodes: [
      {
        id: "start-1",
        type: ScenarioNodeType.START,
        position: { x: 400, y: 50 },
        data: { label: "Start" },
      },
      {
        id: "trigger-remote",
        type: ScenarioNodeType.REMOTE_START_TRIGGER,
        position: { x: 400, y: 150 },
        data: { label: "Wait RemoteStart", timeout: 0 },
      },
      {
        id: "status-preparing",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: { x: 400, y: 250 },
        data: { label: "Set Preparing", status: OCPPStatus.Preparing },
      },
      {
        id: "transaction-start",
        type: ScenarioNodeType.TRANSACTION,
        position: { x: 400, y: 350 },
        data: { label: "Start Transaction", action: "start", tagId: "REMOTE001" },
      },
      {
        id: "status-charging",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: { x: 400, y: 450 },
        data: { label: "Set Charging", status: OCPPStatus.Charging },
      },
      {
        id: "meter-auto",
        type: ScenarioNodeType.METER_VALUE,
        position: { x: 400, y: 550 },
        data: {
          label: "Auto MeterValue",
          value: 0,
          sendMessage: true,
          autoIncrement: true,
          incrementInterval: 10,
          incrementAmount: 1000,
          maxValue: 0, // unlimited
          maxTime: 0, // unlimited
        },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 400, y: 650 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e-start-remote", source: "start-1", target: "trigger-remote" },
      { id: "e-remote-preparing", source: "trigger-remote", target: "status-preparing" },
      { id: "e-preparing-tx", source: "status-preparing", target: "transaction-start" },
      { id: "e-tx-charging", source: "transaction-start", target: "status-charging" },
      { id: "e-charging-meter", source: "status-charging", target: "meter-auto" },
      { id: "e-meter-end", source: "meter-auto", target: "end-1" },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    trigger: {
      type: "manual",
    },
    defaultExecutionMode: "oneshot",
    enabled: true,
  }),
};

/**
 * All available templates
 */
export const scenarioTemplates: ScenarioTemplate[] = [
  fullChargingCycleTemplate,
  smartChargingTemplate,
  multiStatusMonitorTemplate,
  statusTriggeredActionsTemplate,
  remoteStartAutoMeterTemplate,
];

/**
 * Get template by ID
 */
export function getTemplateById(templateId: string): ScenarioTemplate | undefined {
  return scenarioTemplates.find((t) => t.id === templateId);
}
