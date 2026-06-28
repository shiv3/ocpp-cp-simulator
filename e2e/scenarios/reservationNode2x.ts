import type { ScenarioDefinition } from "../../src/cp/application/scenario/ScenarioTypes";
import { ScenarioNodeType } from "../../src/cp/application/scenario/ScenarioTypes";

const STAMP = "2026-01-01T00:00:00.000Z";
const POSITION = { x: 0, y: 0 };

export const RESERVATION_NODE_ID = 4201;

export function makeReservationNode2x(): ScenarioDefinition {
  return {
    id: "e2e-2x-reservation-node",
    name: "E2E 2.x Reservation Node",
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
        id: "reserve",
        type: ScenarioNodeType.RESERVE_NOW,
        position: POSITION,
        data: {
          label: "Reserve",
          expiryMinutes: 15,
          idTag: "RESERVE-TAG",
          reservationId: RESERVATION_NODE_ID,
        },
      },
      {
        id: "cancel",
        type: ScenarioNodeType.CANCEL_RESERVATION,
        position: POSITION,
        data: {
          label: "Cancel Reservation",
          reservationId: RESERVATION_NODE_ID,
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
      { id: "e-start-reserve", source: "start", target: "reserve" },
      { id: "e-reserve-cancel", source: "reserve", target: "cancel" },
      { id: "e-cancel-end", source: "cancel", target: "end" },
    ],
  } satisfies ScenarioDefinition;
}
