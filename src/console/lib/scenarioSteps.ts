import type { Edge } from "@xyflow/react";

import {
  type CancelReservationNodeData,
  type ConfigSetNodeData,
  type ConnectorPlugNodeData,
  type CsmsCallTriggerNodeData,
  type DataTransferNodeData,
  type DelayNodeData,
  type MeterValueNodeData,
  type NotificationNodeData,
  type RemoteStartTriggerNodeData,
  type RemoteStopTriggerNodeData,
  type ReservationTriggerNodeData,
  type ReserveNowNodeData,
  type ResponseOverrideNodeData,
  type ScenarioDefinition,
  type ScenarioNode,
  type ScenarioNodeData,
  ScenarioNodeType,
  type StatusChangeNodeData,
  type StatusNotificationNodeData,
  type StatusTriggerNodeData,
  type TransactionNodeData,
  type UnlockOutcomeNodeData,
} from "../../cp/application/scenario/ScenarioTypes";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";

/**
 * Maps a scenario graph (`nodes`/`edges`) to an ordered, list-editable
 * shape when it forms a single linear chain START → step[1] → … →
 * step[n] → (END). Most real scenarios in this repo are linear chains, so a
 * list-based editor can operate on `steps` directly instead of mounting
 * ReactFlow, and hand the result back to `rebuildLinearScenario`. The chain
 * is linear whether or not an END node terminates it — see `endNode` below.
 */
export interface LinearSteps {
  /**
   * false if any node has >1 outgoing edge (branch), a node exists that
   * the START→…→(END) walk never reaches (disconnected middle node), the
   * walk revisits a node (cycle), or there is no START node at all. A
   * missing END node does NOT make a clean chain non-linear (see `endNode`).
   */
  isLinear: boolean;
  /**
   * Ordered walk from START to the last reachable node, excluding the
   * START/END nodes themselves. Includes the terminal real (non-END) node
   * even when the scenario has no END node.
   */
  steps: ScenarioNode[];
  startNode: ScenarioNode | null;
  /**
   * The scenario's END node, or `null` if none exists. `null` can occur
   * even when `isLinear` is `true`: the v2 graph editor lets a user delete
   * the END node and persist the result, and a clean START→…→chain with no
   * END is still considered linear so the list editor can open it —
   * `rebuildLinearScenario` self-heals by creating a new END node on save.
   */
  endNode: ScenarioNode | null;
}

function findNodeByType(
  nodes: readonly ScenarioNode[],
  type: ScenarioNodeType,
): ScenarioNode | null {
  return nodes.find((n) => n.type === type) ?? null;
}

export function deriveLinearSteps(
  def: Pick<ScenarioDefinition, "nodes" | "edges">,
): LinearSteps {
  const startNode = findNodeByType(def.nodes, ScenarioNodeType.START);
  const endNode = findNodeByType(def.nodes, ScenarioNodeType.END);

  if (!startNode) {
    return { isLinear: false, steps: [], startNode: null, endNode };
  }

  const nodesById = new Map(def.nodes.map((n) => [n.id, n]));
  const steps: ScenarioNode[] = [];
  const visited = new Set<string>([startNode.id]);
  let isLinear = true;
  let current: ScenarioNode = startNode;

  while (true) {
    const outgoing = def.edges.filter((e) => e.source === current.id);
    if (outgoing.length > 1) {
      isLinear = false;
      break;
    }
    if (outgoing.length === 0) {
      break;
    }
    const targetId = outgoing[0].target;
    const targetNode = nodesById.get(targetId);
    if (!targetNode || visited.has(targetId)) {
      // Dangling edge target, or a cycle back to an already-visited node.
      isLinear = false;
      break;
    }
    visited.add(targetId);
    if (targetNode.type === ScenarioNodeType.END) {
      current = targetNode;
      break;
    }
    steps.push(targetNode);
    current = targetNode;
  }

  if (isLinear && visited.size !== def.nodes.length) {
    // Some node in the scenario was never reached by the walk — an orphan
    // / disconnected middle node.
    isLinear = false;
  }

  return { isLinear, steps, startNode, endNode };
}

export interface DisplayedSteps {
  /** The node set actually rendered by the run console's timeline, in
   *  display order. */
  steps: ScenarioNode[];
  isLinear: boolean;
}

/**
 * The node set the Scenario Run console's timeline (`RunTimeline`) renders:
 * `deriveLinearSteps`'s ordered walk for linear scenarios, or every
 * non-START/END node in definition order for branching ones (flagged there
 * with an "order approximate" banner). Exported from here — rather than
 * defined separately in `RunTimeline.tsx` and `ScenarioRunPage.tsx` — so the
 * header's "step k/n" count and the timeline's rendered list are always the
 * same set and can't drift: they used to disagree for branching scenarios,
 * where the header called `deriveLinearSteps` directly (a partial walk that
 * stops at the first branch) while the timeline showed the full node list.
 */
export function deriveDisplayedSteps(
  def: Pick<ScenarioDefinition, "nodes" | "edges">,
): DisplayedSteps {
  const linear = deriveLinearSteps(def);
  const steps = linear.isLinear
    ? linear.steps
    : def.nodes.filter(
        (n) =>
          n.type !== ScenarioNodeType.START && n.type !== ScenarioNodeType.END,
      );
  return { steps, isLinear: linear.isLinear };
}

/**
 * Rebuilds a scenario's `nodes`/`edges` from an ordered step list, keeping
 * (or creating, if absent) the START/END nodes, rewriting edges into a
 * single chain start→s1→…→sn→end, and repositioning every node on a
 * vertical grid so the v2 ReactFlow-based graph editor still renders the
 * result sanely. Never mutates `def` or any node in `orderedSteps`.
 */
export function rebuildLinearScenario(
  def: ScenarioDefinition,
  orderedSteps: ScenarioNode[],
): ScenarioDefinition {
  const startNode =
    findNodeByType(def.nodes, ScenarioNodeType.START) ??
    createDefaultNode(ScenarioNodeType.START);
  const endNode =
    findNodeByType(def.nodes, ScenarioNodeType.END) ??
    createDefaultNode(ScenarioNodeType.END);

  const positioned = [startNode, ...orderedSteps, endNode].map((n, idx) => ({
    ...n,
    position: { x: 250, y: idx * 120 },
  }));

  const edges: Edge[] = [];
  for (let i = 0; i < positioned.length - 1; i++) {
    edges.push({
      id: crypto.randomUUID(),
      source: positioned[i].id,
      target: positioned[i + 1].id,
    });
  }

  return {
    ...def,
    nodes: positioned,
    edges,
    updatedAt: new Date().toISOString(),
  };
}

export function insertStep(
  def: ScenarioDefinition,
  index: number,
  type: ScenarioNodeType,
): ScenarioDefinition {
  const linear = deriveLinearSteps(def);
  if (!linear.isLinear) return def;
  const steps = linear.steps;
  const clampedIndex = Math.max(0, Math.min(index, steps.length));
  const newNode = createDefaultNode(type);
  const newSteps = [
    ...steps.slice(0, clampedIndex),
    newNode,
    ...steps.slice(clampedIndex),
  ];
  return rebuildLinearScenario(def, newSteps);
}

export function removeStep(
  def: ScenarioDefinition,
  nodeId: string,
): ScenarioDefinition {
  const linear = deriveLinearSteps(def);
  if (!linear.isLinear) return def;
  const steps = linear.steps.filter((n) => n.id !== nodeId);
  return rebuildLinearScenario(def, steps);
}

export function moveStep(
  def: ScenarioDefinition,
  fromIndex: number,
  toIndex: number,
): ScenarioDefinition {
  const linear = deriveLinearSteps(def);
  if (!linear.isLinear) return def;
  const steps = [...linear.steps];
  const [moved] = steps.splice(fromIndex, 1);
  if (moved) {
    steps.splice(toIndex, 0, moved);
  }
  return rebuildLinearScenario(def, steps);
}

export function updateStepData(
  def: ScenarioDefinition,
  nodeId: string,
  data: ScenarioNodeData,
): ScenarioDefinition {
  const nodes = def.nodes.map((n) => (n.id === nodeId ? { ...n, data } : n));
  return { ...def, nodes, updatedAt: new Date().toISOString() };
}

/**
 * Default node data per `ScenarioNodeType`, mirroring the v2 ReactFlow
 * editor's palette (`createNodeByType` in
 * src/components/scenario/ScenarioEditor.tsx) for every type that palette
 * offers. RESERVE_NOW / CANCEL_RESERVATION aren't in that palette (its
 * switch falls through to a generic "Unknown" node for them); their
 * defaults here were derived from `ReserveNowNodeData` /
 * `CancelReservationNodeData`'s field shapes instead. RESERVATION_TRIGGER's
 * default matches the `{ label: "Wait for ReserveNow", timeout: 0 }` shape
 * already used by the cert16 reservation templates
 * (src/utils/scenarios/cert16-reservation-basic.json).
 */
export function createDefaultNode(type: ScenarioNodeType): ScenarioNode {
  const id = crypto.randomUUID();
  const position = { x: 0, y: 0 };

  switch (type) {
    case ScenarioNodeType.STATUS_CHANGE:
      return {
        id,
        type,
        position,
        data: {
          label: "Status Change",
          status: OCPPStatus.Available,
        } satisfies StatusChangeNodeData,
      };
    case ScenarioNodeType.TRANSACTION:
      return {
        id,
        type,
        position,
        data: {
          label: "Transaction",
          action: "start",
          tagId: "123456",
        } satisfies TransactionNodeData,
      };
    case ScenarioNodeType.METER_VALUE:
      return {
        id,
        type,
        position,
        data: {
          label: "Meter Value",
          value: 10,
          sendMessage: true,
        } satisfies MeterValueNodeData,
      };
    case ScenarioNodeType.DELAY:
      return {
        id,
        type,
        position,
        data: { label: "Delay", delaySeconds: 5 } satisfies DelayNodeData,
      };
    case ScenarioNodeType.NOTIFICATION:
      return {
        id,
        type,
        position,
        data: {
          label: "Notification",
          messageType: "Heartbeat",
          payload: {},
        } satisfies NotificationNodeData,
      };
    case ScenarioNodeType.CONNECTOR_PLUG:
      return {
        id,
        type,
        position,
        data: {
          label: "Connector Plug",
          action: "plugin",
        } satisfies ConnectorPlugNodeData,
      };
    case ScenarioNodeType.REMOTE_START_TRIGGER:
      return {
        id,
        type,
        position,
        data: {
          label: "Wait for RemoteStart",
          timeout: 0,
        } satisfies RemoteStartTriggerNodeData,
      };
    case ScenarioNodeType.REMOTE_STOP_TRIGGER:
      return {
        id,
        type,
        position,
        data: {
          label: "Wait for RemoteStop",
          timeout: 0,
        } satisfies RemoteStopTriggerNodeData,
      };
    case ScenarioNodeType.STATUS_TRIGGER:
      return {
        id,
        type,
        position,
        data: {
          label: "Wait for Status",
          targetStatus: OCPPStatus.Charging,
          timeout: 0,
        } satisfies StatusTriggerNodeData,
      };
    case ScenarioNodeType.RESERVE_NOW:
      return {
        id,
        type,
        position,
        data: {
          label: "Reserve Now",
          expiryMinutes: 30,
          idTag: "123456",
        } satisfies ReserveNowNodeData,
      };
    case ScenarioNodeType.CANCEL_RESERVATION:
      return {
        id,
        type,
        position,
        data: {
          label: "Cancel Reservation",
          reservationId: 1,
        } satisfies CancelReservationNodeData,
      };
    case ScenarioNodeType.RESERVATION_TRIGGER:
      return {
        id,
        type,
        position,
        data: {
          label: "Wait for ReserveNow",
          timeout: 0,
        } satisfies ReservationTriggerNodeData,
      };
    case ScenarioNodeType.STATUS_NOTIFICATION:
      return {
        id,
        type,
        position,
        data: {
          label: "Status Notification",
          status: OCPPStatus.Faulted,
          errorCode: "InternalError",
        } satisfies StatusNotificationNodeData,
      };
    case ScenarioNodeType.UNLOCK_OUTCOME:
      return {
        id,
        type,
        position,
        data: {
          label: "Unlock Outcome",
          outcome: "Unlocked",
        } satisfies UnlockOutcomeNodeData,
      };
    case ScenarioNodeType.CONFIG_SET:
      return {
        id,
        type,
        position,
        data: {
          label: "ConfigSet",
          key: "MeterValueSampleInterval",
          value: "30",
        } satisfies ConfigSetNodeData,
      };
    case ScenarioNodeType.DATA_TRANSFER:
      return {
        id,
        type,
        position,
        data: {
          label: "DataTransfer",
          vendorId: "com.example",
        } satisfies DataTransferNodeData,
      };
    case ScenarioNodeType.CSMS_CALL_TRIGGER:
      return {
        id,
        type,
        position,
        data: {
          label: "Wait for CSMS Call",
          action: "Reset",
          timeout: 0,
        } satisfies CsmsCallTriggerNodeData,
      };
    case ScenarioNodeType.RESPONSE_OVERRIDE:
      return {
        id,
        type,
        position,
        data: {
          label: "Response Override",
          action: "RemoteStartTransaction",
          status: "Rejected",
        } satisfies ResponseOverrideNodeData,
      };
    case ScenarioNodeType.START:
      return {
        id,
        type,
        position,
        data: { label: "Start", triggerOn: "connect" },
      };
    case ScenarioNodeType.END:
      return {
        id,
        type,
        position,
        data: { label: "End" },
      };
    default: {
      const exhaustiveCheck: never = type;
      throw new Error(`Unhandled ScenarioNodeType: ${String(exhaustiveCheck)}`);
    }
  }
}

/**
 * Builds a brand-new scenario with just START→END wired (no steps), a
 * manual trigger, and enabled=true — the starting point for the list-based
 * scenario editor's "new scenario" flow.
 */
export function createEmptyScenario(
  name: string,
  targetType: "chargePoint" | "connector",
  targetId?: number,
): ScenarioDefinition {
  const now = new Date().toISOString();
  const bare: ScenarioDefinition = {
    id: crypto.randomUUID(),
    name,
    targetType,
    ...(targetId !== undefined ? { targetId } : {}),
    nodes: [],
    edges: [],
    createdAt: now,
    updatedAt: now,
    trigger: { type: "manual" },
    enabled: true,
  };
  return rebuildLinearScenario(bare, []);
}

/**
 * One-line human summary of a step node's configuration, for a list-based
 * editor row. Falls back to the node's label for types without a bespoke
 * summary (and for START/END, which the list editor never renders as a
 * step but which may still flow through this function defensively).
 */
export function stepSummary(node: ScenarioNode): string {
  const label = node.data.label;

  switch (node.type) {
    case ScenarioNodeType.STATUS_CHANGE: {
      const d = node.data as StatusChangeNodeData;
      return `→ ${d.status}`;
    }
    case ScenarioNodeType.STATUS_NOTIFICATION: {
      const d = node.data as StatusNotificationNodeData;
      return `→ ${d.status}${d.errorCode ? ` · ${d.errorCode}` : ""}`;
    }
    case ScenarioNodeType.TRANSACTION: {
      const d = node.data as TransactionNodeData;
      return `${d.action}${d.tagId ? ` · tag ${d.tagId}` : ""}`;
    }
    case ScenarioNodeType.UNLOCK_OUTCOME: {
      const d = node.data as UnlockOutcomeNodeData;
      return d.outcome;
    }
    case ScenarioNodeType.METER_VALUE: {
      const d = node.data as MeterValueNodeData;
      if (d.useCurve) {
        return `curve · ${d.curvePoints?.length ?? 0} pts`;
      }
      return `${d.value} Wh${d.autoIncrement ? " · auto" : ""}`;
    }
    case ScenarioNodeType.CONNECTOR_PLUG: {
      const d = node.data as ConnectorPlugNodeData;
      return d.action;
    }
    case ScenarioNodeType.DELAY: {
      const d = node.data as DelayNodeData;
      return `${d.delaySeconds} s`;
    }
    case ScenarioNodeType.REMOTE_START_TRIGGER: {
      const d = node.data as RemoteStartTriggerNodeData;
      return `wait RemoteStart${d.timeout ? ` · ${d.timeout}s` : ""}`;
    }
    case ScenarioNodeType.REMOTE_STOP_TRIGGER: {
      const d = node.data as RemoteStopTriggerNodeData;
      return `wait RemoteStop${d.timeout ? ` · ${d.timeout}s` : ""}`;
    }
    case ScenarioNodeType.STATUS_TRIGGER: {
      const d = node.data as StatusTriggerNodeData;
      return `wait ${d.targetStatus}${d.timeout ? ` · ${d.timeout}s` : ""}`;
    }
    case ScenarioNodeType.CSMS_CALL_TRIGGER: {
      const d = node.data as CsmsCallTriggerNodeData;
      return `wait ${d.action}${d.timeout ? ` · ${d.timeout}s` : ""}`;
    }
    case ScenarioNodeType.RESERVATION_TRIGGER: {
      const d = node.data as ReservationTriggerNodeData;
      return `wait ReserveNow${d.timeout ? ` · ${d.timeout}s` : ""}`;
    }
    case ScenarioNodeType.RESERVE_NOW: {
      const d = node.data as ReserveNowNodeData;
      return `${d.idTag} · ${d.expiryMinutes}min`;
    }
    case ScenarioNodeType.CANCEL_RESERVATION: {
      const d = node.data as CancelReservationNodeData;
      return `#${d.reservationId}`;
    }
    case ScenarioNodeType.RESPONSE_OVERRIDE: {
      const d = node.data as ResponseOverrideNodeData;
      return `${d.action} → ${d.status}`;
    }
    case ScenarioNodeType.CONFIG_SET: {
      const d = node.data as ConfigSetNodeData;
      return `${d.key} = ${d.value}`;
    }
    case ScenarioNodeType.DATA_TRANSFER: {
      const d = node.data as DataTransferNodeData;
      return d.vendorId;
    }
    case ScenarioNodeType.NOTIFICATION: {
      const d = node.data as NotificationNodeData;
      return d.messageType;
    }
    default:
      return label;
  }
}

/**
 * Palette groupings for the list-based step editor's "add step" picker.
 * Every `ScenarioNodeType` except START/END (which are implicit chain
 * endpoints, not user-insertable steps) appears in exactly one bucket.
 */
export const STEP_CATEGORIES: ReadonlyArray<{
  label: string;
  types: ScenarioNodeType[];
}> = [
  {
    label: "Status",
    types: [
      ScenarioNodeType.STATUS_CHANGE,
      ScenarioNodeType.STATUS_NOTIFICATION,
    ],
  },
  {
    label: "Transaction",
    types: [ScenarioNodeType.TRANSACTION, ScenarioNodeType.UNLOCK_OUTCOME],
  },
  {
    label: "Meter & EV",
    types: [ScenarioNodeType.METER_VALUE, ScenarioNodeType.CONNECTOR_PLUG],
  },
  {
    label: "Wait & Trigger",
    types: [
      ScenarioNodeType.DELAY,
      ScenarioNodeType.REMOTE_START_TRIGGER,
      ScenarioNodeType.REMOTE_STOP_TRIGGER,
      ScenarioNodeType.STATUS_TRIGGER,
      ScenarioNodeType.CSMS_CALL_TRIGGER,
      ScenarioNodeType.RESERVATION_TRIGGER,
    ],
  },
  {
    label: "Advanced",
    types: [
      ScenarioNodeType.RESPONSE_OVERRIDE,
      ScenarioNodeType.CONFIG_SET,
      ScenarioNodeType.DATA_TRANSFER,
      ScenarioNodeType.NOTIFICATION,
      ScenarioNodeType.RESERVE_NOW,
      ScenarioNodeType.CANCEL_RESERVATION,
    ],
  },
];
