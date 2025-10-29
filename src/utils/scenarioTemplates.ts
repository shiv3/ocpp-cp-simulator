import { ScenarioDefinition, ScenarioNodeType } from "../cp/types/ScenarioTypes";
import { OCPPStatus } from "../cp/OcppTypes";

export interface ScenarioTemplate {
  id: string;
  name: string;
  description: string;
  targetType: "chargePoint" | "connector";
  createScenario: (chargePointId: string, connectorId: number | null) => ScenarioDefinition;
}

/**
 * Template: Basic Charging Flow
 * Available -> Preparing -> Charging -> Finishing -> Available
 */
const basicChargingTemplate: ScenarioTemplate = {
  id: "basic-charging",
  name: "Basic Charging Flow",
  description: "Simple charging flow: Available → Preparing → Start Transaction → Charging → Stop Transaction → Available",
  targetType: "connector",
  createScenario: (chargePointId, connectorId) => ({
    id: `scenario-${Date.now()}`,
    name: "Basic Charging Flow",
    description: "Simple charging flow",
    targetType: "connector",
    targetId: connectorId ?? undefined,
    nodes: [
      {
        id: "start-1",
        type: ScenarioNodeType.START,
        position: { x: 250, y: 50 },
        data: { label: "Start" },
      },
      {
        id: "status-1",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: { x: 250, y: 150 },
        data: { label: "Set Available", status: OCPPStatus.Available },
      },
      {
        id: "status-2",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: { x: 250, y: 250 },
        data: { label: "Set Preparing", status: OCPPStatus.Preparing },
      },
      {
        id: "transaction-1",
        type: ScenarioNodeType.TRANSACTION,
        position: { x: 250, y: 350 },
        data: { label: "Start Transaction", action: "start", tagId: "RFID123456" },
      },
      {
        id: "delay-1",
        type: ScenarioNodeType.DELAY,
        position: { x: 250, y: 450 },
        data: { label: "Charging for 30s", delaySeconds: 30 },
      },
      {
        id: "transaction-2",
        type: ScenarioNodeType.TRANSACTION,
        position: { x: 250, y: 550 },
        data: { label: "Stop Transaction", action: "stop" },
      },
      {
        id: "status-3",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: { x: 250, y: 650 },
        data: { label: "Set Available", status: OCPPStatus.Available },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 250, y: 750 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e-start-1", source: "start-1", target: "status-1" },
      { id: "e-1-2", source: "status-1", target: "status-2" },
      { id: "e-2-3", source: "status-2", target: "transaction-1" },
      { id: "e-3-4", source: "transaction-1", target: "delay-1" },
      { id: "e-4-5", source: "delay-1", target: "transaction-2" },
      { id: "e-5-6", source: "transaction-2", target: "status-3" },
      { id: "e-6-end", source: "status-3", target: "end-1" },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }),
};

/**
 * Template: Charging with MeterValues
 * Includes periodic MeterValue sending during charging
 */
const chargingWithMeterValuesTemplate: ScenarioTemplate = {
  id: "charging-with-meter-values",
  name: "Charging with MeterValues",
  description: "Charging flow with periodic MeterValue updates every 10 seconds",
  targetType: "connector",
  createScenario: (chargePointId, connectorId) => ({
    id: `scenario-${Date.now()}`,
    name: "Charging with MeterValues",
    description: "Charging flow with MeterValue updates",
    targetType: "connector",
    targetId: connectorId ?? undefined,
    nodes: [
      {
        id: "start-1",
        type: ScenarioNodeType.START,
        position: { x: 250, y: 50 },
        data: { label: "Start" },
      },
      {
        id: "status-1",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: { x: 250, y: 150 },
        data: { label: "Set Available", status: OCPPStatus.Available },
      },
      {
        id: "status-2",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: { x: 250, y: 250 },
        data: { label: "Set Preparing", status: OCPPStatus.Preparing },
      },
      {
        id: "transaction-1",
        type: ScenarioNodeType.TRANSACTION,
        position: { x: 250, y: 350 },
        data: { label: "Start Transaction", action: "start", tagId: "RFID123456" },
      },
      {
        id: "meter-1",
        type: ScenarioNodeType.METER_VALUE,
        position: { x: 250, y: 450 },
        data: { label: "MeterValue 1kWh", value: 1000, sendMessage: true },
      },
      {
        id: "delay-1",
        type: ScenarioNodeType.DELAY,
        position: { x: 250, y: 550 },
        data: { label: "Wait 10s", delaySeconds: 10 },
      },
      {
        id: "meter-2",
        type: ScenarioNodeType.METER_VALUE,
        position: { x: 250, y: 650 },
        data: { label: "MeterValue 2kWh", value: 2000, sendMessage: true },
      },
      {
        id: "delay-2",
        type: ScenarioNodeType.DELAY,
        position: { x: 250, y: 750 },
        data: { label: "Wait 10s", delaySeconds: 10 },
      },
      {
        id: "meter-3",
        type: ScenarioNodeType.METER_VALUE,
        position: { x: 250, y: 850 },
        data: { label: "MeterValue 3kWh", value: 3000, sendMessage: true },
      },
      {
        id: "transaction-2",
        type: ScenarioNodeType.TRANSACTION,
        position: { x: 250, y: 950 },
        data: { label: "Stop Transaction", action: "stop" },
      },
      {
        id: "status-3",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: { x: 250, y: 1050 },
        data: { label: "Set Available", status: OCPPStatus.Available },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 250, y: 1150 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e-start-1", source: "start-1", target: "status-1" },
      { id: "e-1-2", source: "status-1", target: "status-2" },
      { id: "e-2-3", source: "status-2", target: "transaction-1" },
      { id: "e-3-4", source: "transaction-1", target: "meter-1" },
      { id: "e-4-5", source: "meter-1", target: "delay-1" },
      { id: "e-5-6", source: "delay-1", target: "meter-2" },
      { id: "e-6-7", source: "meter-2", target: "delay-2" },
      { id: "e-7-8", source: "delay-2", target: "meter-3" },
      { id: "e-8-9", source: "meter-3", target: "transaction-2" },
      { id: "e-9-10", source: "transaction-2", target: "status-3" },
      { id: "e-10-end", source: "status-3", target: "end-1" },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }),
};

/**
 * Template: Remote Start Flow (Event-based)
 * Waits for RemoteStartTransaction command, then executes charging flow
 */
const remoteStartTemplate: ScenarioTemplate = {
  id: "remote-start",
  name: "Remote Start Flow (Event-based)",
  description: "Event-based: Waits for RemoteStartTransaction → Preparing → Charging → Finishing → Available",
  targetType: "connector",
  createScenario: (chargePointId, connectorId) => ({
    id: `scenario-${Date.now()}`,
    name: "Remote Start Flow",
    description: "RemoteStartTransaction event-based flow",
    targetType: "connector",
    targetId: connectorId ?? undefined,
    nodes: [
      {
        id: "trigger-1",
        type: ScenarioNodeType.REMOTE_START_TRIGGER,
        position: { x: 250, y: 50 },
        data: { label: "Wait for RemoteStart", timeout: 0 },
      },
      {
        id: "status-1",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: { x: 250, y: 150 },
        data: { label: "Set Preparing", status: OCPPStatus.Preparing },
      },
      {
        id: "plug-1",
        type: ScenarioNodeType.CONNECTOR_PLUG,
        position: { x: 250, y: 250 },
        data: { label: "Plugin Connector", action: "plugin" },
      },
      {
        id: "transaction-1",
        type: ScenarioNodeType.TRANSACTION,
        position: { x: 250, y: 350 },
        data: { label: "Start Transaction", action: "start", tagId: "REMOTE123456" },
      },
      {
        id: "delay-1",
        type: ScenarioNodeType.DELAY,
        position: { x: 250, y: 450 },
        data: { label: "Charging 60s", delaySeconds: 60 },
      },
      {
        id: "transaction-2",
        type: ScenarioNodeType.TRANSACTION,
        position: { x: 250, y: 550 },
        data: { label: "Stop Transaction", action: "stop" },
      },
      {
        id: "status-2",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: { x: 250, y: 650 },
        data: { label: "Set Finishing", status: OCPPStatus.Finishing },
      },
      {
        id: "plug-2",
        type: ScenarioNodeType.CONNECTOR_PLUG,
        position: { x: 250, y: 750 },
        data: { label: "Unplug Connector", action: "plugout" },
      },
      {
        id: "status-3",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: { x: 250, y: 850 },
        data: { label: "Set Available", status: OCPPStatus.Available },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 250, y: 950 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e-trigger-1", source: "trigger-1", target: "status-1" },
      { id: "e-1-2", source: "status-1", target: "plug-1" },
      { id: "e-2-3", source: "plug-1", target: "transaction-1" },
      { id: "e-3-4", source: "transaction-1", target: "delay-1" },
      { id: "e-4-5", source: "delay-1", target: "transaction-2" },
      { id: "e-5-6", source: "transaction-2", target: "status-2" },
      { id: "e-6-7", source: "status-2", target: "plug-2" },
      { id: "e-7-8", source: "plug-2", target: "status-3" },
      { id: "e-8-end", source: "status-3", target: "end-1" },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }),
};

/**
 * Template: Error Recovery Flow
 * Demonstrates error handling and recovery
 */
const errorRecoveryTemplate: ScenarioTemplate = {
  id: "error-recovery",
  name: "Error Recovery Flow",
  description: "Handling errors during charging and recovery: Available → Preparing → Charging → Faulted → Available",
  targetType: "connector",
  createScenario: (chargePointId, connectorId) => ({
    id: `scenario-${Date.now()}`,
    name: "Error Recovery Flow",
    description: "Error handling and recovery scenario",
    targetType: "connector",
    targetId: connectorId ?? undefined,
    nodes: [
      {
        id: "start-1",
        type: ScenarioNodeType.START,
        position: { x: 250, y: 50 },
        data: { label: "Start" },
      },
      {
        id: "status-1",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: { x: 250, y: 150 },
        data: { label: "Set Available", status: OCPPStatus.Available },
      },
      {
        id: "status-2",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: { x: 250, y: 250 },
        data: { label: "Set Preparing", status: OCPPStatus.Preparing },
      },
      {
        id: "transaction-1",
        type: ScenarioNodeType.TRANSACTION,
        position: { x: 250, y: 350 },
        data: { label: "Start Transaction", action: "start", tagId: "RFID123456" },
      },
      {
        id: "delay-1",
        type: ScenarioNodeType.DELAY,
        position: { x: 250, y: 450 },
        data: { label: "Charging 10s", delaySeconds: 10 },
      },
      {
        id: "status-3",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: { x: 250, y: 550 },
        data: { label: "Set Faulted (Error)", status: OCPPStatus.Faulted },
      },
      {
        id: "delay-2",
        type: ScenarioNodeType.DELAY,
        position: { x: 250, y: 650 },
        data: { label: "Wait 5s", delaySeconds: 5 },
      },
      {
        id: "transaction-2",
        type: ScenarioNodeType.TRANSACTION,
        position: { x: 250, y: 750 },
        data: { label: "Stop Transaction", action: "stop" },
      },
      {
        id: "status-4",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: { x: 250, y: 850 },
        data: { label: "Set Available (Recovered)", status: OCPPStatus.Available },
      },
      {
        id: "end-1",
        type: ScenarioNodeType.END,
        position: { x: 250, y: 950 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e-start-1", source: "start-1", target: "status-1" },
      { id: "e-1-2", source: "status-1", target: "status-2" },
      { id: "e-2-3", source: "status-2", target: "transaction-1" },
      { id: "e-3-4", source: "transaction-1", target: "delay-1" },
      { id: "e-4-5", source: "delay-1", target: "status-3" },
      { id: "e-5-6", source: "status-3", target: "delay-2" },
      { id: "e-6-7", source: "delay-2", target: "transaction-2" },
      { id: "e-7-8", source: "transaction-2", target: "status-4" },
      { id: "e-8-end", source: "status-4", target: "end-1" },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }),
};

/**
 * All available templates
 */
export const scenarioTemplates: ScenarioTemplate[] = [
  basicChargingTemplate,
  chargingWithMeterValuesTemplate,
  remoteStartTemplate,
  errorRecoveryTemplate,
];

/**
 * Get template by ID
 */
export function getTemplateById(templateId: string): ScenarioTemplate | undefined {
  return scenarioTemplates.find((t) => t.id === templateId);
}
