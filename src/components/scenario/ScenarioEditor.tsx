import React, {
  useState,
  useCallback,
  useMemo,
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
  Node,
  Edge,
  NodeTypes,
  ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

import {
  ScenarioDefinition,
  ScenarioNodeType,
  ScenarioExecutionMode,
  ScenarioExecutionContext,
  ScenarioExecutionState,
} from "../../cp/application/scenario/ScenarioTypes";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import { AutoMeterValueConfig } from "../../cp/domain/connector/MeterValueCurve";
import {
  type EVSettings,
  EV_PRESETS,
} from "../../cp/domain/connector/EVSettings";

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
import StatusTriggerNode from "./nodes/StatusTriggerNode";
import ReserveNowNode from "./nodes/ReserveNowNode";
import CancelReservationNode from "./nodes/CancelReservationNode";
import ReservationTriggerNode from "./nodes/ReservationTriggerNode";
import StartEndNode from "./nodes/StartEndNode";
import StatusNotificationNode from "./nodes/StatusNotificationNode";
import UnlockOutcomeNode from "./nodes/UnlockOutcomeNode";
import ConfigSetNode from "./nodes/ConfigSetNode";
import DataTransferNode from "./nodes/DataTransferNode";

import {
  exportScenarioToJSON,
  importScenarioFromJSON,
} from "../../utils/scenarioFile";
import {
  scenarioTemplates,
  getTemplateById,
} from "../../utils/scenarioTemplates";

/**
 * Minimal Start → End scenario used as the editor's fallback when no
 * scenario has been loaded yet. The previous fallback (createDefaultScenario)
 * carried the full "plug-in → RemoteStart → auto-meter → plug-out" flow,
 * which auto-seeded itself back into storage after every Reset and made
 * the "Reset all simulator data" button feel like a no-op. Operators now
 * pick the canonical demo flow explicitly from the template picker (the
 * "Essential CP Behavior" template).
 */
function createEmptyScenario(
  chargePointId: string,
  connectorId: number | null,
): ScenarioDefinition {
  const targetType: "chargePoint" | "connector" =
    connectorId === null ? "chargePoint" : "connector";
  const now = new Date().toISOString();
  return {
    id: `${chargePointId}_${connectorId ?? "cp"}_empty`,
    name:
      targetType === "chargePoint"
        ? `Scenario for ${chargePointId}`
        : `Scenario for ${chargePointId} Connector ${connectorId}`,
    description: "",
    targetType,
    targetId: connectorId ?? undefined,
    nodes: [
      {
        id: "start",
        type: "start",
        position: { x: 400, y: 0 },
        data: { label: "Start" },
      },
      {
        id: "end",
        type: "end",
        position: { x: 400, y: 200 },
        data: { label: "End" },
      },
    ],
    edges: [{ id: "e-start-end", source: "start", target: "end" }],
    createdAt: now,
    updatedAt: now,
    trigger: { type: "manual" },
    defaultExecutionMode: "oneshot",
    enabled: true,
  };
}
import { ScenarioExecutor } from "../../cp/application/scenario/ScenarioExecutor";
import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import { useDataContext } from "../../data/providers/DataProvider";
import { useDarkMode } from "../../contexts/DarkModeContext";

interface ScenarioEditorProps {
  cpId: string;
  connectorId: number | null;
  scenario?: ScenarioDefinition | null;
  scenarioId?: string; // Optional: if provided, edit specific scenario
  executionContext?: ScenarioExecutionContext | null; // Execution context from ScenarioManager
  nodeProgress?: Record<string, { remaining: number; total: number }>; // Node progress from ScenarioManager
  onClose: () => void;
}

// Define custom node types
const nodeTypes: NodeTypes = {
  [ScenarioNodeType.STATUS_CHANGE]: StatusChangeNode,
  [ScenarioNodeType.TRANSACTION]: TransactionNode,
  [ScenarioNodeType.METER_VALUE]: MeterValueNode,
  [ScenarioNodeType.DELAY]: DelayNode,
  [ScenarioNodeType.NOTIFICATION]: NotificationNode,
  [ScenarioNodeType.CONNECTOR_PLUG]: ConnectorPlugNode,
  [ScenarioNodeType.REMOTE_START_TRIGGER]: RemoteStartTriggerNode,
  [ScenarioNodeType.STATUS_TRIGGER]: StatusTriggerNode,
  [ScenarioNodeType.RESERVE_NOW]: ReserveNowNode,
  [ScenarioNodeType.CANCEL_RESERVATION]: CancelReservationNode,
  [ScenarioNodeType.RESERVATION_TRIGGER]: ReservationTriggerNode,
  [ScenarioNodeType.STATUS_NOTIFICATION]: StatusNotificationNode,
  [ScenarioNodeType.UNLOCK_OUTCOME]: UnlockOutcomeNode,
  [ScenarioNodeType.CONFIG_SET]: ConfigSetNode,
  [ScenarioNodeType.DATA_TRANSFER]: DataTransferNode,
  [ScenarioNodeType.START]: (props) => (
    <StartEndNode {...props} nodeType="start" />
  ),
  [ScenarioNodeType.END]: (props) => <StartEndNode {...props} nodeType="end" />,
};

const ScenarioEditor: React.FC<ScenarioEditorProps> = ({
  cpId,
  connectorId,
  scenario: scenarioProp,
  scenarioId,
  executionContext: propsExecutionContext,
  nodeProgress: propsNodeProgress,
  // onClose is still required by the props interface for back-compat with
  // callers, but the editor itself no longer self-closes — the parent
  // panel owns its visibility now. Intentionally not destructured.
}) => {
  const { chargePointService, mode, defaultEvSettings, scenarioRepository } =
    useDataContext();
  const { isDark } = useDarkMode();
  const localCp: ChargePoint | null =
    mode === "local" && chargePointService.getLocalChargePoint
      ? (chargePointService.getLocalChargePoint(cpId) as ChargePoint | null)
      : null;

  // Initial scenario: when the caller hands us one via `scenarioProp`,
  // use it; otherwise start from the default and async-hydrate from the
  // repository in the effect below if a `scenarioId` was supplied. The
  // brief default-state flash before the async load completes is
  // acceptable for first-mount; the editor doesn't render different DOM
  // for a "loaded" vs "loading" scenario.
  const [scenario, setScenario] = useState<ScenarioDefinition>(
    () => scenarioProp ?? createEmptyScenario(cpId, connectorId),
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(scenario.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(scenario.edges);
  const [executionState, setExecutionState] =
    useState<ScenarioExecutionState>("idle");
  // executionMode is no longer surfaced — scenarios always run one-shot.
  // We keep a no-op setter so the existing call sites (which still pass a
  // ScenarioExecutionMode through ScenarioExecutor / ScenarioControlPanel)
  // continue to compile without surgery.
  const setExecutionMode = (_mode: ScenarioExecutionMode): void => {
    /* no-op */
  };
  const [executionContext, setExecutionContext] =
    useState<ScenarioExecutionContext | null>(null);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  // Connector status / meter / transactionId / CP status used to drive the
  // now-removed toolbar status strip. We still take the setters from useState
  // so the existing event handlers don't need rewiring, but the values
  // themselves are unused inside this component — the panel-level header
  // owns the visible status display.
  const [, setConnectorStatus] = useState<OCPPStatus>(OCPPStatus.Unavailable);
  const [liveMeterValueWh, setMeterValue] = useState<number>(0);
  const [, setTransactionId] = useState<number | null>(null);
  const [, setCpStatus] = useState<OCPPStatus>(OCPPStatus.Unavailable);
  const [nodeProgress, setNodeProgress] = useState<
    Record<string, { remaining: number; total: number }>
  >({});
  const [isCurveModalOpen, setIsCurveModalOpen] = useState(false);

  // Scenario metadata state
  const [scenarioName, setScenarioName] = useState(scenario.name);
  const [scenarioDescription, setScenarioDescription] = useState(
    scenario.description || "",
  );
  const [defaultExecutionMode, setDefaultExecutionMode] =
    useState<ScenarioExecutionMode>(scenario.defaultExecutionMode || "oneshot");
  const [scenarioEnabled, setScenarioEnabled] = useState(
    scenario.enabled !== false,
  );
  // Scenario-level EV settings — applied to the target connector at scenario
  // start (see ScenarioExecutor.start). Partial: only filled fields are
  // written; the others keep the connector's current values.
  const [scenarioEvSettings, setScenarioEvSettings] = useState<
    Partial<EVSettings>
  >(scenario.evSettings ?? {});
  const [isEvSettingsExpanded, setIsEvSettingsExpanded] = useState(true);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);

  const executorRef = useRef<ScenarioExecutor | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Captured from `<ReactFlow onInit>` so handleAutoLayout can call
  // fitView() to re-frame the graph immediately after re-positioning.
  const rfInstanceRef = useRef<ReactFlowInstance | null>(null);

  // ── Undo / Redo history ───────────────────────────────────────────────
  // History is structural — we only push a new past entry when the graph
  // shape or node data changes. Pure position drags update the latest
  // snapshot in place so a subsequent undo still restores the right node
  // positions, but they don't pollute the stack.
  type HistorySnapshot = { nodes: Node[]; edges: Edge[] };
  const historyRef = useRef<{
    past: HistorySnapshot[];
    future: HistorySnapshot[];
  }>({ past: [], future: [] });
  const prevSnapshotRef = useRef<HistorySnapshot | null>(null);
  const lastStructuralKeyRef = useRef<string>("");
  const skipHistoryRef = useRef<boolean>(false);
  const [historyTick, setHistoryTick] = useState(0);
  const [saveFeedback, setSaveFeedback] = useState<"idle" | "saved">("idle");
  const saveFeedbackTimerRef = useRef<number | null>(null);

  const structuralKey = useCallback((ns: Node[], es: Edge[]): string => {
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
  }, []);

  // Reload scenario when props change
  useEffect(() => {
    const resetHistory = () => {
      historyRef.current = { past: [], future: [] };
      prevSnapshotRef.current = null;
      lastStructuralKeyRef.current = "";
      skipHistoryRef.current = true;
      setHistoryTick((t) => t + 1);
    };
    if (scenarioProp) {
      setScenario(scenarioProp);
      setNodes(scenarioProp.nodes);
      setEdges(scenarioProp.edges);
      setScenarioName(scenarioProp.name);
      setScenarioDescription(scenarioProp.description || "");
      setDefaultExecutionMode(scenarioProp.defaultExecutionMode || "oneshot");
      setScenarioEnabled(scenarioProp.enabled !== false);
      setScenarioEvSettings(scenarioProp.evSettings ?? {});
      resetHistory();
      return;
    }

    if (scenarioId) {
      // Async lookup via the scenario repository (replaces the legacy
      // sync getScenarioById helper backed by localStorage). The
      // cancellation flag prevents a stale fetch from overwriting state
      // after the effect re-runs.
      let cancelled = false;
      void scenarioRepository.list(cpId).then((all) => {
        if (cancelled) return;
        const found = all.find(
          (s) =>
            s.id === scenarioId &&
            // Same filter `getScenarioById` used: prefer the scenario
            // targeted at this (cp, connector). null connector means
            // "CP-level scenarios only".
            (connectorId === null
              ? s.targetType !== "connector"
              : s.targetType !== "connector" || s.targetId === connectorId),
        );
        if (!found) return;
        setScenario(found);
        setNodes(found.nodes);
        setEdges(found.edges);
        setScenarioName(found.name);
        setScenarioDescription(found.description || "");
        setDefaultExecutionMode(found.defaultExecutionMode || "oneshot");
        setScenarioEnabled(found.enabled !== false);
        setScenarioEvSettings(found.evSettings ?? {});
        resetHistory();
      });
      return () => {
        cancelled = true;
      };
    }
  }, [
    scenarioProp,
    scenarioId,
    cpId,
    connectorId,
    scenarioRepository,
    setNodes,
    setEdges,
  ]);

  // Update execution context from props
  useEffect(() => {
    if (propsExecutionContext) {
      setExecutionContext(propsExecutionContext);
      setExecutionState(propsExecutionContext.state);
      setExecutionMode(propsExecutionContext.mode);
    } else {
      // Reset execution context when props are null
      setExecutionContext(null);
    }
  }, [propsExecutionContext]);

  // Update node progress from props
  useEffect(() => {
    if (propsNodeProgress) {
      setNodeProgress(propsNodeProgress);
    }
  }, [propsNodeProgress]);

  // Stable key over the node ID set — recomputes when nodes are added /
  // removed / replaced, but stays equal across pure style/position updates.
  // The highlight effect below uses this so that re-hydrating the editor
  // with a new scenario (e.g. opening the side panel mid-run, when the
  // graph swaps from the placeholder default to the running scenario)
  // forces the executing-node CSS to re-apply against the freshly loaded
  // node ids. Without this, the executor's context is the same object
  // ref each poll tick, the prop effect short-circuits, and the highlight
  // never gets a chance to run against the real nodes.
  const nodeIdKey = useMemo(() => nodes.map((n) => n.id).join("|"), [nodes]);

  // Update node styles based on execution context and progress
  useEffect(() => {
    // Reset styles if no execution context
    if (!executionContext) {
      setNodes((nds) =>
        nds.map((node) => ({
          ...node,
          className: (node.className || "")
            .replace(/executing-node|executed-node/g, "")
            .trim(),
          style: {
            ...node.style,
            border: undefined,
            boxShadow: undefined,
            opacity: 1,
          },
          data: {
            ...node.data,
            progress: undefined,
          },
        })),
      );
      return;
    }

    setNodes((nds) =>
      nds.map((node) => {
        const isCurrentNode = node.id === executionContext.currentNodeId;
        const isExecuted = executionContext.executedNodes.includes(node.id);
        const progress = nodeProgress[node.id];

        // Apply styles based on execution state
        let className = node.className || "";
        let style = { ...node.style };

        if (isCurrentNode) {
          // Highlight current executing node with green border
          className = `${className} executing-node`;
          style = {
            ...style,
            border: "3px solid #10b981",
            boxShadow: "0 0 10px rgba(16, 185, 129, 0.5)",
          };
        } else if (isExecuted) {
          // Mark executed nodes with gray background. Clear any previous
          // executing-node border/boxShadow explicitly — without this they
          // stick around because the previous branch left them set.
          className =
            `${className.replace(/executing-node/g, "")} executed-node`
              .replace(/\s+/g, " ")
              .trim();
          style = {
            ...style,
            border: undefined,
            boxShadow: undefined,
            opacity: 0.6,
          };
        } else {
          // Reset to default
          className = className
            .replace(/executing-node|executed-node/g, "")
            .trim();
          style = {
            ...style,
            border: undefined,
            boxShadow: undefined,
            opacity: 1,
          };
        }

        return {
          ...node,
          className,
          style,
          data: {
            ...node.data,
            progress: progress || undefined,
          },
        };
      }),
    );
  }, [executionContext, nodeProgress, setNodes, nodeIdKey]);

  // Push the connector's live meter reading into every MeterValue node's
  // `data.currentValue` so the node face renders the running total instead
  // of the static `data.value` from the scenario JSON. We don't mutate
  // `data.value` (that's the configured starting value); MeterValueNode
  // already prefers `currentValue` when present.
  useEffect(() => {
    setNodes((nds) => {
      let changed = false;
      const next = nds.map((node) => {
        if (node.type !== "meterValue") return node;
        const cur = (node.data as { currentValue?: number }).currentValue;
        if (cur === liveMeterValueWh) return node;
        changed = true;
        return {
          ...node,
          data: { ...node.data, currentValue: liveMeterValueWh },
        };
      });
      return changed ? next : nds;
    });
  }, [liveMeterValueWh, setNodes]);

  // In remote mode the in-browser executor is never set, so executionState
  // would stay "idle" forever and Force Step would keep re-running the
  // scenario. Sync executionState from scenario_* events instead.
  useEffect(() => {
    if (localCp) return;
    const unsub = chargePointService.subscribe(cpId, (event) => {
      if (
        event.type === "scenario-started" &&
        event.scenarioId === scenario.id
      ) {
        setExecutionState("running");
      } else if (
        (event.type === "scenario-completed" ||
          event.type === "scenario-error") &&
        event.scenarioId === scenario.id
      ) {
        setExecutionState("idle");
      }
    });
    return () => unsub();
  }, [localCp, chargePointService, cpId, scenario.id]);

  // Subscribe to connector status changes via the service event bus.
  useEffect(() => {
    if (!connectorId) return;

    const unsubscribe = chargePointService.subscribe(cpId, (event) => {
      if ("connectorId" in event && event.connectorId !== connectorId) return;
      if (event.type === "connector-status") {
        setConnectorStatus(event.status);
      } else if (event.type === "connector-meter") {
        setMeterValue(event.meterValue);
      } else if (event.type === "connector-transaction") {
        setTransactionId(event.transactionId);
      }
    });

    // Pull initial values from the snapshot.
    void chargePointService.getChargePoint(cpId).then((snapshot) => {
      if (!snapshot) return;
      const connector = snapshot.connectors.find((c) => c.id === connectorId);
      if (!connector) return;
      setConnectorStatus(connector.status);
      setMeterValue(connector.meterValue);
      setTransactionId(connector.transactionId);
    });

    return () => unsubscribe();
  }, [chargePointService, cpId, connectorId]);

  // Track CP-level status so we can hold the auto-start until the CSMS is
  // connected and BootNotification has been accepted. The CP starts in
  // Unavailable and flips to Available only after the boot result arrives.
  // Disconnect / reset events drop it back to Unavailable.
  useEffect(() => {
    const unsubscribe = chargePointService.subscribe(cpId, (event) => {
      if (event.type === "status") {
        setCpStatus(event.status);
      } else if (event.type === "disconnected") {
        setCpStatus(OCPPStatus.Unavailable);
      }
    });

    void chargePointService.getChargePoint(cpId).then((snapshot) => {
      if (!snapshot) return;
      setCpStatus(snapshot.status);
    });

    return () => unsubscribe();
  }, [chargePointService, cpId]);

  // Auto-save to localStorage when nodes, edges, or metadata change
  useEffect(() => {
    // Auto-detect trigger from nodes (if StatusTriggerNode exists)
    let autoTrigger: ScenarioDefinition["trigger"] = null;
    const statusTriggerNode = nodes.find(
      (node) => node.type === ScenarioNodeType.STATUS_TRIGGER,
    );

    if (statusTriggerNode) {
      const nodeData = statusTriggerNode.data as Record<string, unknown>;
      if (nodeData.targetStatus) {
        autoTrigger = {
          type: "statusChange" as const,
          conditions: {
            toStatus: nodeData.targetStatus as OCPPStatus,
          },
        };
        console.log(
          `[ScenarioEditor] Auto-detected trigger from StatusTriggerNode: toStatus=${nodeData.targetStatus}`,
        );
      }
    }

    // Use auto-detected trigger or default to manual
    const trigger = autoTrigger || { type: "manual" as const };

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

    // Drop empty / blank fields so we don't serialize useless `{}` blobs.
    const cleanedEvSettings: Partial<EVSettings> = {};
    (
      Object.entries(scenarioEvSettings) as [keyof EVSettings, unknown][]
    ).forEach(([k, v]) => {
      if (v === undefined || v === null || v === "") return;
      // @ts-expect-error narrowed by key
      cleanedEvSettings[k] = v;
    });

    const updatedScenario: ScenarioDefinition = {
      ...scenario,
      name: scenarioName,
      description: scenarioDescription,
      nodes,
      edges: cleanedEdges,
      trigger,
      defaultExecutionMode,
      enabled: scenarioEnabled,
      evSettings:
        Object.keys(cleanedEvSettings).length > 0
          ? cleanedEvSettings
          : undefined,
      updatedAt: new Date().toISOString(),
    };
    setScenario(updatedScenario);
    if (scenario.id) {
      // Auto-save through the repository (upsert). Fire-and-forget; if it
      // fails we log to console rather than block the in-flight edit.
      void scenarioRepository
        .save(cpId, connectorId, updatedScenario)
        .catch((err) => console.error("Failed to autosave scenario", err));
    }

    // Keep ScenarioManager in sync while editing (local mode only).
    if (localCp) {
      const connector = localCp.getConnector(connectorId || 1);
      if (connector?.scenarioManager) {
        void scenarioRepository.list(cpId).then((all) => {
          const scoped = all.filter((s) =>
            connectorId === null
              ? s.targetType !== "connector"
              : s.targetType !== "connector" || s.targetId === connectorId,
          );
          connector.scenarioManager?.loadScenarios(scoped);
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scenario is intentionally excluded to avoid infinite loop (this effect updates scenario)
  }, [
    nodes,
    edges,
    scenarioName,
    scenarioDescription,
    defaultExecutionMode,
    scenarioEnabled,
    scenarioEvSettings,
    setEdges,
    scenario.id,
    cpId,
    connectorId,
    localCp,
  ]);

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

  const handleManualSave = useCallback(() => {
    const cleanedEvSettings: Partial<EVSettings> = {};
    (
      Object.entries(scenarioEvSettings) as [keyof EVSettings, unknown][]
    ).forEach(([k, v]) => {
      if (v === undefined || v === null || v === "") return;
      // @ts-expect-error narrowed by key
      cleanedEvSettings[k] = v;
    });
    const trigger = scenario.trigger ?? { type: "manual" as const };
    const updated: ScenarioDefinition = {
      ...scenario,
      name: scenarioName,
      description: scenarioDescription,
      nodes,
      edges,
      trigger,
      defaultExecutionMode,
      enabled: scenarioEnabled,
      evSettings:
        Object.keys(cleanedEvSettings).length > 0
          ? cleanedEvSettings
          : undefined,
      updatedAt: new Date().toISOString(),
    };
    if (scenario.id) {
      void scenarioRepository
        .save(cpId, connectorId, updated)
        .catch((err) => console.error("Failed to save scenario", err));
    }
    setScenario(updated);
    setSaveFeedback("saved");
    if (saveFeedbackTimerRef.current !== null) {
      window.clearTimeout(saveFeedbackTimerRef.current);
    }
    saveFeedbackTimerRef.current = window.setTimeout(() => {
      setSaveFeedback("idle");
      saveFeedbackTimerRef.current = null;
    }, 1500);
  }, [
    scenario,
    scenarioName,
    scenarioDescription,
    nodes,
    edges,
    defaultExecutionMode,
    scenarioEnabled,
    scenarioEvSettings,
    cpId,
    connectorId,
  ]);

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
    (deleted: Node[]) => {
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

  // Scenario execution is owned by the connector card and ScenarioManager;
  // the editor only renders the graph and reacts to executionContext from
  // outside. The previous in-editor handleStart() useCallback lived here
  // but was orphaned by that refactor — see Connector.tsx for the current
  // start path.

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

  const handleForceStop = useCallback(() => {
    // Stop both in-process and remote executors. In local mode the executor
    // ref is set; in remote mode the server holds state and we must call
    // stopScenario / stopAllScenarios over the wire.
    executorRef.current?.stop();
    if (!localCp && connectorId != null) {
      void chargePointService
        .stopScenario(cpId, connectorId, scenario.id)
        .catch(() =>
          chargePointService
            .stopAllScenarios(cpId, connectorId)
            .catch(() => {}),
        );
    }
    setExecutionState("idle");
    setNodes((nds) => nds.map((n) => ({ ...n, style: {} })));
  }, [setNodes, localCp, connectorId, chargePointService, cpId, scenario.id]);

  // Auto-start now lives in `Connector.tsx` (the always-mounted card) so
  // it fires for every connector independently of whether the side panel
  // is open. The editor here only handles manual Start/Stop and visualizes
  // the running state of the connector's ScenarioManager.
  //
  // Keep the !scenarioEnabled / non-manual-trigger reset so the editor
  // still surfaces "scenario disabled" visually when the user toggles it.
  useEffect(() => {
    if (!localCp) return;
    if (!scenarioEnabled) {
      executorRef.current?.stop();
      setExecutionState("idle");
      return;
    }
    const hasStatusTriggerNode = nodes.some(
      (node) => node.type === ScenarioNodeType.STATUS_TRIGGER,
    );
    if (scenario.trigger?.type !== "manual" || hasStatusTriggerNode) {
      executorRef.current?.stop();
      setExecutionState("idle");
    }
  }, [scenarioEnabled, scenario.trigger?.type, nodes, localCp]);

  // File operations
  const handleExport = useCallback(() => {
    const currentScenario: ScenarioDefinition = {
      ...scenario,
      nodes,
      edges,
    };
    exportScenarioToJSON(currentScenario);
  }, [scenario, nodes, edges]);

  const handleImport = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      try {
        const imported = await importScenarioFromJSON(file);
        setScenario(imported);
        setNodes(imported.nodes);
        setEdges(imported.edges);

        // Repository.save is upsert (`INSERT … ON CONFLICT DO UPDATE`),
        // so we don't need to look the existing row up first.
        await scenarioRepository.save(cpId, connectorId, imported);
      } catch (error) {
        alert(`Failed to import scenario: ${error}`);
      }
    },
    [cpId, connectorId, scenarioRepository, setNodes, setEdges],
  );

  const handleLoadTemplate = useCallback(
    (templateId: string) => {
      const template = getTemplateById(templateId);
      if (!template) {
        alert("Template not found");
        return;
      }

      if (
        nodes.length > 2 &&
        !window.confirm("Discard the current scenario and load the template?")
      ) {
        return;
      }

      const templateScenario = template.createScenario(cpId, connectorId);
      setScenario(templateScenario);
      setNodes(templateScenario.nodes);
      setEdges(templateScenario.edges);

      // Templates are always new scenarios, so save them (upsert via repo).
      void scenarioRepository
        .save(cpId, connectorId, templateScenario)
        .catch((err) => console.error("Failed to save template scenario", err));
    },
    [cpId, connectorId, scenarioRepository, nodes.length, setNodes, setEdges],
  );

  // Handle node double-click to open config panel
  const handleNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      // Don't open config for start/end nodes
      if (
        node.type === ScenarioNodeType.START ||
        node.type === ScenarioNodeType.END
      ) {
        return;
      }
      setSelectedNode(node);
      setFormData({ ...node.data });
    },
    [],
  );

  // Handle node config save
  const handleNodeConfigSave = useCallback(
    (nodeId: string, newData: Record<string, unknown>) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id === nodeId) {
            return { ...n, data: { ...n.data, ...newData } };
          }
          return n;
        }),
      );
    },
    [setNodes],
  );

  // Get scenario state color class
  const getScenarioStateColor = (state: ScenarioExecutionState) => {
    switch (state) {
      case "idle":
        return "text-gray-600 dark:text-gray-400";
      case "running":
        return "text-green-600 dark:text-green-400";
      case "paused":
        return "text-yellow-600 dark:text-yellow-400";
      case "waiting":
        return "text-orange-600 dark:text-orange-400";
      case "stepping":
        return "text-purple-600 dark:text-purple-400";
      case "completed":
        return "text-emerald-600 dark:text-emerald-400";
      case "error":
        return "text-red-600 dark:text-red-400";
      default:
        return "text-gray-600 dark:text-gray-400";
    }
  };

  // Get scenario state indicator
  const getScenarioStateIndicator = (state: ScenarioExecutionState) => {
    switch (state) {
      case "idle":
        return <span className="text-gray-500 dark:text-gray-400">●</span>;
      case "running":
        return <span className="text-green-500 animate-pulse">●</span>;
      case "paused":
        return <span className="text-yellow-500">⏸</span>;
      case "waiting":
        return <span className="text-orange-500 animate-pulse">⏳</span>;
      case "stepping":
        return <span className="text-purple-500">⏯</span>;
      case "completed":
        return <span className="text-emerald-500">✓</span>;
      case "error":
        return <span className="text-red-500">✗</span>;
      default:
        return <span className="text-gray-500 dark:text-gray-400">●</span>;
    }
  };

  // Get node type display name
  const getNodeTypeName = (type: string) => {
    switch (type) {
      case ScenarioNodeType.STATUS_CHANGE:
        return "Status Change";
      case ScenarioNodeType.TRANSACTION:
        return "Transaction";
      case ScenarioNodeType.METER_VALUE:
        return "Meter Value";
      case ScenarioNodeType.DELAY:
        return "Delay";
      case ScenarioNodeType.NOTIFICATION:
        return "Notification";
      case ScenarioNodeType.CONNECTOR_PLUG:
        return "Connector Plug";
      case ScenarioNodeType.REMOTE_START_TRIGGER:
        return "Remote Start Trigger";
      case ScenarioNodeType.STATUS_TRIGGER:
        return "Status Trigger";
      default:
        return "Node";
    }
  };

  // Render node config form based on type
  const renderNodeConfigForm = () => {
    if (!selectedNode) return null;

    switch (selectedNode.type) {
      case ScenarioNodeType.STATUS_CHANGE:
        return (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">
                Label
              </label>
              <input
                type="text"
                className="input-base w-full text-sm"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">
                Status
              </label>
              <select
                className="input-base w-full text-sm"
                value={formData.status || OCPPStatus.Available}
                onChange={(e) =>
                  setFormData({ ...formData, status: e.target.value })
                }
              >
                {Object.values(OCPPStatus).map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>
          </div>
        );

      case ScenarioNodeType.TRANSACTION:
        return (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">
                Label
              </label>
              <input
                type="text"
                className="input-base w-full text-sm"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">
                Action
              </label>
              <select
                className="input-base w-full text-sm"
                value={formData.action || "start"}
                onChange={(e) =>
                  setFormData({ ...formData, action: e.target.value })
                }
              >
                <option value="start">Start Transaction</option>
                <option value="stop">Stop Transaction</option>
              </select>
            </div>
            {formData.action === "start" && (
              <div>
                <label className="block text-xs font-semibold text-primary mb-1">
                  Tag ID
                </label>
                <input
                  type="text"
                  className="input-base w-full text-sm"
                  value={formData.tagId || ""}
                  onChange={(e) =>
                    setFormData({ ...formData, tagId: e.target.value })
                  }
                  placeholder="RFID123456"
                />
              </div>
            )}
          </div>
        );

      case ScenarioNodeType.METER_VALUE:
        return (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">
                Label
              </label>
              <input
                type="text"
                className="input-base w-full text-sm"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">
                Initial Value (Wh)
              </label>
              <input
                type="number"
                className="input-base w-full text-sm"
                value={formData.value || 0}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    value: parseInt(e.target.value) || 0,
                  })
                }
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="sendMessage"
                checked={formData.sendMessage || false}
                onChange={(e) =>
                  setFormData({ ...formData, sendMessage: e.target.checked })
                }
                className="w-4 h-4"
              />
              <label
                htmlFor="sendMessage"
                className="text-xs font-semibold text-primary"
              >
                Send MeterValue Message
              </label>
            </div>
            <div className="border-t border-gray-200 dark:border-gray-700 pt-3">
              <div className="flex items-center gap-2 mb-2">
                <input
                  type="checkbox"
                  id="autoIncrement"
                  checked={formData.autoIncrement || false}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      autoIncrement: e.target.checked,
                    })
                  }
                  className="w-4 h-4"
                />
                <label
                  htmlFor="autoIncrement"
                  className="text-xs font-semibold text-primary"
                >
                  Auto Increment
                </label>
              </div>
              {formData.autoIncrement && (
                <div className="ml-6 space-y-3">
                  {/* Stop mode toggle. "manual" reads maxTime/maxValue
                      from this node; "evSettings" derives the stop point
                      from the scenario's EV settings. */}
                  <div>
                    <label className="block text-xs font-semibold text-primary mb-1">
                      Stop Mode
                    </label>
                    <select
                      className="input-base w-full text-sm"
                      value={(formData.stopMode as string) || "manual"}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          stopMode: e.target.value as "manual" | "evSettings",
                        })
                      }
                    >
                      <option value="manual">
                        Manual (use maxTime / maxValue below)
                      </option>
                      <option value="evSettings">
                        EV Settings (delivered kWh from EV)
                      </option>
                    </select>
                    {formData.stopMode === "evSettings" ? (
                      <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400 leading-snug">
                        Stops when delivered kWh ≥ capacity × (target − initial)
                        / 100. Uses the scenario's EV settings (above) or the
                        connector's current EV state if the scenario doesn't
                        override.
                      </p>
                    ) : null}
                  </div>

                  {/* Manual-mode caps. Hidden in EV-settings mode. */}
                  {formData.stopMode !== "evSettings" ? (
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-0.5">
                          Increment Interval (s)
                        </label>
                        <input
                          type="number"
                          className="input-base w-full text-sm"
                          value={(formData.incrementInterval as number) ?? ""}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              incrementInterval:
                                e.target.value === ""
                                  ? undefined
                                  : parseInt(e.target.value, 10),
                            })
                          }
                          placeholder="10"
                          min={1}
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-0.5">
                          Increment Amount (Wh)
                        </label>
                        <input
                          type="number"
                          className="input-base w-full text-sm"
                          value={(formData.incrementAmount as number) ?? ""}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              incrementAmount:
                                e.target.value === ""
                                  ? undefined
                                  : parseInt(e.target.value, 10),
                            })
                          }
                          placeholder="1000"
                          min={1}
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-0.5">
                          Max Time (s, 0=∞)
                        </label>
                        <input
                          type="number"
                          className="input-base w-full text-sm"
                          value={(formData.maxTime as number) ?? ""}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              maxTime:
                                e.target.value === ""
                                  ? undefined
                                  : parseInt(e.target.value, 10),
                            })
                          }
                          placeholder="0"
                          min={0}
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-0.5">
                          Max Value (Wh, 0=∞)
                        </label>
                        <input
                          type="number"
                          className="input-base w-full text-sm"
                          value={(formData.maxValue as number) ?? ""}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              maxValue:
                                e.target.value === ""
                                  ? undefined
                                  : parseInt(e.target.value, 10),
                            })
                          }
                          placeholder="0"
                          min={0}
                        />
                      </div>
                    </div>
                  ) : null}

                  <div className="border-t border-gray-200 dark:border-gray-700 pt-2">
                    <button
                      onClick={() => setIsCurveModalOpen(true)}
                      className="btn-primary text-sm w-full"
                    >
                      ⚙️ Configure Auto Increment Curve
                    </button>
                    <p className="text-xs text-muted mt-1">
                      {formData.curvePoints && formData.curvePoints.length > 0
                        ? `Configured with ${formData.curvePoints.length} curve points`
                        : "Optional: configure meter value auto-increment curve"}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        );

      case ScenarioNodeType.DELAY:
        return (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">
                Label
              </label>
              <input
                type="text"
                className="input-base w-full text-sm"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">
                Delay (seconds)
              </label>
              <input
                type="number"
                className="input-base w-full text-sm"
                value={formData.delaySeconds || 0}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    delaySeconds: parseInt(e.target.value) || 0,
                  })
                }
                min="0"
              />
            </div>
          </div>
        );

      case ScenarioNodeType.NOTIFICATION:
        return (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">
                Label
              </label>
              <input
                type="text"
                className="input-base w-full text-sm"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">
                Message Type
              </label>
              <input
                type="text"
                className="input-base w-full text-sm"
                value={formData.messageType || ""}
                onChange={(e) =>
                  setFormData({ ...formData, messageType: e.target.value })
                }
                placeholder="e.g., Heartbeat, DataTransfer"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">
                Payload (JSON)
              </label>
              <textarea
                className="input-base w-full font-mono text-xs"
                rows={6}
                value={
                  typeof formData.payload === "string"
                    ? formData.payload
                    : JSON.stringify(formData.payload || {}, null, 2)
                }
                onChange={(e) => {
                  try {
                    const parsed = JSON.parse(e.target.value);
                    setFormData({ ...formData, payload: parsed });
                  } catch {
                    setFormData({ ...formData, payload: e.target.value });
                  }
                }}
                placeholder='{"key": "value"}'
              />
            </div>
          </div>
        );

      case ScenarioNodeType.CONNECTOR_PLUG:
        return (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">
                Label
              </label>
              <input
                type="text"
                className="input-base w-full text-sm"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">
                Action
              </label>
              <select
                className="input-base w-full text-sm"
                value={formData.action || "plugin"}
                onChange={(e) =>
                  setFormData({ ...formData, action: e.target.value })
                }
              >
                <option value="plugin">Plugin (Connect)</option>
                <option value="plugout">Plugout (Disconnect)</option>
              </select>
            </div>
          </div>
        );

      case ScenarioNodeType.REMOTE_START_TRIGGER:
        return (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">
                Label
              </label>
              <input
                type="text"
                className="input-base w-full text-sm"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">
                Timeout (seconds)
              </label>
              <input
                type="number"
                className="input-base w-full text-sm"
                value={formData.timeout || 0}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    timeout: parseInt(e.target.value) || 0,
                  })
                }
                min="0"
              />
              <p className="text-xs text-muted mt-1">
                0 = No timeout (wait indefinitely for RemoteStartTransaction)
              </p>
            </div>
          </div>
        );

      case ScenarioNodeType.STATUS_TRIGGER:
        return (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">
                Label
              </label>
              <input
                type="text"
                className="input-base w-full text-sm"
                value={formData.label || ""}
                onChange={(e) =>
                  setFormData({ ...formData, label: e.target.value })
                }
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">
                Target Status
              </label>
              <select
                className="input-base w-full text-sm"
                value={formData.targetStatus || OCPPStatus.Charging}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    targetStatus: e.target.value as OCPPStatus,
                  })
                }
              >
                <option value={OCPPStatus.Available}>Available</option>
                <option value={OCPPStatus.Preparing}>Preparing</option>
                <option value={OCPPStatus.Charging}>Charging</option>
                <option value={OCPPStatus.SuspendedEVSE}>SuspendedEVSE</option>
                <option value={OCPPStatus.SuspendedEV}>SuspendedEV</option>
                <option value={OCPPStatus.Finishing}>Finishing</option>
                <option value={OCPPStatus.Reserved}>Reserved</option>
                <option value={OCPPStatus.Unavailable}>Unavailable</option>
                <option value={OCPPStatus.Faulted}>Faulted</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">
                Timeout (seconds)
              </label>
              <input
                type="number"
                className="input-base w-full text-sm"
                value={formData.timeout || 0}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    timeout: parseInt(e.target.value) || 0,
                  })
                }
                min="0"
              />
              <p className="text-xs text-muted mt-1">
                0 = No timeout (wait indefinitely for status change)
              </p>
            </div>
          </div>
        );

      default:
        return (
          <div className="text-sm text-muted">
            This node type does not have configurable properties.
          </div>
        );
    }
  };

  // Handle curve modal save
  const handleCurveModalSave = (config: AutoMeterValueConfig) => {
    setFormData({
      ...formData,
      curvePoints: config.curvePoints,
      incrementInterval: config.intervalSeconds,
      autoCalculateInterval: config.autoCalculateInterval,
    });
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
            initialConfig={{
              enabled: true,
              intervalSeconds: formData.incrementInterval || 10,
              curvePoints: formData.curvePoints || [
                { time: 0, value: 0 },
                { time: 30, value: 50 },
              ],
              autoCalculateInterval: formData.autoCalculateInterval || false,
            }}
            onSave={handleCurveModalSave}
          />
        </Suspense>
      ) : null}

      {/* Header — slim toolbar.
          Connector status / meter / SoC etc. are rendered by the parent
          (ConnectorSidePanel left column); we just show the scenario-level
          state + action buttons. */}
      <div className="panel px-3 py-2 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-2 text-xs min-w-0 flex-1">
            <span className="text-muted shrink-0">Scenario:</span>
            <div className="flex items-center gap-1 shrink-0">
              {getScenarioStateIndicator(executionState)}
              <span
                className={`font-semibold ${getScenarioStateColor(executionState)}`}
              >
                {executionState
                  ? executionState.charAt(0).toUpperCase() +
                    executionState.slice(1)
                  : "Idle"}
              </span>
            </div>
            {executionContext && executionContext.currentNodeId && (
              <>
                <span className="text-muted shrink-0">·</span>
                <span className="font-mono text-blue-600 dark:text-blue-400 truncate min-w-0">
                  {nodes.find((n) => n.id === executionContext.currentNodeId)
                    ?.data?.label || executionContext.currentNodeId}
                </span>
              </>
            )}
          </div>
          <div className="flex gap-1 shrink-0">
            <button
              onClick={handleForceStop}
              className="btn-danger text-xs px-2 py-1"
              title="Stop running scenario"
            >
              ■ Stop
            </button>
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
            <button
              onClick={handleManualSave}
              className={`text-xs px-2 py-1 ${
                saveFeedback === "saved"
                  ? "bg-emerald-600 text-white hover:bg-emerald-700"
                  : "btn-secondary"
              }`}
              title="Save scenario"
            >
              {saveFeedback === "saved" ? "✓ Saved" : "💾 Save"}
            </button>
            <button
              onClick={() => setIsSettingsModalOpen(true)}
              className="btn-secondary text-xs px-2 py-1"
              title="Scenario settings"
            >
              ⚙
            </button>
            <button
              onClick={handleImport}
              className="btn-secondary text-xs px-2 py-1"
              title="Import JSON"
            >
              ↑
            </button>
            <button
              onClick={handleExport}
              className="btn-secondary text-xs px-2 py-1"
              title="Export JSON"
            >
              ↓
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>

        {/* Scenario settings modal — Template / Name / Description / Enabled / EV Settings */}
        <Dialog
          open={isSettingsModalOpen}
          onOpenChange={(open) => !open && setIsSettingsModalOpen(false)}
        >
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Scenario Settings</DialogTitle>
            </DialogHeader>

            {/* Template Selector */}
            <div className="flex items-center gap-2">
              <label className="text-xs font-semibold text-primary whitespace-nowrap">
                📋 Template:
              </label>
              <select
                className="input-base text-xs flex-1"
                onChange={(e) => {
                  if (e.target.value) {
                    handleLoadTemplate(e.target.value);
                    e.target.value = ""; // Reset selection
                  }
                }}
                defaultValue=""
              >
                <option value="">Select a template...</option>
                {scenarioTemplates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name} - {template.description}
                  </option>
                ))}
              </select>
            </div>

            {/* Scenario Settings */}
            <div className="grid grid-cols-2 gap-2 mt-2">
              {/* Name */}
              <div>
                <label className="block text-xs font-semibold text-primary mb-1">
                  Scenario Name
                </label>
                <input
                  type="text"
                  className="input-base w-full text-xs"
                  value={scenarioName}
                  onChange={(e) => setScenarioName(e.target.value)}
                  placeholder="Enter scenario name"
                />
              </div>

              {/* Description */}
              <div className="col-span-2">
                <label className="block text-xs font-semibold text-primary mb-1">
                  Description
                </label>
                <input
                  type="text"
                  className="input-base w-full text-xs"
                  value={scenarioDescription}
                  onChange={(e) => setScenarioDescription(e.target.value)}
                  placeholder="Enter scenario description (optional)"
                />
              </div>

              {/* Enabled Toggle */}
              <div className="flex items-center">
                <label className="flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    className="mr-2"
                    checked={scenarioEnabled}
                    onChange={(e) => setScenarioEnabled(e.target.checked)}
                  />
                  <span className="text-xs font-semibold text-primary">
                    Enabled
                  </span>
                </label>
              </div>

              {/* Scenario EV Settings — applied to the target connector when the
              scenario starts. Partial — empty fields keep the connector's
              current values. */}
              <div className="col-span-2 mt-1 rounded border border-gray-200 dark:border-gray-700">
                <button
                  type="button"
                  onClick={() => setIsEvSettingsExpanded((v) => !v)}
                  className="w-full flex items-center justify-between px-2 py-1.5 text-xs font-semibold text-primary hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <span>🚗 Scenario EV Settings</span>
                  <span className="text-gray-500">
                    {isEvSettingsExpanded ? "▾" : "▸"}
                  </span>
                </button>
                {isEvSettingsExpanded ? (
                  <div className="px-2 pb-2 space-y-2">
                    <div>
                      <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-0.5">
                        EV Model preset
                      </label>
                      <select
                        className="input-base w-full text-xs"
                        value={scenarioEvSettings.modelName ?? ""}
                        onChange={(e) => {
                          const preset = e.target.value;
                          if (!preset) {
                            setScenarioEvSettings({});
                            return;
                          }
                          if (preset === "Custom") {
                            setScenarioEvSettings({
                              ...scenarioEvSettings,
                              modelName: "Custom",
                            });
                            return;
                          }
                          const presetValues = EV_PRESETS[preset] ?? {};
                          setScenarioEvSettings({
                            ...scenarioEvSettings,
                            modelName: preset,
                            ...presetValues,
                          });
                        }}
                      >
                        <option value="">
                          (use default
                          {defaultEvSettings
                            ? `: ${defaultEvSettings.modelName}`
                            : ""}
                          )
                        </option>
                        {Object.keys(EV_PRESETS).map((preset) => (
                          <option key={preset} value={preset}>
                            {preset}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-0.5">
                          Battery (kWh)
                        </label>
                        <input
                          type="number"
                          className="input-base w-full text-xs"
                          placeholder={
                            defaultEvSettings
                              ? String(defaultEvSettings.batteryCapacityKwh)
                              : "—"
                          }
                          value={scenarioEvSettings.batteryCapacityKwh ?? ""}
                          onChange={(e) => {
                            const v = e.target.value;
                            setScenarioEvSettings({
                              ...scenarioEvSettings,
                              batteryCapacityKwh:
                                v === ""
                                  ? undefined
                                  : Math.max(1, parseFloat(v)),
                            });
                          }}
                          min={1}
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-0.5">
                          Max Power (kW)
                        </label>
                        <input
                          type="number"
                          className="input-base w-full text-xs"
                          placeholder={
                            defaultEvSettings
                              ? String(defaultEvSettings.maxChargingPowerKw)
                              : "—"
                          }
                          value={scenarioEvSettings.maxChargingPowerKw ?? ""}
                          onChange={(e) => {
                            const v = e.target.value;
                            setScenarioEvSettings({
                              ...scenarioEvSettings,
                              maxChargingPowerKw:
                                v === ""
                                  ? undefined
                                  : Math.max(1, parseFloat(v)),
                            });
                          }}
                          min={1}
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-0.5">
                          Initial SoC (%)
                        </label>
                        <input
                          type="number"
                          className="input-base w-full text-xs"
                          placeholder={
                            defaultEvSettings
                              ? String(defaultEvSettings.initialSoc)
                              : "—"
                          }
                          value={scenarioEvSettings.initialSoc ?? ""}
                          onChange={(e) => {
                            const v = e.target.value;
                            setScenarioEvSettings({
                              ...scenarioEvSettings,
                              initialSoc:
                                v === ""
                                  ? undefined
                                  : Math.min(100, Math.max(0, parseInt(v, 10))),
                            });
                          }}
                          min={0}
                          max={100}
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-0.5">
                          Target SoC (%)
                        </label>
                        <input
                          type="number"
                          className="input-base w-full text-xs"
                          placeholder={
                            defaultEvSettings
                              ? String(defaultEvSettings.targetSoc)
                              : "—"
                          }
                          value={scenarioEvSettings.targetSoc ?? ""}
                          onChange={(e) => {
                            const v = e.target.value;
                            setScenarioEvSettings({
                              ...scenarioEvSettings,
                              targetSoc:
                                v === ""
                                  ? undefined
                                  : Math.min(100, Math.max(0, parseInt(v, 10))),
                            });
                          }}
                          min={0}
                          max={100}
                        />
                      </div>
                    </div>
                    <p className="text-[10px] text-gray-500 dark:text-gray-400 leading-snug">
                      Empty fields fall back to{" "}
                      {defaultEvSettings ? (
                        <>
                          the <strong>Default EV Settings</strong> (
                          {defaultEvSettings.modelName}) configured in Settings.
                        </>
                      ) : (
                        <>the connector's current value (built-in default).</>
                      )}{" "}
                      The auto-meter "Stop mode" inside MeterValue nodes can
                      derive its stop condition from these settings.
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="secondary"
                onClick={() => setIsSettingsModalOpen(false)}
              >
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
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
            </div>
          </div>

          {/* React Flow Canvas */}
          <div className="flex-1 bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden min-h-0">
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
              colorMode={isDark ? "dark" : "light"}
              onInit={(instance) => {
                rfInstanceRef.current = instance;
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
                maskColor={
                  isDark ? "rgba(15, 23, 42, 0.6)" : "rgba(240, 240, 240, 0.6)"
                }
                style={{
                  backgroundColor: isDark ? "#1f2937" : "#ffffff",
                }}
              />
            </ReactFlow>
          </div>
        </div>

        {/* Right Column: Node Config Panel */}
        {selectedNode && (
          <div className="w-80 flex-shrink-0 panel p-4 overflow-y-auto max-h-full">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-primary">
                {getNodeTypeName(selectedNode.type || "")}
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
                  handleNodeConfigSave(selectedNode.id, formData);
                  setSelectedNode(null);
                }}
                className="flex-1 btn-primary text-sm"
              >
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
): Node {
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
    case ScenarioNodeType.START:
      return {
        id,
        type,
        position,
        // Default trigger is "connect" — matches the historical behaviour
        // where the scenario fired as soon as CP became Available after
        // BootNotification. Operators can switch to "status" via
        // NodeConfigPanel to gate on connector state instead.
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
