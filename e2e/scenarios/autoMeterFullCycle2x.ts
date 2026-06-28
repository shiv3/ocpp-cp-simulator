import type { ScenarioDefinition } from "../../src/cp/application/scenario/ScenarioTypes";
import { ScenarioNodeType } from "../../src/cp/application/scenario/ScenarioTypes";
import { OCPPStatus } from "../../src/cp/domain/types/OcppTypes";

const STAMP = "2026-01-01T00:00:00.000Z";
const POSITION = { x: 0, y: 0 };

export function makeAutoMeterFullCycle2x(): ScenarioDefinition {
  return {
    id: "e2e-2x-auto-meter-full-cycle",
    name: "E2E 2.x Auto Meter Full Cycle",
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
        data: { label: "Preparing", status: OCPPStatus.Preparing },
      },
      {
        id: "transaction-start",
        type: ScenarioNodeType.TRANSACTION,
        position: POSITION,
        data: {
          label: "Start Transaction",
          action: "start",
          tagId: "AUTO-METER-TAG",
        },
      },
      {
        id: "auto-meter",
        type: ScenarioNodeType.METER_VALUE,
        position: POSITION,
        data: {
          label: "Auto Meter",
          value: 0,
          sendMessage: false,
          autoIncrement: true,
          incrementInterval: 1,
          incrementAmount: 100,
          maxValue: 200,
        },
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
        data: { label: "Available", status: OCPPStatus.Available },
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
        id: "e-transaction-start-auto-meter",
        source: "transaction-start",
        target: "auto-meter",
      },
      {
        id: "e-auto-meter-transaction-stop",
        source: "auto-meter",
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
