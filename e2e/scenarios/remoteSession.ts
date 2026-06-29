import type { ScenarioDefinition } from "../../src/cp/application/scenario/ScenarioTypes";
import { ScenarioNodeType } from "../../src/cp/application/scenario/ScenarioTypes";
import { OCPPStatus } from "../../src/cp/domain/types/OcppTypes";

const STAMP = "2026-01-01T00:00:00.000Z";
const POSITION = { x: 0, y: 0 };

export function makeRemoteSession(): ScenarioDefinition {
  return {
    id: "e2e-remote-session",
    name: "E2E Remote Session",
    targetType: "connector",
    targetId: 1,
    trigger: { type: "manual" },
    defaultExecutionMode: "oneshot",
    enabled: true,
    createdAt: STAMP,
    updatedAt: STAMP,
    nodes: [
      {
        id: "start",
        type: ScenarioNodeType.START,
        position: POSITION,
        data: { label: "Start" },
      },
      {
        id: "status-preparing",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: POSITION,
        data: { label: "Set Preparing", status: OCPPStatus.Preparing },
      },
      {
        id: "remote-start",
        type: ScenarioNodeType.REMOTE_START_TRIGGER,
        position: POSITION,
        data: { label: "Wait RemoteStart", timeout: 0 },
      },
      {
        id: "transaction-start",
        type: ScenarioNodeType.TRANSACTION,
        position: POSITION,
        data: { label: "Start Transaction", action: "start" },
      },
      {
        id: "meter-value",
        type: ScenarioNodeType.METER_VALUE,
        position: POSITION,
        data: {
          label: "Send MeterValue",
          value: 1000,
          sendMessage: true,
          autoIncrement: false,
        },
      },
      {
        id: "remote-stop",
        type: ScenarioNodeType.REMOTE_STOP_TRIGGER,
        position: POSITION,
        data: { label: "Wait RemoteStop", timeout: 0 },
      },
      {
        id: "transaction-stop",
        type: ScenarioNodeType.TRANSACTION,
        position: POSITION,
        data: { label: "Stop Transaction", action: "stop" },
      },
      {
        id: "status-available",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: POSITION,
        data: { label: "Set Available", status: OCPPStatus.Available },
      },
      {
        id: "end",
        type: ScenarioNodeType.END,
        position: POSITION,
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e-start-preparing", source: "start", target: "status-preparing" },
      {
        id: "e-preparing-remote-start",
        source: "status-preparing",
        target: "remote-start",
      },
      {
        id: "e-remote-start-transaction-start",
        source: "remote-start",
        target: "transaction-start",
      },
      {
        id: "e-transaction-start-meter-value",
        source: "transaction-start",
        target: "meter-value",
      },
      {
        id: "e-meter-value-remote-stop",
        source: "meter-value",
        target: "remote-stop",
      },
      {
        id: "e-remote-stop-transaction-stop",
        source: "remote-stop",
        target: "transaction-stop",
      },
      {
        id: "e-transaction-stop-available",
        source: "transaction-stop",
        target: "status-available",
      },
      { id: "e-available-end", source: "status-available", target: "end" },
    ],
  } satisfies ScenarioDefinition;
}
