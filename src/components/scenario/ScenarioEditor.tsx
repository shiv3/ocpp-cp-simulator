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
  Edge,
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
} from "../../cp/types/ScenarioTypes";
import { OCPPStatus } from "../../cp/OcppTypes";
import { CurvePoint, calculateBezierPoint } from "../../cp/types/MeterValueCurve";

// Import node components
import StatusChangeNode from "./nodes/StatusChangeNode";
import TransactionNode from "./nodes/TransactionNode";
import MeterValueNode from "./nodes/MeterValueNode";
import DelayNode from "./nodes/DelayNode";
import NotificationNode from "./nodes/NotificationNode";
import ConnectorPlugNode from "./nodes/ConnectorPlugNode";
import RemoteStartTriggerNode from "./nodes/RemoteStartTriggerNode";
import StatusTriggerNode from "./nodes/StatusTriggerNode";
import StartEndNode from "./nodes/StartEndNode";
import ScenarioControlPanel from "./ScenarioControlPanel";
import NodeConfigPanel from "./NodeConfigPanel";

import {
  saveScenario,
  loadScenario,
  exportScenarioToJSON,
  importScenarioFromJSON,
  createDefaultScenario,
} from "../../utils/scenarioStorage";
import { scenarioTemplates, getTemplateById } from "../../utils/scenarioTemplates";
import { ScenarioExecutor } from "../../cp/ScenarioExecutor";
import { ChargePoint } from "../../cp/ChargePoint";

interface ScenarioEditorProps {
  chargePoint: ChargePoint;
  connectorId: number | null;
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
  [ScenarioNodeType.START]: (props) => <StartEndNode {...props} nodeType="start" />,
  [ScenarioNodeType.END]: (props) => <StartEndNode {...props} nodeType="end" />,
};

const ScenarioEditor: React.FC<ScenarioEditorProps> = ({
  chargePoint,
  connectorId,
  onClose,
}) => {
  const [scenario, setScenario] = useState<ScenarioDefinition>(() => {
    const loaded = loadScenario(chargePoint.id, connectorId);
    return loaded || createDefaultScenario(chargePoint.id, connectorId);
  });

  const [nodes, setNodes, onNodesChange] = useNodesState(scenario.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(scenario.edges);
  const [executionState, setExecutionState] = useState<ScenarioExecutionState>("idle");
  const [executionMode, setExecutionMode] = useState<ScenarioExecutionMode>("oneshot");
  const [executionContext, setExecutionContext] = useState<ScenarioExecutionContext | null>(null);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [isConfigPanelOpen, setIsConfigPanelOpen] = useState(false);
  const [formData, setFormData] = useState<any>({});
  const [connectorStatus, setConnectorStatus] = useState<OCPPStatus>(OCPPStatus.Unavailable);
  const [meterValue, setMeterValue] = useState<number>(0);
  const [transactionId, setTransactionId] = useState<number | null>(null);
  const [nodeProgress, setNodeProgress] = useState<Record<string, { remaining: number; total: number }>>({});

  const executorRef = useRef<ScenarioExecutor | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

    const unsubTransactionId = connector.events.on("transactionIdChange", (data) => {
      setTransactionId(data.transactionId);
    });

    // Set initial values
    setConnectorStatus(connector.status as OCPPStatus);
    setMeterValue(connector.meterValue);

    return () => {
      unsubStatus();
      unsubMeterValue();
      unsubTransactionId();
    };
  }, [chargePoint, connectorId]);

  // Auto-save to localStorage when nodes or edges change
  useEffect(() => {
    const updatedScenario: ScenarioDefinition = {
      ...scenario,
      nodes,
      edges,
      updatedAt: new Date().toISOString(),
    };
    setScenario(updatedScenario);
    saveScenario(chargePoint.id, connectorId, updatedScenario);
  }, [nodes, edges]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => addEdge(connection, eds));
    },
    [setEdges]
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
    [selectedNode]
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

      const reactFlowBounds = event.currentTarget.getBoundingClientRect();
      const position = {
        x: event.clientX - reactFlowBounds.left - 90,
        y: event.clientY - reactFlowBounds.top - 30,
      };

      const newNode = createNodeByType(type, position);
      setNodes((nds) => nds.concat(newNode));
    },
    [setNodes]
  );

  // Execution control handlers
  const handleStart = useCallback(
    async (mode: ScenarioExecutionMode) => {
      const currentScenario: ScenarioDefinition = {
        ...scenario,
        nodes,
        edges,
      };

      const connector = connectorId ? chargePoint.getConnector(connectorId) : null;

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
              style: n.id === nodeId ? { boxShadow: "0 0 10px 3px #3b82f6" } : {},
            }))
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
                : n
            )
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
    [scenario, nodes, edges, chargePoint, connectorId]
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
        saveScenario(chargePoint.id, connectorId, imported);
      } catch (error) {
        alert(`Failed to import scenario: ${error}`);
      }
    },
    [chargePoint.id, connectorId, setNodes, setEdges]
  );

  const handleLoadTemplate = useCallback(
    (templateId: string) => {
      const template = getTemplateById(templateId);
      if (!template) {
        alert("Template not found");
        return;
      }

      if (nodes.length > 2 && !window.confirm("現在のシナリオを破棄してテンプレートを読み込みますか？")) {
        return;
      }

      const templateScenario = template.createScenario(chargePoint.id, connectorId);
      setScenario(templateScenario);
      setNodes(templateScenario.nodes);
      setEdges(templateScenario.edges);
      saveScenario(chargePoint.id, connectorId, templateScenario);
    },
    [chargePoint.id, connectorId, nodes.length, setNodes, setEdges]
  );

  // Handle node double-click to open config panel
  const handleNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      // Don't open config for start/end nodes
      if (node.type === ScenarioNodeType.START || node.type === ScenarioNodeType.END) {
        return;
      }
      setSelectedNode(node);
      setFormData({ ...node.data });
    },
    []
  );

  // Handle node config save
  const handleNodeConfigSave = useCallback(
    (nodeId: string, newData: any) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id === nodeId) {
            return { ...n, data: { ...n.data, ...newData } };
          }
          return n;
        })
      );
    },
    [setNodes]
  );

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
              <label className="block text-xs font-semibold text-primary mb-1">Label</label>
              <input
                type="text"
                className="input-base w-full text-sm"
                value={formData.label || ""}
                onChange={(e) => setFormData({ ...formData, label: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">Status</label>
              <select
                className="input-base w-full text-sm"
                value={formData.status || OCPPStatus.Available}
                onChange={(e) => setFormData({ ...formData, status: e.target.value })}
              >
                {Object.values(OCPPStatus).map((status) => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
            </div>
          </div>
        );

      case ScenarioNodeType.TRANSACTION:
        return (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">Label</label>
              <input
                type="text"
                className="input-base w-full text-sm"
                value={formData.label || ""}
                onChange={(e) => setFormData({ ...formData, label: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">Action</label>
              <select
                className="input-base w-full text-sm"
                value={formData.action || "start"}
                onChange={(e) => setFormData({ ...formData, action: e.target.value })}
              >
                <option value="start">Start Transaction</option>
                <option value="stop">Stop Transaction</option>
              </select>
            </div>
            {formData.action === "start" && (
              <div>
                <label className="block text-xs font-semibold text-primary mb-1">Tag ID</label>
                <input
                  type="text"
                  className="input-base w-full text-sm"
                  value={formData.tagId || ""}
                  onChange={(e) => setFormData({ ...formData, tagId: e.target.value })}
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
              <label className="block text-xs font-semibold text-primary mb-1">Label</label>
              <input
                type="text"
                className="input-base w-full text-sm"
                value={formData.label || ""}
                onChange={(e) => setFormData({ ...formData, label: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">Initial Value (Wh)</label>
              <input
                type="number"
                className="input-base w-full text-sm"
                value={formData.value || 0}
                onChange={(e) => setFormData({ ...formData, value: parseInt(e.target.value) || 0 })}
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="sendMessage"
                checked={formData.sendMessage || false}
                onChange={(e) => setFormData({ ...formData, sendMessage: e.target.checked })}
                className="w-4 h-4"
              />
              <label htmlFor="sendMessage" className="text-xs font-semibold text-primary">
                Send MeterValue Message
              </label>
            </div>
            <div className="border-t border-gray-200 dark:border-gray-700 pt-3">
              <div className="flex items-center gap-2 mb-2">
                <input
                  type="checkbox"
                  id="autoIncrement"
                  checked={formData.autoIncrement || false}
                  onChange={(e) => setFormData({ ...formData, autoIncrement: e.target.checked })}
                  className="w-4 h-4"
                />
                <label htmlFor="autoIncrement" className="text-xs font-semibold text-primary">
                  Auto Increment
                </label>
              </div>
              {formData.autoIncrement && (
                <div className="ml-6 space-y-2">
                  <div className="flex items-center gap-2 mb-2">
                    <input
                      type="checkbox"
                      id="useCurve"
                      checked={formData.useCurve || false}
                      onChange={(e) => setFormData({ ...formData, useCurve: e.target.checked })}
                      className="w-4 h-4"
                    />
                    <label htmlFor="useCurve" className="text-xs font-semibold text-primary">
                      Use Curve (2D Graph)
                    </label>
                  </div>

                  {!formData.useCurve && (
                    <>
                      <div>
                        <label className="block text-xs font-semibold text-primary mb-1">
                          Increment Interval (seconds)
                        </label>
                        <input
                          type="number"
                          className="input-base w-full text-sm"
                          value={formData.incrementInterval || 10}
                          onChange={(e) => setFormData({ ...formData, incrementInterval: parseInt(e.target.value) || 10 })}
                          min="1"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-primary mb-1">
                          Increment Amount (Wh)
                        </label>
                        <input
                          type="number"
                          className="input-base w-full text-sm"
                          value={formData.incrementAmount || 1000}
                          onChange={(e) => setFormData({ ...formData, incrementAmount: parseInt(e.target.value) || 1000 })}
                          min="1"
                        />
                      </div>
                      <p className="text-xs text-muted">
                        Meter value will automatically increment every {formData.incrementInterval || 10}s by {formData.incrementAmount || 1000} Wh
                      </p>
                    </>
                  )}

                  {formData.useCurve && (
                    <div className="space-y-2">
                      <div className="text-xs font-semibold text-primary mb-2">Curve Control Points</div>
                      <div className="max-h-40 overflow-y-auto space-y-2 border border-gray-200 dark:border-gray-700 rounded p-2 bg-gray-50 dark:bg-gray-800">
                        {(formData.curvePoints || [{ time: 0, value: 0 }, { time: 30, value: 50 }]).map((point: CurvePoint, index: number) => (
                          <div key={index} className="flex items-center gap-2 bg-white dark:bg-gray-700 p-2 rounded">
                            <div className="flex-1">
                              <input
                                type="number"
                                placeholder="Time (min)"
                                className="input-base w-full text-xs"
                                value={point.time}
                                onChange={(e) => {
                                  const newPoints = [...(formData.curvePoints || [{ time: 0, value: 0 }, { time: 30, value: 50 }])];
                                  newPoints[index] = { ...newPoints[index], time: parseFloat(e.target.value) || 0 };
                                  setFormData({ ...formData, curvePoints: newPoints });
                                }}
                                step="0.1"
                              />
                              <span className="text-xs text-muted">min</span>
                            </div>
                            <div className="flex-1">
                              <input
                                type="number"
                                placeholder="Value (kWh)"
                                className="input-base w-full text-xs"
                                value={point.value}
                                onChange={(e) => {
                                  const newPoints = [...(formData.curvePoints || [{ time: 0, value: 0 }, { time: 30, value: 50 }])];
                                  newPoints[index] = { ...newPoints[index], value: parseFloat(e.target.value) || 0 };
                                  setFormData({ ...formData, curvePoints: newPoints });
                                }}
                                step="0.1"
                              />
                              <span className="text-xs text-muted">kWh</span>
                            </div>
                            {(formData.curvePoints || []).length > 2 && (
                              <button
                                onClick={() => {
                                  const newPoints = (formData.curvePoints || []).filter((_: any, i: number) => i !== index);
                                  setFormData({ ...formData, curvePoints: newPoints });
                                }}
                                className="text-xs text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900 px-1 rounded"
                              >
                                ✕
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                      <button
                        onClick={() => {
                          const points = formData.curvePoints || [{ time: 0, value: 0 }, { time: 30, value: 50 }];
                          const maxTime = Math.max(...points.map((p: CurvePoint) => p.time));
                          const avgValue = points.reduce((sum: number, p: CurvePoint) => sum + p.value, 0) / points.length;
                          setFormData({
                            ...formData,
                            curvePoints: [...points, { time: maxTime + 10, value: avgValue }]
                          });
                        }}
                        className="text-xs btn-success px-2 py-1 w-full"
                      >
                        + Add Point
                      </button>

                      {/* Curve Visualization Canvas */}
                      <CurvePreview curvePoints={formData.curvePoints || [{ time: 0, value: 0 }, { time: 30, value: 50 }]} />

                      <div className="text-xs text-muted bg-blue-50 dark:bg-blue-900 p-2 rounded">
                        Curve defines meter value progression over time using Bezier interpolation
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );

      case ScenarioNodeType.DELAY:
        return (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">Label</label>
              <input
                type="text"
                className="input-base w-full text-sm"
                value={formData.label || ""}
                onChange={(e) => setFormData({ ...formData, label: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">Delay (seconds)</label>
              <input
                type="number"
                className="input-base w-full text-sm"
                value={formData.delaySeconds || 0}
                onChange={(e) => setFormData({ ...formData, delaySeconds: parseInt(e.target.value) || 0 })}
                min="0"
              />
            </div>
          </div>
        );

      case ScenarioNodeType.NOTIFICATION:
        return (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">Label</label>
              <input
                type="text"
                className="input-base w-full text-sm"
                value={formData.label || ""}
                onChange={(e) => setFormData({ ...formData, label: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">Message Type</label>
              <input
                type="text"
                className="input-base w-full text-sm"
                value={formData.messageType || ""}
                onChange={(e) => setFormData({ ...formData, messageType: e.target.value })}
                placeholder="e.g., Heartbeat, DataTransfer"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">Payload (JSON)</label>
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
              <label className="block text-xs font-semibold text-primary mb-1">Label</label>
              <input
                type="text"
                className="input-base w-full text-sm"
                value={formData.label || ""}
                onChange={(e) => setFormData({ ...formData, label: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">Action</label>
              <select
                className="input-base w-full text-sm"
                value={formData.action || "plugin"}
                onChange={(e) => setFormData({ ...formData, action: e.target.value })}
              >
                <option value="plugin">Plugin (接続)</option>
                <option value="plugout">Plugout (切断)</option>
              </select>
            </div>
          </div>
        );

      case ScenarioNodeType.REMOTE_START_TRIGGER:
        return (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">Label</label>
              <input
                type="text"
                className="input-base w-full text-sm"
                value={formData.label || ""}
                onChange={(e) => setFormData({ ...formData, label: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">Timeout (seconds)</label>
              <input
                type="number"
                className="input-base w-full text-sm"
                value={formData.timeout || 0}
                onChange={(e) => setFormData({ ...formData, timeout: parseInt(e.target.value) || 0 })}
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
              <label className="block text-xs font-semibold text-primary mb-1">Label</label>
              <input
                type="text"
                className="input-base w-full text-sm"
                value={formData.label || ""}
                onChange={(e) => setFormData({ ...formData, label: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-primary mb-1">Target Status</label>
              <select
                className="input-base w-full text-sm"
                value={formData.targetStatus || OCPPStatus.Charging}
                onChange={(e) => setFormData({ ...formData, targetStatus: e.target.value as OCPPStatus })}
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
              <label className="block text-xs font-semibold text-primary mb-1">Timeout (seconds)</label>
              <input
                type="number"
                className="input-base w-full text-sm"
                value={formData.timeout || 0}
                onChange={(e) => setFormData({ ...formData, timeout: parseInt(e.target.value) || 0 })}
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

  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <div className="panel p-3 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-4">
            <div>
              <h2 className="text-lg font-bold text-primary">
                Scenario Editor
              </h2>
              <p className="text-xs text-muted">
                {chargePoint.id} - {connectorId ? `Connector ${connectorId}` : "ChargePoint"}
              </p>
            </div>
            {connectorId && (
              <div className="panel-border px-3 py-1">
                <div className="flex items-center gap-3 text-xs">
                  <div>
                    <span className="text-muted">Status: </span>
                    <span className={`font-semibold ${getStatusColor(connectorStatus)}`}>
                      {connectorStatus}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted">Meter: </span>
                    <span className="font-mono text-secondary">{meterValue} Wh</span>
                  </div>
                  {transactionId && (
                    <div>
                      <span className="text-muted">TX: </span>
                      <span className="font-mono text-secondary">{transactionId}</span>
                    </div>
                  )}
                  <div className="border-l border-gray-300 dark:border-gray-600 pl-3 ml-1 flex items-center gap-2">
                    <select
                      className="input-base text-xs py-0.5 px-1"
                      value=""
                      onChange={(e) => {
                        if (e.target.value) {
                          const connector = chargePoint.getConnector(connectorId);
                          if (connector) {
                            chargePoint.updateConnectorStatus(connectorId, e.target.value as OCPPStatus);
                          }
                          e.target.value = "";
                        }
                      }}
                    >
                      <option value="">Send Status...</option>
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
                </div>
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={handleImport} className="btn-secondary text-xs px-2 py-1">
              📥 Import
            </button>
            <button onClick={handleExport} className="btn-secondary text-xs px-2 py-1">
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
      </div>

      <div className="flex-1 flex gap-3 p-3 overflow-hidden">
        {/* Left Column: Node Palette + Canvas + Control Panel */}
        <div className="flex-1 flex flex-col gap-3 overflow-hidden">
          {/* Node Palette */}
          <div className="panel p-2">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-primary">Node Palette</h3>
              <button
                onClick={handleDeleteSelected}
                className="btn-danger text-xs px-2 py-1"
                title="Delete selected nodes and edges (or press Delete/Backspace)"
              >
                🗑️ Delete Selected
              </button>
            </div>
            <div className="flex gap-2 flex-wrap">
              <NodePaletteItem type={ScenarioNodeType.STATUS_CHANGE} label="Status" icon="📊" />
              <NodePaletteItem type={ScenarioNodeType.TRANSACTION} label="Transaction" icon="💳" />
              <NodePaletteItem type={ScenarioNodeType.METER_VALUE} label="Meter" icon="⚡" />
              <NodePaletteItem type={ScenarioNodeType.DELAY} label="Delay" icon="⏱️" />
              <NodePaletteItem type={ScenarioNodeType.NOTIFICATION} label="Message" icon="📤" />
              <NodePaletteItem type={ScenarioNodeType.CONNECTOR_PLUG} label="Plug" icon="🔌" />
              <NodePaletteItem type={ScenarioNodeType.STATUS_TRIGGER} label="StatusTrigger" icon="🚦" />
              <NodePaletteItem type={ScenarioNodeType.REMOTE_START_TRIGGER} label="RemoteStart" icon="🎬" />
            </div>
          </div>

          {/* React Flow Canvas */}
          <div className="flex-1 bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
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
          <ScenarioControlPanel
            executionState={executionState}
            executionMode={executionMode}
            onStart={handleStart}
            onPause={handlePause}
            onResume={handleResume}
            onStop={handleStop}
            onStep={handleStep}
            onModeChange={setExecutionMode}
          />
        </div>

        {/* Right Column: Node Config Panel */}
        {selectedNode && (
          <div className="w-80 flex-shrink-0 panel p-4 overflow-y-auto">
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

const NodePaletteItem: React.FC<NodePaletteItemProps> = ({ type, label, icon }) => {
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
      <span className="font-medium text-primary whitespace-nowrap">{label}</span>
    </div>
  );
};

// Helper function to create nodes
function createNodeByType(type: string, position: { x: number; y: number }): Node {
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
        data: { label: "Wait for Status", targetStatus: OCPPStatus.Charging, timeout: 0 },
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

// Curve Preview Component
const CurvePreview: React.FC<{ curvePoints: CurvePoint[] }> = ({ curvePoints }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || curvePoints.length === 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const padding = 20;
    const graphWidth = width - 2 * padding;
    const graphHeight = height - 2 * padding;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Calculate ranges
    const sortedPoints = [...curvePoints].sort((a, b) => a.time - b.time);
    const maxTime = Math.max(...sortedPoints.map(p => p.time), 1);
    const maxValue = Math.max(...sortedPoints.map(p => p.value), 1);

    // Draw grid
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const x = padding + (graphWidth * i) / 4;
      ctx.beginPath();
      ctx.moveTo(x, padding);
      ctx.lineTo(x, padding + graphHeight);
      ctx.stroke();

      const y = padding + (graphHeight * i) / 4;
      ctx.beginPath();
      ctx.moveTo(padding, y);
      ctx.lineTo(padding + graphWidth, y);
      ctx.stroke();
    }

    // Draw axes
    ctx.strokeStyle = "#9ca3af";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(padding, padding);
    ctx.lineTo(padding, padding + graphHeight);
    ctx.lineTo(padding + graphWidth, padding + graphHeight);
    ctx.stroke();

    // Draw curve
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 2;
    ctx.beginPath();

    const segments = 50;
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const value = calculateBezierPoint(t, sortedPoints);
      const time = sortedPoints[0].time + (sortedPoints[sortedPoints.length - 1].time - sortedPoints[0].time) * t;

      const x = padding + (time / maxTime) * graphWidth;
      const y = padding + graphHeight - (value / maxValue) * graphHeight;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Draw control points
    sortedPoints.forEach((point) => {
      const x = padding + (point.time / maxTime) * graphWidth;
      const y = padding + graphHeight - (point.value / maxValue) * graphHeight;

      ctx.fillStyle = "#10b981";
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, 2 * Math.PI);
      ctx.fill();

      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    // Draw labels
    ctx.fillStyle = "#6b7280";
    ctx.font = "10px sans-serif";
    ctx.fillText(`${maxTime.toFixed(0)}min`, padding + graphWidth - 20, padding + graphHeight + 15);
    ctx.fillText(`${maxValue.toFixed(0)}kWh`, padding - 15, padding + 5);

  }, [curvePoints]);

  return (
    <canvas
      ref={canvasRef}
      width={280}
      height={150}
      className="w-full border border-gray-200 dark:border-gray-700 rounded bg-white dark:bg-gray-900"
    />
  );
};

export default ScenarioEditor;
