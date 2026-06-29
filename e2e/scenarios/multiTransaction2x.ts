import type { ScenarioDefinition } from "../../src/cp/application/scenario/ScenarioTypes";
import { ScenarioNodeType } from "../../src/cp/application/scenario/ScenarioTypes";

const STAMP = "2026-01-01T00:00:00.000Z";
const POSITION = { x: 0, y: 0 };

export function makeMultiTransaction2x(): ScenarioDefinition {
  return {
    id: "e2e-2x-multi-transaction",
    name: "E2E 2.x Multi Transaction",
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
        id: "tx1-start",
        type: ScenarioNodeType.TRANSACTION,
        position: POSITION,
        data: {
          label: "Start Transaction 1",
          action: "start",
          tagId: "MULTI-TAG-1",
        },
      },
      {
        id: "tx1-meter",
        type: ScenarioNodeType.METER_VALUE,
        position: POSITION,
        data: {
          label: "Meter 1",
          value: 100,
          sendMessage: true,
          autoIncrement: false,
        },
      },
      {
        id: "tx1-stop",
        type: ScenarioNodeType.TRANSACTION,
        position: POSITION,
        data: { label: "Stop Transaction 1", action: "stop" },
      },
      {
        id: "tx2-start",
        type: ScenarioNodeType.TRANSACTION,
        position: POSITION,
        data: {
          label: "Start Transaction 2",
          action: "start",
          tagId: "MULTI-TAG-2",
        },
      },
      {
        id: "tx2-meter",
        type: ScenarioNodeType.METER_VALUE,
        position: POSITION,
        data: {
          label: "Meter 2",
          value: 200,
          sendMessage: true,
          autoIncrement: false,
        },
      },
      {
        id: "tx2-stop",
        type: ScenarioNodeType.TRANSACTION,
        position: POSITION,
        data: { label: "Stop Transaction 2", action: "stop" },
      },
      {
        id: "end",
        type: ScenarioNodeType.END,
        position: POSITION,
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e-start-tx1-start", source: "start", target: "tx1-start" },
      { id: "e-tx1-start-meter", source: "tx1-start", target: "tx1-meter" },
      { id: "e-tx1-meter-stop", source: "tx1-meter", target: "tx1-stop" },
      { id: "e-tx1-stop-tx2-start", source: "tx1-stop", target: "tx2-start" },
      { id: "e-tx2-start-meter", source: "tx2-start", target: "tx2-meter" },
      { id: "e-tx2-meter-stop", source: "tx2-meter", target: "tx2-stop" },
      { id: "e-tx2-stop-end", source: "tx2-stop", target: "end" },
    ],
  } satisfies ScenarioDefinition;
}
