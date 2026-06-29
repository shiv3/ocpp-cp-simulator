import type { ScenarioDefinition } from "../../src/cp/application/scenario/ScenarioTypes";
import { ScenarioNodeType } from "../../src/cp/application/scenario/ScenarioTypes";

const STAMP = "2026-01-01T00:00:00.000Z";
const POSITION = { x: 0, y: 0 };

export const DATA_TRANSFER_VENDOR_ID = "E2E";
export const DATA_TRANSFER_MESSAGE_ID = "scenario-data";
export const DATA_TRANSFER_PAYLOAD = "scenario-string-data";

export function makeDataTransferNode2x(): ScenarioDefinition {
  return {
    id: "e2e-2x-data-transfer-node",
    name: "E2E 2.x DataTransfer Node",
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
        id: "data-transfer",
        type: ScenarioNodeType.DATA_TRANSFER,
        position: POSITION,
        data: {
          label: "DataTransfer",
          vendorId: DATA_TRANSFER_VENDOR_ID,
          messageId: DATA_TRANSFER_MESSAGE_ID,
          data: DATA_TRANSFER_PAYLOAD,
        },
      },
      {
        id: "end",
        type: ScenarioNodeType.END,
        position: POSITION,
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e-start-data-transfer", source: "start", target: "data-transfer" },
      { id: "e-data-transfer-end", source: "data-transfer", target: "end" },
    ],
  } satisfies ScenarioDefinition;
}
