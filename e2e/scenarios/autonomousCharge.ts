import type { ScenarioDefinition } from "../../src/cp/application/scenario/ScenarioTypes";
import { ScenarioNodeType } from "../../src/cp/application/scenario/ScenarioTypes";
import { OCPPStatus } from "../../src/cp/domain/types/OcppTypes";

const STAMP = "2026-01-01T00:00:00.000Z";
const POSITION = { x: 0, y: 0 };

export function makeAutonomousCharge(): ScenarioDefinition {
  return {
    id: "e2e-autonomous-charge",
    name: "E2E Autonomous Charge",
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
        id: "transaction-start",
        type: ScenarioNodeType.TRANSACTION,
        position: POSITION,
        data: {
          label: "Start Transaction",
          action: "start",
          tagId: "AUTO-TAG",
        },
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
        id: "delay-after-meter",
        type: ScenarioNodeType.DELAY,
        position: POSITION,
        data: { label: "Yield After MeterValue", delaySeconds: 0 },
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
        id: "e-preparing-transaction-start",
        source: "status-preparing",
        target: "transaction-start",
      },
      {
        id: "e-transaction-start-meter-value",
        source: "transaction-start",
        target: "meter-value",
      },
      {
        id: "e-meter-value-delay",
        source: "meter-value",
        target: "delay-after-meter",
      },
      {
        id: "e-delay-transaction-stop",
        source: "delay-after-meter",
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
