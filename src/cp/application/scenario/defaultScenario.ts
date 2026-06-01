import type { ScenarioDefinition } from "./ScenarioTypes";

/**
 * Build a deterministic "demo charging" scenario for a (cpId, connectorId)
 * pair. Used to seed connectors that have no saved scenario yet so the
 * scenario editor never shows an empty canvas.
 *
 * Pure builder — no I/O. The id is derived from the (cpId, connectorId)
 * pair so repeated calls return the same id; the auto-start dedup logic
 * in ConnectorSidePanel relies on that stability.
 *
 * Lifted out of the legacy `src/utils/scenarioStorage.ts` so the
 * storage module can be deleted without breaking the UI that uses this
 * builder.
 */
export function createDefaultScenario(
  chargePointId: string,
  connectorId: number | null,
  name?: string,
): ScenarioDefinition {
  const targetType = connectorId === null ? "chargePoint" : "connector";
  const scenarioName =
    name ||
    `Scenario for ${
      targetType === "chargePoint"
        ? chargePointId
        : `${chargePointId} Connector ${connectorId}`
    }`;
  const now = new Date().toISOString();
  return {
    id: `${chargePointId}_${connectorId ?? "cp"}_default`,
    name: scenarioName,
    description:
      "Demo charging flow: plug-in → wait for RemoteStartTransaction → start → auto-meter → stop → plug-out.",
    targetType,
    targetId: connectorId ?? undefined,
    evSettings: {
      modelName: "Tesla Model 3",
      batteryCapacityKwh: 75,
      maxChargingPowerKw: 250,
      initialSoc: 20,
      targetSoc: 80,
    },
    nodes: [
      {
        id: "start",
        type: "start",
        position: { x: 400, y: 0 },
        data: { label: "Start" },
      },
      {
        id: "wait-boot",
        type: "delay",
        position: { x: 400, y: 100 },
        data: { label: "Wait for BootNotification", delaySeconds: 2 },
      },
      {
        id: "plug-in",
        type: "connectorPlug",
        position: { x: 400, y: 200 },
        data: { label: "Plug in", action: "plugin" },
      },
      {
        id: "wait-prepare",
        type: "delay",
        position: { x: 400, y: 300 },
        data: { label: "Settle", delaySeconds: 1 },
      },
      {
        id: "await-remote-start",
        type: "remoteStartTrigger",
        position: { x: 400, y: 400 },
        data: {
          label: "Wait for RemoteStartTransaction",
          description:
            "Block until the CSMS sends RemoteStartTransaction. The tagId from the request is forwarded to the next Transaction node.",
          timeout: 0,
        },
      },
      {
        id: "start-tx",
        type: "transaction",
        position: { x: 400, y: 500 },
        data: {
          label: "StartTransaction (tagId from RemoteStart)",
          action: "start",
          tagId: "TAG001",
        },
      },
      {
        id: "auto-meter",
        type: "meterValue",
        position: { x: 400, y: 600 },
        data: {
          label:
            "Auto MeterValue (1 kWh / 5s, stop when EV reaches target SoC)",
          value: 0,
          sendMessage: true,
          autoIncrement: true,
          incrementInterval: 5,
          incrementAmount: 1000,
          stopMode: "evSettings",
        },
      },
      {
        id: "stop-tx",
        type: "transaction",
        position: { x: 400, y: 700 },
        data: { label: "StopTransaction", action: "stop" },
      },
      {
        id: "plug-out",
        type: "connectorPlug",
        position: { x: 400, y: 800 },
        data: { label: "Plug out", action: "plugout" },
      },
      {
        id: "end",
        type: "end",
        position: { x: 400, y: 900 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e1", source: "start", target: "wait-boot" },
      { id: "e2", source: "wait-boot", target: "plug-in" },
      { id: "e3", source: "plug-in", target: "wait-prepare" },
      { id: "e4", source: "wait-prepare", target: "await-remote-start" },
      { id: "e5", source: "await-remote-start", target: "start-tx" },
      { id: "e6", source: "start-tx", target: "auto-meter" },
      { id: "e7", source: "auto-meter", target: "stop-tx" },
      { id: "e8", source: "stop-tx", target: "plug-out" },
      { id: "e9", source: "plug-out", target: "end" },
    ],
    createdAt: now,
    updatedAt: now,
    trigger: { type: "manual" },
    defaultExecutionMode: "oneshot",
    enabled: true,
  };
}
