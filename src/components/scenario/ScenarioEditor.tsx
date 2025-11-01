import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  Connection,
  Node,
  NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  ScenarioDefinition,
  ScenarioNodeType,
  ScenarioExecutionMode,
  ScenarioExecutionContext,
  ScenarioExecutionState,
} from "../../cp/application/scenario/ScenarioTypes";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import { AutoMeterValueConfig } from "../../cp/domain/connector/MeterValueCurve";
import MeterValueCurveModal from "../MeterValueCurveModal";

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
import ScenarioControlPanel from "./ScenarioControlPanel";

import {
  loadScenarios,
  updateScenario,
  addScenario,
  getScenarioById,
  exportScenarioToJSON,
  importScenarioFromJSON,
  createDefaultScenario,
} from "../../utils/scenarioStorage";
import {
  scenarioTemplates,
  getTemplateById,
} from "../../utils/scenarioTemplates";
import { ScenarioExecutor } from "../../cp/application/scenario/ScenarioExecutor";
import { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";

interface ScenarioEditorProps {
  chargePoint: ChargePoint;
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
  [ScenarioNodeType.START]: (props) => (
    <StartEndNode {...props} nodeType="start" />
  ),
  [ScenarioNodeType.END]: (props) => <StartEndNode {...props} nodeType="end" />,
};

const ScenarioEditor: React.FC<ScenarioEditorProps> = ({
  chargePoint,
  connectorId,
  scenario: scenarioProp,
  scenarioId,
  executionContext: propsExecutionContext,
  nodeProgress: propsNodeProgress,
  onClose,
}) => {
  const [scenario, setScenario] = useState<ScenarioDefinition>(() => {
    if (scenarioProp) {
      return scenarioProp;
    }
    if (scenarioId) {
      const found = getScenarioById(chargePoint.id, connectorId, scenarioId);
      if (found) return found;
    }
    return createDefaultScenario(chargePoint.id, connectorId);
  });

  const [nodes, setNodes, onNodesChange] = useNodesState(scenario.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(scenario.edges);
  const [executionState, setExecutionState] =
    useState<ScenarioExecutionState>("idle");
  const [executionMode, setExecutionMode] =
    useState<ScenarioExecutionMode>("oneshot");
  const [executionContext, setExecutionContext] =
    useState<ScenarioExecutionContext | null>(null);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [connectorStatus, setConnectorStatus] = useState<OCPPStatus>(
    OCPPStatus.Unavailable,
  );
  const [meterValue, setMeterValue] = useState<number>(0);
  const [transactionId, setTransactionId] = useState<number | null>(null);
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

  const executorRef = useRef<ScenarioExecutor | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reload scenario when props change
  useEffect(() => {
    if (scenarioProp) {
      setScenario(scenarioProp);
      setNodes(scenarioProp.nodes);
      setEdges(scenarioProp.edges);
      setScenarioName(scenarioProp.name);
      setScenarioDescription(scenarioProp.description || "");
      setDefaultExecutionMode(scenarioProp.defaultExecutionMode || "oneshot");
      setScenarioEnabled(scenarioProp.enabled !== false);
      return;
    }

    if (scenarioId) {
      const found = getScenarioById(chargePoint.id, connectorId, scenarioId);
      if (found) {
        setScenario(found);
        setNodes(found.nodes);
        setEdges(found.edges);
        setScenarioName(found.name);
        setScenarioDescription(found.description || "");
        setDefaultExecutionMode(found.defaultExecutionMode || "oneshot");
        setScenarioEnabled(found.enabled !== false);
      }
    }
  }, [scenarioProp, scenarioId, chargePoint.id, connectorId]);

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
          // Mark executed nodes with gray background
          className = `${className} executed-node`;
          style = {
            ...style,
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
  }, [executionContext, nodeProgress]);

  // Subscribe to connector status changes
  useEffect(() => {
    if (!connectorId) return;

    const connector = chargePoint.getConnector(connectorId);
    if (!connector) return;

    // Subscribe to connector events
    const unsubStatus = connector.events.on("statusChange", (data) => {
      setConnectorStatus(data.status);
    });

    const unsubMeterValue = connector.events.on("meterValueChange", (data) => {
      setMeterValue(data.meterValue);
    });

    const unsubTransactionId = connector.events.on(
      "transactionIdChange",
      (data) => {
        setTransactionId(data.transactionId);
      },
    );

    // Set initial values
    setConnectorStatus(connector.status as OCPPStatus);
    setMeterValue(connector.meterValue);

    return () => {
      unsubStatus();
      unsubMeterValue();
      unsubTransactionId();
    };
  }, [chargePoint, connectorId]);

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

    const updatedScenario: ScenarioDefinition = {
      ...scenario,
      name: scenarioName,
      description: scenarioDescription,
      nodes,
      edges: cleanedEdges,
      trigger,
      defaultExecutionMode,
      enabled: scenarioEnabled,
      updatedAt: new Date().toISOString(),
    };
    setScenario(updatedScenario);
    if (scenario.id) {
      // Auto-save to storage (but don't reload into ScenarioManager yet)
      updateScenario(chargePoint.id, connectorId, scenario.id, updatedScenario);
    }
  }, [
    nodes,
    edges,
    scenarioName,
    scenarioDescription,
    defaultExecutionMode,
    scenarioEnabled,
    setEdges,
    scenario.id,
    chargePoint.id,
    connectorId,
  ]);

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

  // Execution control handlers
  const handleStart = useCallback(
    async (mode: ScenarioExecutionMode) => {
      const currentScenario: ScenarioDefinition = {
        ...scenario,
        nodes,
        edges,
      };

      const connector = connectorId
        ? chargePoint.getConnector(connectorId)
        : null;

      executorRef.current = new ScenarioExecutor(currentScenario, {
        onStatusChange: async (status) => {
          if (connector) {
            chargePoint.updateConnectorStatus(connector.id, status);
          }
        },
        onStartTransaction: async (tagId) => {
          if (connector) {
            chargePoint.startTransaction(tagId, connector.id);
          }
        },
        onStopTransaction: async () => {
          if (connector) {
            chargePoint.stopTransaction(connector.id);
          }
        },
        onSetMeterValue: (value) => {
          if (connector) {
            chargePoint.setMeterValue(connector.id, value);
          }
        },
        onSendMeterValue: async () => {
          if (connector) {
            chargePoint.sendMeterValue(connector.id);
          }
        },
        onStateChange: (context) => {
          setExecutionState(context.state);
          setExecutionContext(context);
        },
        onNodeExecute: (nodeId) => {
          // Highlight executing node
          setNodes((nds) =>
            nds.map((n) => ({
              ...n,
              style:
                n.id === nodeId ? { boxShadow: "0 0 10px 3px #3b82f6" } : {},
            })),
          );
        },
        onNodeProgress: (nodeId, remaining, total) => {
          // Update node data with progress information
          setNodes((nds) =>
            nds.map((n) =>
              n.id === nodeId
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      progress: { remaining, total },
                    },
                  }
                : n,
            ),
          );
        },
        onError: (error) => {
          console.error("Scenario execution error:", error);
          alert(`Scenario error: ${error.message}`);
        },
      });

      setExecutionMode(mode);
      await executorRef.current.start(mode);
    },
    [scenario, nodes, edges, chargePoint, connectorId],
  );

  const handlePause = useCallback(() => {
    executorRef.current?.pause();
  }, []);

  const handleResume = useCallback(() => {
    executorRef.current?.resume();
  }, []);

  const handleStop = useCallback(() => {
    executorRef.current?.stop();
    setExecutionState("idle");
    setNodes((nds) => nds.map((n) => ({ ...n, style: {} })));
  }, [setNodes]);

  const handleStep = useCallback(() => {
    executorRef.current?.step();
  }, []);

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

        // Check if scenario already exists
        const existing = getScenarioById(
          chargePoint.id,
          connectorId,
          imported.id,
        );
        if (existing) {
          updateScenario(chargePoint.id, connectorId, imported.id, imported);
        } else {
          addScenario(chargePoint.id, connectorId, imported);
        }
      } catch (error) {
        alert(`Failed to import scenario: ${error}`);
      }
    },
    [chargePoint.id, connectorId, setNodes, setEdges],
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

      const templateScenario = template.createScenario(
        chargePoint.id,
        connectorId,
      );
      setScenario(templateScenario);
      setNodes(templateScenario.nodes);
      setEdges(templateScenario.edges);

      // Templates are always new scenarios, so add them
      addScenario(chargePoint.id, connectorId, templateScenario);
    },
    [chargePoint.id, connectorId, nodes.length, setNodes, setEdges],
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

  // Handle scenario save
  const handleSaveScenario = useCallback(() => {
    const updatedScenario: ScenarioDefinition = {
      ...scenario,
      name: scenarioName,
      description: scenarioDescription,
      nodes,
      edges,
      defaultExecutionMode,
      enabled: scenarioEnabled,
    };

    // Save using the new multi-scenario storage
    updateScenario(chargePoint.id, connectorId, scenario.id, updatedScenario);
    setScenario(updatedScenario);

    // Reload ALL scenarios from storage into ScenarioManager
    const connector = chargePoint.getConnector(connectorId || 1);
    if (connector?.scenarioManager) {
      const allScenarios = loadScenarios(chargePoint.id, connectorId);
      connector.scenarioManager.loadScenarios(allScenarios);
    }

    // Show success message
    alert("Scenario saved successfully!");
  }, [
    scenario,
    scenarioName,
    scenarioDescription,
    nodes,
    edges,
    defaultExecutionMode,
    scenarioEnabled,
    chargePoint,
    connectorId,
  ]);

  // Get status color class
  const getStatusColor = (status: OCPPStatus) => {
    switch (status) {
      case OCPPStatus.Available:
        return "status-available";
      case OCPPStatus.Preparing:
        return "status-preparing";
      case OCPPStatus.Charging:
        return "status-charging";
      case OCPPStatus.Finishing:
        return "text-yellow-600 dark:text-yellow-400";
      case OCPPStatus.Unavailable:
        return "status-unavailable";
      case OCPPStatus.Faulted:
        return "status-error";
      default:
        return "text-secondary";
    }
  };

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
                <div className="ml-6 space-y-2">
                  <button
                    onClick={() => setIsCurveModalOpen(true)}
                    className="btn-primary text-sm w-full"
                  >
                    ⚙️ Configure Auto Increment Curve
                  </button>
                  <p className="text-xs text-muted">
                    {formData.curvePoints && formData.curvePoints.length > 0
                      ? `Configured with ${formData.curvePoints.length} curve points`
                      : "Click to configure meter value auto-increment curve"}
                  </p>
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
      {/* MeterValue Curve Config Modal */}
      {isCurveModalOpen && (
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
      )}

      {/* Header */}
      <div className="panel p-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-4">
            <div>
              <h2 className="text-lg font-bold text-primary">
                Scenario Editor
              </h2>
              <p className="text-xs text-muted">
                {chargePoint.id} -{" "}
                {connectorId ? `Connector ${connectorId}` : "ChargePoint"}
              </p>
            </div>
            <div className="flex gap-2">
              {connectorId && (
                <div className="panel-border px-3 py-1">
                  <div className="flex items-center gap-3 text-xs">
                    <div>
                      <span className="text-muted">Status: </span>
                      <span
                        className={`font-semibold ${getStatusColor(connectorStatus)}`}
                      >
                        {connectorStatus}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted">Meter: </span>
                      <span className="font-mono text-secondary">
                        {meterValue} Wh
                      </span>
                    </div>
                    {transactionId && (
                      <div>
                        <span className="text-muted">TX: </span>
                        <span className="font-mono text-secondary">
                          {transactionId}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {/* Scenario Execution State */}
              <div className="panel-border px-3 py-1">
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted">Scenario State:</span>
                  <div className="flex items-center gap-1">
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
                    <div className="border-l border-gray-300 dark:border-gray-600 pl-2">
                      <span className="text-muted">Current Node: </span>
                      <span className="font-mono text-blue-600 dark:text-blue-400">
                        {nodes.find(
                          (n) => n.id === executionContext.currentNodeId,
                        )?.data?.label || executionContext.currentNodeId}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleImport}
              className="btn-secondary text-xs px-2 py-1"
            >
              📥 Import
            </button>
            <button
              onClick={handleExport}
              className="btn-secondary text-xs px-2 py-1"
            >
              📤 Export
            </button>
            <button onClick={onClose} className="btn-danger text-xs px-2 py-1">
              ✕ Close
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

          {/* Default Execution Mode */}
          <div>
            <label className="block text-xs font-semibold text-primary mb-1">
              Execution Mode
            </label>
            <select
              className="input-base w-full text-xs"
              value={defaultExecutionMode}
              onChange={(e) =>
                setDefaultExecutionMode(e.target.value as ScenarioExecutionMode)
              }
            >
              <option value="oneshot">One-shot</option>
              <option value="step">Step</option>
            </select>
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
        </div>
      </div>

      <div className="flex-1 flex gap-3 p-3 overflow-hidden min-h-0">
        {/* Left Column: Node Palette + Canvas + Control Panel */}
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
            >
              <Background />
              <Controls />
              <MiniMap />
            </ReactFlow>
          </div>

          {/* Control Panel */}
          <div className="flex-shrink-0">
            <ScenarioControlPanel
              executionState={executionState}
              executionMode={executionMode}
              onStart={handleStart}
              onPause={handlePause}
              onResume={handleResume}
              onStop={handleStop}
              onStep={handleStep}
              onModeChange={setExecutionMode}
              onSave={handleSaveScenario}
            />
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
    case ScenarioNodeType.START:
      return {
        id,
        type,
        position,
        data: { label: "Start" },
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
