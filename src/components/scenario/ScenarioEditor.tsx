import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
  lazy,
  Suspense,
} from "react";
import {
  ReactFlow,
  Background,
  Controls,
  ControlButton,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  Connection,
  Edge,
  NodeProps,
  NodeTypes,
  ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ScenarioDefinition,
  ScenarioNodeType,
  ScenarioNode,
} from "../../cp/application/scenario/ScenarioTypes";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import { AutoMeterValueConfig } from "../../cp/domain/connector/MeterValueCurve";
import {
  meterNodeToCurveConfig,
  applyCurveConfigToMeterNode,
} from "./meterValueNodeConfig";
import {
  NODE_FORM_REGISTRY,
  isScenarioNodeType,
} from "./forms/nodeFormRegistry";
import type { NodeFormData } from "./forms/types";
import { serializeScenarioGraph } from "./scenarioSerialize";

// Dynamic import for heavy component (bundle-dynamic-imports)
const MeterValueCurveModal = lazy(() => import("../MeterValueCurveModal"));

// Import node components
import StatusChangeNode from "./nodes/StatusChangeNode";
import TransactionNode from "./nodes/TransactionNode";
import MeterValueNode from "./nodes/MeterValueNode";
import DelayNode from "./nodes/DelayNode";
import NotificationNode from "./nodes/NotificationNode";
import ConnectorPlugNode from "./nodes/ConnectorPlugNode";
import RemoteStartTriggerNode from "./nodes/RemoteStartTriggerNode";
import RemoteStopTriggerNode from "./nodes/RemoteStopTriggerNode";
import CsmsCallTriggerNode from "./nodes/CsmsCallTriggerNode";
import ResponseOverrideNode from "./nodes/ResponseOverrideNode";
import InboundPolicyNode from "./nodes/InboundPolicyNode";
import CertQuirksNode from "./nodes/CertQuirksNode";
import StatusTriggerNode from "./nodes/StatusTriggerNode";
import ReserveNowNode from "./nodes/ReserveNowNode";
import CancelReservationNode from "./nodes/CancelReservationNode";
import ReservationTriggerNode from "./nodes/ReservationTriggerNode";
import StartEndNode from "./nodes/StartEndNode";
import StatusNotificationNode from "./nodes/StatusNotificationNode";
import UnlockOutcomeNode from "./nodes/UnlockOutcomeNode";
import ConfigSetNode from "./nodes/ConfigSetNode";
import DataTransferNode from "./nodes/DataTransferNode";
import OcppCallNode from "./nodes/OcppCallNode";
import ConnectionTriggerNode from "./nodes/ConnectionTriggerNode";
import { LiveMeterReadingContext } from "./nodes/liveMeterReading";

import { useDataContext } from "../../data/providers/DataProvider";
import { useDarkMode } from "../../contexts/DarkModeContext";

/**
 * The ReactFlow graph editor of the web console's scenario editor (its Graph
 * view, for the scenarios the card graph cannot draw). The page owns the
 * definition, its metadata and Save: this editor edits the graph only and
 * reports each graph edit through `onGraphChange` — opening is not one, even
 * when that drops orphan edges. Hydrated once from `scenario`; remount
 * (`key`) to load another scenario.
 */
interface ScenarioEditorProps {
  /** With `connectorId`, the source of the live meter reading the Meter Value nodes show. */
  cpId: string;
  connectorId: number | null;
  scenario: ScenarioDefinition;
  onGraphChange: (graph: Pick<ScenarioDefinition, "nodes" | "edges">) => void;
}

type StartEndNodeWrapperProps = Omit<
  React.ComponentProps<typeof StartEndNode>,
  "nodeType"
>;

const StartScenarioNode: React.ComponentType<NodeProps> = (props) => (
  <StartEndNode
    {...(props as unknown as StartEndNodeWrapperProps)}
    nodeType="start"
  />
);

const EndScenarioNode: React.ComponentType<NodeProps> = (props) => (
  <StartEndNode
    {...(props as unknown as StartEndNodeWrapperProps)}
    nodeType="end"
  />
);

// Define custom node types
const nodeTypes: NodeTypes = {
  [ScenarioNodeType.STATUS_CHANGE]: StatusChangeNode,
  [ScenarioNodeType.TRANSACTION]: TransactionNode,
  [ScenarioNodeType.METER_VALUE]: MeterValueNode,
  [ScenarioNodeType.DELAY]: DelayNode,
  [ScenarioNodeType.NOTIFICATION]: NotificationNode,
  [ScenarioNodeType.CONNECTOR_PLUG]: ConnectorPlugNode,
  [ScenarioNodeType.REMOTE_START_TRIGGER]: RemoteStartTriggerNode,
  [ScenarioNodeType.REMOTE_STOP_TRIGGER]: RemoteStopTriggerNode,
  [ScenarioNodeType.CSMS_CALL_TRIGGER]: CsmsCallTriggerNode,
  [ScenarioNodeType.RESPONSE_OVERRIDE]: ResponseOverrideNode,
  [ScenarioNodeType.INBOUND_POLICY]: InboundPolicyNode,
  [ScenarioNodeType.CERT_QUIRKS]: CertQuirksNode,
  [ScenarioNodeType.STATUS_TRIGGER]: StatusTriggerNode,
  [ScenarioNodeType.RESERVE_NOW]: ReserveNowNode,
  [ScenarioNodeType.CANCEL_RESERVATION]: CancelReservationNode,
  [ScenarioNodeType.RESERVATION_TRIGGER]: ReservationTriggerNode,
  [ScenarioNodeType.STATUS_NOTIFICATION]: StatusNotificationNode,
  [ScenarioNodeType.UNLOCK_OUTCOME]: UnlockOutcomeNode,
  [ScenarioNodeType.CONFIG_SET]: ConfigSetNode,
  [ScenarioNodeType.DATA_TRANSFER]: DataTransferNode,
  [ScenarioNodeType.OCPP_CALL]: OcppCallNode,
  [ScenarioNodeType.CONNECTION_TRIGGER]: ConnectionTriggerNode,
  [ScenarioNodeType.START]: StartScenarioNode,
  [ScenarioNodeType.END]: EndScenarioNode,
};

// MiniMap fill per node type. Without an explicit nodeColor the minimap falls
// back to React Flow's default #e2e2e2, which is invisible against the
// light-mode white minimap background (the nodes looked unrendered). Colors
// roughly mirror each node's accent on the canvas.
const MINIMAP_NODE_COLORS: Record<string, string> = {
  [ScenarioNodeType.START]: "#22c55e",
  [ScenarioNodeType.END]: "#ef4444",
  [ScenarioNodeType.STATUS_CHANGE]: "#3b82f6",
  [ScenarioNodeType.STATUS_NOTIFICATION]: "#3b82f6",
  [ScenarioNodeType.TRANSACTION]: "#10b981",
  [ScenarioNodeType.METER_VALUE]: "#eab308",
  [ScenarioNodeType.DELAY]: "#64748b",
  [ScenarioNodeType.NOTIFICATION]: "#0ea5e9",
  [ScenarioNodeType.CONNECTOR_PLUG]: "#14b8a6",
  [ScenarioNodeType.REMOTE_START_TRIGGER]: "#6366f1",
  [ScenarioNodeType.REMOTE_STOP_TRIGGER]: "#a855f7",
  [ScenarioNodeType.STATUS_TRIGGER]: "#8b5cf6",
  [ScenarioNodeType.RESERVE_NOW]: "#f97316",
  [ScenarioNodeType.CANCEL_RESERVATION]: "#f43f5e",
  [ScenarioNodeType.RESERVATION_TRIGGER]: "#f59e0b",
  [ScenarioNodeType.UNLOCK_OUTCOME]: "#06b6d4",
  [ScenarioNodeType.CONFIG_SET]: "#6b7280",
  [ScenarioNodeType.DATA_TRANSFER]: "#a8a29e",
  [ScenarioNodeType.OCPP_CALL]: "#78716c",
  [ScenarioNodeType.CERT_QUIRKS]: "#f59e0b",
};

// slate-500 fallback — stays visible on both the white (light) and
// #1f2937 (dark) minimap backgrounds.
const MINIMAP_NODE_FALLBACK = "#64748b";

const ScenarioEditor: React.FC<ScenarioEditorProps> = ({
  cpId,
  connectorId,
  scenario,
  onGraphChange,
}) => {
  const { chargePointService } = useDataContext();
  const { isDark } = useDarkMode();
  // Latest callback without re-running the graph effect when the page
  // re-renders with a new closure.
  const onGraphChangeRef = useRef(onGraphChange);
  onGraphChangeRef.current = onGraphChange;
  // The last graph the page knows about, serialized: the opened one, then
  // each one reported. Opening the graph — and dropping its orphan edges —
  // is not an edit, so only a different graph is reported.
  const graphKeyRef = useRef<string | null>(null);

  // Hydrated once: the page feeds every graph change back as a new
  // `scenario` prop, and re-hydrating from it would reset the canvas and the
  // undo history on each edit.
  const [nodes, setNodes, onNodesChange] = useNodesState(scenario.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(scenario.edges);
  const [selectedNode, setSelectedNode] = useState<ScenarioNode | null>(null);
  const [formData, setFormData] = useState<NodeFormData>({});
  // The connector's live meter reading, shown on every Meter Value node
  // (`LiveMeterReadingContext`); null until the connector reports one.
  const [liveMeterValueWh, setMeterValue] = useState<number | null>(null);
  const [isCurveModalOpen, setIsCurveModalOpen] = useState(false);

  // Captured from `<ReactFlow onInit>` so handleAutoLayout can call
  // fitView() to re-frame the graph immediately after re-positioning.
  const rfInstanceRef = useRef<ReactFlowInstance<ScenarioNode, Edge> | null>(
    null,
  );

  // ── Undo / Redo history ───────────────────────────────────────────────
  // History is structural — we only push a new past entry when the graph
  // shape or node data changes. Pure position drags update the latest
  // snapshot in place so a subsequent undo still restores the right node
  // positions, but they don't pollute the stack.
  type HistorySnapshot = { nodes: ScenarioNode[]; edges: Edge[] };
  const historyRef = useRef<{
    past: HistorySnapshot[];
    future: HistorySnapshot[];
  }>({ past: [], future: [] });
  const prevSnapshotRef = useRef<HistorySnapshot | null>(null);
  const lastStructuralKeyRef = useRef<string>("");
  const skipHistoryRef = useRef<boolean>(false);
  const [historyTick, setHistoryTick] = useState(0);

  const structuralKey = useCallback(
    (ns: ScenarioNode[], es: Edge[]): string => {
      return JSON.stringify({
        n: ns.map((n) => ({ id: n.id, type: n.type, data: n.data })),
        e: es.map((e) => ({
          id: e.id,
          s: e.source,
          t: e.target,
          sh: e.sourceHandle ?? null,
          th: e.targetHandle ?? null,
          l: e.label ?? null,
        })),
      });
    },
    [],
  );

  // Re-fit the ReactFlow viewport once the scenario's nodes have flushed, so
  // the whole graph is in frame from the first paint (the editor remounts per
  // scenario, so this runs once per opened scenario).
  useEffect(() => {
    const instance = rfInstanceRef.current;
    if (!instance) return;
    // requestAnimationFrame so nodes/edges state has flushed before we
    // measure — `fitView` reads the DOM-resolved node positions.
    const handle = window.requestAnimationFrame(() => {
      try {
        instance.fitView({ padding: 0.2, duration: 0 });
      } catch {
        // First-mount races where the canvas isn't laid out yet — the
        // ResizeObserver below covers those.
      }
    });
    return () => window.cancelAnimationFrame(handle);
  }, [scenario.id]);

  // ResizeObserver-driven re-fit on container resize. Handles the case
  // where the tab becomes visible after the editor mounted (the tab
  // strip uses `display: none` for the inactive tab), the side panel is
  // dragged wider/narrower, or the window resizes.
  const flowContainerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = flowContainerRef.current;
    if (!el) return;
    let lastWidth = el.clientWidth;
    let lastHeight = el.clientHeight;
    const observer = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w === 0 || h === 0) return;
      if (w === lastWidth && h === lastHeight) return;
      lastWidth = w;
      lastHeight = h;
      try {
        rfInstanceRef.current?.fitView({ padding: 0.2, duration: 0 });
      } catch {
        // best effort
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Follow the connector's meter reading via the service event bus.
  useEffect(() => {
    if (!connectorId) return;

    const unsubscribe = chargePointService.subscribe(cpId, (event) => {
      if ("connectorId" in event && event.connectorId !== connectorId) return;
      if (event.type === "connector-meter") {
        setMeterValue(event.meterValue);
      }
    });

    // Pull the initial value from the snapshot.
    void chargePointService.getChargePoint(cpId).then((snapshot) => {
      if (!snapshot) return;
      const connector = snapshot.connectors.find((c) => c.id === connectorId);
      if (!connector) return;
      setMeterValue(connector.meterValue);
    });

    return () => unsubscribe();
  }, [chargePointService, cpId, connectorId]);

  // Report each graph edit to the page.
  useEffect(() => {
    // Clean up orphaned edges (edges pointing to non-existent nodes)
    const nodeIds = new Set(nodes.map((n) => n.id));
    const cleanedEdges = edges.filter((edge) => {
      const sourceExists = nodeIds.has(edge.source);
      const targetExists = nodeIds.has(edge.target);
      if (!sourceExists || !targetExists) {
        console.warn(
          `[ScenarioEditor] Removing orphaned edge: ${edge.source} -> ${edge.target}`,
        );
        return false;
      }
      return true;
    });

    // Update edges if any were removed
    if (cleanedEdges.length !== edges.length) {
      setEdges(cleanedEdges);
    }

    // The page owns the definition (and its trigger / metadata): report the
    // graph only, synchronously so its Save never misses an edit.
    const graph = serializeScenarioGraph(nodes, cleanedEdges);
    const graphKey = JSON.stringify(graph);
    const isOpening = graphKeyRef.current === null;
    if (graphKey === graphKeyRef.current) return;
    graphKeyRef.current = graphKey;
    if (!isOpening) onGraphChangeRef.current(graph);
  }, [nodes, edges, setEdges]);

  // Track structural changes for undo/redo. Position-only changes update
  // the latest snapshot silently so dragging doesn't fill the stack but
  // undo still restores the correct positions.
  useEffect(() => {
    const key = structuralKey(nodes, edges);

    if (skipHistoryRef.current) {
      skipHistoryRef.current = false;
      prevSnapshotRef.current = { nodes, edges };
      lastStructuralKeyRef.current = key;
      return;
    }

    if (prevSnapshotRef.current === null) {
      prevSnapshotRef.current = { nodes, edges };
      lastStructuralKeyRef.current = key;
      return;
    }

    if (lastStructuralKeyRef.current !== key) {
      const past = historyRef.current.past;
      past.push(prevSnapshotRef.current);
      if (past.length > 50) past.shift();
      historyRef.current.future = [];
      setHistoryTick((t) => t + 1);
    }

    prevSnapshotRef.current = { nodes, edges };
    lastStructuralKeyRef.current = key;
  }, [nodes, edges, structuralKey]);

  const handleUndo = useCallback(() => {
    const h = historyRef.current;
    if (h.past.length === 0) return;
    const prev = h.past.pop()!;
    h.future.push({ nodes, edges });
    skipHistoryRef.current = true;
    setNodes(prev.nodes);
    setEdges(prev.edges);
    setHistoryTick((t) => t + 1);
  }, [nodes, edges, setNodes, setEdges]);

  const handleRedo = useCallback(() => {
    const h = historyRef.current;
    if (h.future.length === 0) return;
    const next = h.future.pop()!;
    h.past.push({ nodes, edges });
    skipHistoryRef.current = true;
    setNodes(next.nodes);
    setEdges(next.edges);
    setHistoryTick((t) => t + 1);
  }, [nodes, edges, setNodes, setEdges]);

  // Keyboard shortcuts for undo / redo (Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z, Cmd/Ctrl+Y).
  // Ignored when the user is typing in an input/textarea so text edits in
  // node config / modals keep their own undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (target.isContentEditable) return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if ((k === "z" && e.shiftKey) || k === "y") {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleUndo, handleRedo]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => addEdge(connection, eds));
    },
    [setEdges],
  );

  // Handle node/edge deletion
  const onNodesDelete = useCallback(
    (deleted: ScenarioNode[]) => {
      // Close config panel if the deleted node is currently selected
      deleted.forEach((node) => {
        if (selectedNode?.id === node.id) {
          setSelectedNode(null);
        }
      });
    },
    [selectedNode],
  );

  // Delete selected nodes and edges
  const handleDeleteSelected = useCallback(() => {
    setNodes((nds) => nds.filter((node) => !node.selected));
    setEdges((eds) => eds.filter((edge) => !edge.selected));
    setSelectedNode(null);
  }, [setNodes, setEdges]);

  // Handle drag over for node palette
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  // Handle drop to add new node
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const type = event.dataTransfer.getData("application/reactflow");
      if (!type) return;

      // Check if Start or End node already exists (only one of each allowed)
      if (type === ScenarioNodeType.START) {
        const hasStart = nodes.some(
          (node) => node.type === ScenarioNodeType.START,
        );
        if (hasStart) {
          alert("Only one Start node is allowed per scenario");
          return;
        }
      }

      if (type === ScenarioNodeType.END) {
        const hasEnd = nodes.some((node) => node.type === ScenarioNodeType.END);
        if (hasEnd) {
          alert("Only one End node is allowed per scenario");
          return;
        }
      }

      const reactFlowBounds = event.currentTarget.getBoundingClientRect();
      const position = {
        x: event.clientX - reactFlowBounds.left - 90,
        y: event.clientY - reactFlowBounds.top - 30,
      };

      const newNode = createNodeByType(type, position);
      setNodes((nds) => nds.concat(newNode));
    },
    [setNodes, nodes],
  );

  /**
   * Lay nodes out top-to-bottom by topological depth. Roots (no incoming
   * edges) sit at depth 0, their children at depth 1, etc. Nodes that
   * share a depth are spread horizontally and centered around the canvas
   * mid-line. Cycles (uncommon for scenarios) fall back to depth 0.
   */
  const handleAutoLayout = useCallback(() => {
    if (nodes.length === 0) return;

    const COL = 280;
    const ROW = 140;
    const CENTER_X = 400;

    const incoming = new Map<string, number>();
    const outgoing = new Map<string, string[]>();
    for (const n of nodes) {
      incoming.set(n.id, 0);
      outgoing.set(n.id, []);
    }
    for (const e of edges) {
      if (incoming.has(e.target)) {
        incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);
      }
      if (outgoing.has(e.source)) {
        outgoing.get(e.source)!.push(e.target);
      }
    }

    const depth = new Map<string, number>();
    const remaining = new Map(incoming);
    const queue: string[] = [];
    for (const [id, count] of incoming) {
      if (count === 0) {
        depth.set(id, 0);
        queue.push(id);
      }
    }
    while (queue.length > 0) {
      const id = queue.shift()!;
      const d = depth.get(id) ?? 0;
      for (const next of outgoing.get(id) ?? []) {
        const newDepth = Math.max(depth.get(next) ?? 0, d + 1);
        depth.set(next, newDepth);
        const r = (remaining.get(next) ?? 1) - 1;
        remaining.set(next, r);
        if (r === 0) queue.push(next);
      }
    }
    // Any node not visited (cycle / disconnected) → park at depth 0.
    for (const n of nodes) {
      if (!depth.has(n.id)) depth.set(n.id, 0);
    }

    // Group by depth, stable in node order so re-layouts are deterministic.
    const byDepth = new Map<number, string[]>();
    for (const n of nodes) {
      const d = depth.get(n.id) ?? 0;
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d)!.push(n.id);
    }

    setNodes((prev) =>
      prev.map((n) => {
        const d = depth.get(n.id) ?? 0;
        const cohort = byDepth.get(d) ?? [];
        const idx = cohort.indexOf(n.id);
        const cohortWidth = (cohort.length - 1) * COL;
        return {
          ...n,
          position: {
            x: CENTER_X - cohortWidth / 2 + idx * COL,
            y: d * ROW,
          },
        };
      }),
    );

    // Re-frame the canvas around the newly positioned nodes. React Flow
    // needs the new positions to land first, so defer one frame. The
    // animated transition makes the change feel like a smooth zoom rather
    // than a jump.
    requestAnimationFrame(() => {
      rfInstanceRef.current?.fitView({ padding: 0.2, duration: 400 });
    });
  }, [nodes, edges, setNodes]);

  // Handle node double-click to open config panel.
  // Start/End are intentionally read-only from the config panel; Start's
  // trigger summary is shown inline on the node face.
  const handleNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: ScenarioNode) => {
      if (!isScenarioNodeType(node.type)) {
        return;
      }

      if (
        node.type === ScenarioNodeType.START ||
        node.type === ScenarioNodeType.END
      ) {
        return;
      }

      const entry = NODE_FORM_REGISTRY[node.type];
      setSelectedNode(node);
      setFormData(entry.nodeDataToForm(node.data));
    },
    [],
  );

  // Handle node config save
  const handleNodeConfigSave = useCallback(
    (nodeId: string, nodeType: ScenarioNodeType, newData: NodeFormData) => {
      const entry = NODE_FORM_REGISTRY[nodeType];
      const nodeData = entry.formToNodeData(newData);
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id === nodeId) {
            return { ...n, data: nodeData };
          }
          return n;
        }),
      );
    },
    [setNodes],
  );

  const getNodeTypeName = (type: string | undefined) =>
    isScenarioNodeType(type) ? NODE_FORM_REGISTRY[type].title : "Node";

  // Render node config form from the exhaustive registry.
  const renderNodeConfigForm = () => {
    if (!selectedNode || !isScenarioNodeType(selectedNode.type)) return null;

    const entry = NODE_FORM_REGISTRY[selectedNode.type];
    const NodeForm = entry.Component;

    return (
      <NodeForm
        value={formData}
        onChange={setFormData}
        onOpenMeterCurve={() => setIsCurveModalOpen(true)}
      />
    );
  };

  // Handle curve modal save. Maps the modal's "Charge until battery full"
  // checkbox onto the node's stopMode so the executor honors it (issue #95).
  const handleCurveModalSave = (config: AutoMeterValueConfig) => {
    setFormData(applyCurveConfigToMeterNode(formData, config));
    setIsCurveModalOpen(false);
  };

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-gray-900">
      {/* MeterValue Curve Config Modal (rendering-conditional-render + bundle-dynamic-imports) */}
      {isCurveModalOpen ? (
        <Suspense
          fallback={
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center">
              <div className="text-white">Loading...</div>
            </div>
          }
        >
          <MeterValueCurveModal
            isOpen={isCurveModalOpen}
            onClose={() => setIsCurveModalOpen(false)}
            initialConfig={meterNodeToCurveConfig(formData)}
            onSave={handleCurveModalSave}
          />
        </Suspense>
      ) : null}

      {/* Header — slim toolbar: undo / redo. The page around the editor
          saves, runs and edits the metadata. */}
      <div className="panel px-3 py-2 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <div className="flex items-center justify-end gap-2 min-w-0">
          <div className="flex gap-1 shrink-0">
            <button
              onClick={handleUndo}
              disabled={historyRef.current.past.length === 0}
              className="btn-secondary text-xs px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
              title="戻る (Undo · Cmd/Ctrl+Z)"
              data-history-tick={historyTick}
            >
              ↶
            </button>
            <button
              onClick={handleRedo}
              disabled={historyRef.current.future.length === 0}
              className="btn-secondary text-xs px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
              title="進む (Redo · Cmd/Ctrl+Shift+Z)"
              data-history-tick={historyTick}
            >
              ↷
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 flex gap-3 p-3 overflow-hidden min-h-0">
        {/* Left Column: Node Palette + Canvas */}
        <div className="flex-1 flex flex-col gap-3 overflow-hidden min-h-0">
          {/* Node Palette */}
          <div className="panel p-2 flex-shrink-0">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-primary">
                Node Palette
              </h3>
              <button
                onClick={handleDeleteSelected}
                className="btn-danger text-xs px-2 py-1"
                title="Delete selected nodes and edges (or press Delete/Backspace)"
              >
                🗑️ Delete Selected
              </button>
            </div>
            <div className="flex gap-2 flex-wrap">
              <NodePaletteItem
                type={ScenarioNodeType.START}
                label="Start"
                icon="🟢"
              />
              <NodePaletteItem
                type={ScenarioNodeType.END}
                label="End"
                icon="🔴"
              />
              <NodePaletteItem
                type={ScenarioNodeType.STATUS_CHANGE}
                label="Status"
                icon="📊"
              />
              <NodePaletteItem
                type={ScenarioNodeType.TRANSACTION}
                label="Transaction"
                icon="💳"
              />
              <NodePaletteItem
                type={ScenarioNodeType.METER_VALUE}
                label="Meter"
                icon="⚡"
              />
              <NodePaletteItem
                type={ScenarioNodeType.DELAY}
                label="Delay"
                icon="⏱️"
              />
              <NodePaletteItem
                type={ScenarioNodeType.NOTIFICATION}
                label="Message"
                icon="📤"
              />
              <NodePaletteItem
                type={ScenarioNodeType.CONNECTOR_PLUG}
                label="Plug"
                icon="🔌"
              />
              <NodePaletteItem
                type={ScenarioNodeType.STATUS_TRIGGER}
                label="StatusTrigger"
                icon="🚦"
              />
              <NodePaletteItem
                type={ScenarioNodeType.REMOTE_START_TRIGGER}
                label="RemoteStart"
                icon="🎬"
              />
              <NodePaletteItem
                type={ScenarioNodeType.REMOTE_STOP_TRIGGER}
                label="RemoteStop"
                icon="⏹"
              />
              <NodePaletteItem
                type={ScenarioNodeType.CSMS_CALL_TRIGGER}
                label="CSMS Call"
                icon="📥"
              />
              <NodePaletteItem
                type={ScenarioNodeType.CONNECTION_TRIGGER}
                label="Connection"
                icon="🔗"
              />
              <NodePaletteItem
                type={ScenarioNodeType.RESPONSE_OVERRIDE}
                label="Override"
                icon="🚫"
              />
              <NodePaletteItem
                type={ScenarioNodeType.INBOUND_POLICY}
                label="Inbound Policy"
                icon="🔐"
              />
              <NodePaletteItem
                type={ScenarioNodeType.STATUS_NOTIFICATION}
                label="StatusNotif"
                icon="📡"
              />
              <NodePaletteItem
                type={ScenarioNodeType.UNLOCK_OUTCOME}
                label="UnlockOutcome"
                icon="🔓"
              />
              <NodePaletteItem
                type={ScenarioNodeType.CONFIG_SET}
                label="ConfigSet"
                icon="🔧"
              />
              <NodePaletteItem
                type={ScenarioNodeType.DATA_TRANSFER}
                label="DataTransfer"
                icon="📦"
              />
              <NodePaletteItem
                type={ScenarioNodeType.OCPP_CALL}
                label="OCPP Call"
                icon="🧪"
              />
            </div>
          </div>

          {/* React Flow Canvas */}
          <div
            ref={flowContainerRef}
            className="flex-1 bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden min-h-0"
          >
            <LiveMeterReadingContext.Provider value={liveMeterValueWh}>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodesDelete={onNodesDelete}
                onConnect={onConnect}
                onDrop={onDrop}
                onDragOver={onDragOver}
                onNodeDoubleClick={handleNodeDoubleClick}
                nodeTypes={nodeTypes}
                deleteKeyCode={["Backspace", "Delete"]}
                fitView
                fitViewOptions={{ padding: 0.2 }}
                colorMode={isDark ? "dark" : "light"}
                onInit={(instance) => {
                  rfInstanceRef.current = instance;
                  // Fire one more fit on init — `fitView` prop fits before
                  // the instance is captured, so any subsequent
                  // node-set hydration that landed before this callback
                  // already had a fresh frame to land in.
                  try {
                    instance.fitView({ padding: 0.2, duration: 0 });
                  } catch {
                    // best effort
                  }
                }}
              >
                <Background />
                <Controls>
                  <ControlButton
                    onClick={handleAutoLayout}
                    title="Auto-arrange nodes top-to-bottom"
                    aria-label="Auto-arrange nodes"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="3" y="3" width="7" height="5" rx="1" />
                      <rect x="14" y="3" width="7" height="5" rx="1" />
                      <rect x="3" y="11" width="18" height="5" rx="1" />
                      <rect x="8" y="19" width="8" height="3" rx="1" />
                    </svg>
                  </ControlButton>
                </Controls>
                <MiniMap
                  pannable
                  zoomable
                  nodeColor={(node) =>
                    MINIMAP_NODE_COLORS[node.type ?? ""] ??
                    MINIMAP_NODE_FALLBACK
                  }
                  nodeStrokeColor={isDark ? "#0f172a" : "#cbd5e1"}
                  nodeStrokeWidth={2}
                  maskColor={
                    isDark
                      ? "rgba(15, 23, 42, 0.6)"
                      : "rgba(240, 240, 240, 0.6)"
                  }
                  style={{
                    backgroundColor: isDark ? "#1f2937" : "#ffffff",
                  }}
                />
              </ReactFlow>
            </LiveMeterReadingContext.Provider>
          </div>
        </div>

        {/* Right Column: Node Config Panel */}
        {selectedNode && (
          <div className="w-80 flex-shrink-0 panel p-4 overflow-y-auto max-h-full">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-primary">
                {getNodeTypeName(selectedNode.type)}
              </h3>
              <button
                onClick={() => setSelectedNode(null)}
                className="text-muted hover:text-primary"
              >
                ✕
              </button>
            </div>
            {renderNodeConfigForm()}
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => setSelectedNode(null)}
                className="flex-1 btn-secondary text-sm"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (isScenarioNodeType(selectedNode.type)) {
                    handleNodeConfigSave(
                      selectedNode.id,
                      selectedNode.type,
                      formData,
                    );
                  }
                  setSelectedNode(null);
                }}
                className="flex-1 btn-primary text-sm"
              >
                {/* Applies to the graph; the page's own Save persists it. */}
                Save
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// Node Palette Item Component
interface NodePaletteItemProps {
  type: string;
  label: string;
  icon: string;
}

const NodePaletteItem: React.FC<NodePaletteItemProps> = ({
  type,
  label,
  icon,
}) => {
  const onDragStart = (event: React.DragEvent) => {
    event.dataTransfer.setData("application/reactflow", type);
    event.dataTransfer.effectAllowed = "move";
  };

  return (
    <div
      draggable
      onDragStart={onDragStart}
      className="px-3 py-1 bg-gray-100 dark:bg-gray-700 rounded cursor-move hover:bg-gray-200 dark:hover:bg-gray-600 flex items-center gap-1 text-xs"
    >
      <span>{icon}</span>
      <span className="font-medium text-primary whitespace-nowrap">
        {label}
      </span>
    </div>
  );
};

// Helper function to create nodes
function createNodeByType(
  type: string,
  position: { x: number; y: number },
): ScenarioNode {
  const id = `${type}-${Date.now()}`;

  switch (type) {
    case ScenarioNodeType.STATUS_CHANGE:
      return {
        id,
        type,
        position,
        data: { label: "Status Change", status: OCPPStatus.Available },
      };
    case ScenarioNodeType.TRANSACTION:
      return {
        id,
        type,
        position,
        data: { label: "Transaction", action: "start", tagId: "123456" },
      };
    case ScenarioNodeType.METER_VALUE:
      return {
        id,
        type,
        position,
        data: { label: "Meter Value", value: 10, sendMessage: true },
      };
    case ScenarioNodeType.DELAY:
      return {
        id,
        type,
        position,
        data: { label: "Delay", delaySeconds: 5 },
      };
    case ScenarioNodeType.NOTIFICATION:
      return {
        id,
        type,
        position,
        data: { label: "Notification", messageType: "Heartbeat", payload: {} },
      };
    case ScenarioNodeType.CONNECTOR_PLUG:
      return {
        id,
        type,
        position,
        data: { label: "Connector Plug", action: "plugin" },
      };
    case ScenarioNodeType.REMOTE_START_TRIGGER:
      return {
        id,
        type,
        position,
        data: { label: "Wait for RemoteStart", timeout: 0 },
      };
    case ScenarioNodeType.REMOTE_STOP_TRIGGER:
      return {
        id,
        type,
        position,
        data: { label: "Wait for RemoteStop", timeout: 0 },
      };
    case ScenarioNodeType.CSMS_CALL_TRIGGER:
      return {
        id,
        type,
        position,
        data: { label: "Wait for CSMS Call", action: "Reset", timeout: 0 },
      };
    case ScenarioNodeType.CONNECTION_TRIGGER:
      return {
        id,
        type,
        position,
        data: {
          label: "Wait for Disconnect",
          event: "disconnected",
          timeout: 0,
        },
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
        },
      };
    case ScenarioNodeType.INBOUND_POLICY:
      return {
        id,
        type,
        position,
        data: {
          label: "Inbound Policy",
          action: "Reset",
          policy: "callerror",
          errorCode: "NotImplemented",
          errorDescription: "",
        },
      };
    case ScenarioNodeType.CERT_QUIRKS:
      return {
        id,
        type,
        position,
        data: {
          label: "Certificate Quirks",
          mode: "set",
        },
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
        },
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
        },
      };
    case ScenarioNodeType.UNLOCK_OUTCOME:
      return {
        id,
        type,
        position,
        data: { label: "Unlock Outcome", outcome: "Unlocked" },
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
        },
      };
    case ScenarioNodeType.DATA_TRANSFER:
      return {
        id,
        type,
        position,
        data: {
          label: "DataTransfer",
          vendorId: "com.example",
        },
      };
    case ScenarioNodeType.OCPP_CALL:
      return {
        id,
        type,
        position,
        data: {
          label: "OCPP call",
          action: "Heartbeat",
          payload: {},
        },
      };
    case ScenarioNodeType.START:
      return {
        id,
        type,
        position,
        // Default trigger is "connect", matching the historical behavior
        // where the scenario fired as soon as CP became Available after
        // BootNotification. Start is displayed inline and is not editable
        // through the node config panel.
        data: { label: "Start", triggerOn: "connect" },
      };
    case ScenarioNodeType.END:
      return {
        id,
        type,
        position,
        data: { label: "End" },
      };
    default:
      return {
        id,
        type: "default",
        position,
        data: { label: "Unknown" },
      };
  }
}

export default ScenarioEditor;
