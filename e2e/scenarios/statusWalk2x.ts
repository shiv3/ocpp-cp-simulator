import type { ScenarioDefinition } from "../../src/cp/application/scenario/ScenarioTypes";
import { ScenarioNodeType } from "../../src/cp/application/scenario/ScenarioTypes";
import { OCPPStatus } from "../../src/cp/domain/types/OcppTypes";

const STAMP = "2026-01-01T00:00:00.000Z";
const POSITION = { x: 0, y: 0 };

export function makeStatusWalk2x(): ScenarioDefinition {
  return {
    id: "e2e-2x-status-walk",
    name: "E2E 2.x Status Walk",
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
        id: "status-available-start",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: POSITION,
        data: { label: "Available", status: OCPPStatus.Available },
      },
      {
        id: "status-preparing",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: POSITION,
        data: { label: "Preparing", status: OCPPStatus.Preparing },
      },
      {
        id: "status-charging",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: POSITION,
        data: { label: "Charging", status: OCPPStatus.Charging },
      },
      {
        id: "status-suspended-evse",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: POSITION,
        data: { label: "Suspended EVSE", status: OCPPStatus.SuspendedEVSE },
      },
      {
        id: "status-suspended-ev",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: POSITION,
        data: { label: "Suspended EV", status: OCPPStatus.SuspendedEV },
      },
      {
        id: "status-finishing",
        type: ScenarioNodeType.STATUS_CHANGE,
        position: POSITION,
        data: { label: "Finishing", status: OCPPStatus.Finishing },
      },
      {
        id: "status-available-end",
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
      {
        id: "e-start-available-start",
        source: "start",
        target: "status-available-start",
      },
      {
        id: "e-available-start-preparing",
        source: "status-available-start",
        target: "status-preparing",
      },
      {
        id: "e-preparing-charging",
        source: "status-preparing",
        target: "status-charging",
      },
      {
        id: "e-charging-suspended-evse",
        source: "status-charging",
        target: "status-suspended-evse",
      },
      {
        id: "e-suspended-evse-suspended-ev",
        source: "status-suspended-evse",
        target: "status-suspended-ev",
      },
      {
        id: "e-suspended-ev-finishing",
        source: "status-suspended-ev",
        target: "status-finishing",
      },
      {
        id: "e-finishing-available-end",
        source: "status-finishing",
        target: "status-available-end",
      },
      {
        id: "e-available-end-end",
        source: "status-available-end",
        target: "end",
      },
    ],
  } satisfies ScenarioDefinition;
}
