import React, { useMemo, useEffect, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Node,
  Edge,
  NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import StateNode from "./StateNode";
import StateTransitionTimeline from "./StateTransitionTimeline";
import type { Connector } from "../../cp/domain/connector/Connector";
import type { ChargePoint } from "../../cp/domain/charge-point/ChargePoint";
import type { HistoryOptions } from "../../cp/application/services/types/StateSnapshot";
import { useStateHistory } from "../../data/hooks/useStateHistory";

interface StateTransitionViewerProps {
  connector: Connector;
  chargePoint: ChargePoint;
  className?: string;
}

const nodeTypes: NodeTypes = {
  stateNode: StateNode,
};

const StateTransitionViewer: React.FC<StateTransitionViewerProps> = ({
  connector,
  chargePoint,
  className = "",
}) => {
  const [currentStatus, setCurrentStatus] = useState<OCPPStatus>(
    connector.status as OCPPStatus
  );
  const [currentHistoryIndex, setCurrentHistoryIndex] = useState<number>(-1);
  const historyOptions = useMemo<HistoryOptions>(() => ({
    entity: "connector",
    entityId: connector.id,
    transitionType: "status",
  }), [connector.id]);
  const { history } = useStateHistory(chargePoint.id, {
    historyOptions,
  });

  // Monitor connector status changes
  useEffect(() => {
    const unsubscribe = connector.events.on("statusChange", ({ status }) => {
      setCurrentStatus(status);
      // Reset history index when real-time status changes
      setCurrentHistoryIndex(-1);
    });

    return () => {
      unsubscribe();
    };
  }, [connector]);

  // Get history
  // Reflect state during history playback
  const displayStatus = useMemo(() => {
    if (currentHistoryIndex >= 0 && currentHistoryIndex < history.length) {
      return history[currentHistoryIndex].toState as OCPPStatus;
    }
    return currentStatus;
  }, [currentHistoryIndex, history, currentStatus]);

  // Node definitions (optimized layout with wider spacing)
  const nodes: Node[] = useMemo(
    () => [
      // Available (center bottom)
      {
        id: "available",
        type: "stateNode",
        position: { x: 500, y: 600 },
        data: {
          status: OCPPStatus.Available,
          label: "Available",
          isCurrent: displayStatus === OCPPStatus.Available,
          isOperative: true,
        },
      },
      // Preparing (center)
      {
        id: "preparing",
        type: "stateNode",
        position: { x: 500, y: 420 },
        data: {
          status: OCPPStatus.Preparing,
          label: "Preparing",
          isCurrent: displayStatus === OCPPStatus.Preparing,
          isOperative: true,
        },
      },
      // Charging (top center)
      {
        id: "charging",
        type: "stateNode",
        position: { x: 500, y: 150 },
        data: {
          status: OCPPStatus.Charging,
          label: "Charging",
          isCurrent: displayStatus === OCPPStatus.Charging,
          isOperative: true,
        },
      },
      // SuspendedEV (top left)
      {
        id: "suspendedEV",
        type: "stateNode",
        position: { x: 150, y: 80 },
        data: {
          status: OCPPStatus.SuspendedEV,
          label: "Suspended (EV)",
          isCurrent: displayStatus === OCPPStatus.SuspendedEV,
          isOperative: true,
        },
      },
      // SuspendedEVSE (top right)
      {
        id: "suspendedEVSE",
        type: "stateNode",
        position: { x: 850, y: 80 },
        data: {
          status: OCPPStatus.SuspendedEVSE,
          label: "Suspended (EVSE)",
          isCurrent: displayStatus === OCPPStatus.SuspendedEVSE,
          isOperative: true,
        },
      },
      // Finishing (center slightly down)
      {
        id: "finishing",
        type: "stateNode",
        position: { x: 500, y: 285 },
        data: {
          status: OCPPStatus.Finishing,
          label: "Finishing",
          isCurrent: displayStatus === OCPPStatus.Finishing,
          isOperative: true,
        },
      },
      // Reserved (bottom left)
      {
        id: "reserved",
        type: "stateNode",
        position: { x: 150, y: 600 },
        data: {
          status: OCPPStatus.Reserved,
          label: "Reserved",
          isCurrent: displayStatus === OCPPStatus.Reserved,
          isOperative: true,
        },
      },
      // Unavailable (bottom right)
      {
        id: "unavailable",
        type: "stateNode",
        position: { x: 850, y: 600 },
        data: {
          status: OCPPStatus.Unavailable,
          label: "Unavailable",
          isCurrent: displayStatus === OCPPStatus.Unavailable,
          isOperative: false,
        },
      },
      // Faulted (bottom center)
      {
        id: "faulted",
        type: "stateNode",
        position: { x: 500, y: 780 },
        data: {
          status: OCPPStatus.Faulted,
          label: "Faulted",
          isCurrent: displayStatus === OCPPStatus.Faulted,
          isOperative: false,
        },
      },
    ],
    [displayStatus]
  );

  // Edge definitions (OCPP 1.6J compliant transitions, using smoothstep for better visibility)
  const edges: Edge[] = useMemo(
    () => [
      // Transitions from Available
      {
        id: "available-preparing",
        source: "available",
        target: "preparing",
        sourceHandle: "top-source",
        targetHandle: "bottom-target",
        type: "smoothstep",
        label: "PLUGIN",
        animated: true,
        style: { stroke: "#22c55e", strokeWidth: 2 },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },
      {
        id: "available-reserved",
        source: "available",
        target: "reserved",
        sourceHandle: "left-source",
        targetHandle: "right-target",
        type: "smoothstep",
        label: "RESERVE",
        style: { stroke: "#a855f7", strokeWidth: 2 },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },
      {
        id: "available-unavailable",
        source: "available",
        target: "unavailable",
        sourceHandle: "right",
        targetHandle: "left",
        type: "smoothstep",
        label: "SET_UNAVAILABLE",
        style: { stroke: "#6b7280", strokeWidth: 2 },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },
      {
        id: "available-faulted",
        source: "available",
        target: "faulted",
        sourceHandle: "bottom",
        targetHandle: "top",
        type: "default",
        label: "ERROR",
        style: { stroke: "#ef4444", strokeWidth: 2, strokeDasharray: "5, 5" },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },

      // Transitions from Preparing
      {
        id: "preparing-charging",
        source: "preparing",
        target: "charging",
        sourceHandle: "top-source",
        targetHandle: "bottom-target",
        type: "smoothstep",
        label: "START_TX",
        animated: true,
        style: { stroke: "#10b981", strokeWidth: 2 },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },
      {
        id: "preparing-available",
        source: "preparing",
        target: "available",
        sourceHandle: "bottom",
        targetHandle: "top",
        type: "smoothstep",
        label: "PLUGOUT",
        style: { stroke: "#6b7280", strokeWidth: 2 },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },
      {
        id: "preparing-faulted",
        source: "preparing",
        target: "faulted",
        sourceHandle: "right",
        targetHandle: "right-target",
        type: "default",
        label: "ERROR",
        style: { stroke: "#ef4444", strokeWidth: 2, strokeDasharray: "5, 5" },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },

      // Transitions from Charging
      {
        id: "charging-suspendedEV",
        source: "charging",
        target: "suspendedEV",
        sourceHandle: "left-source",
        targetHandle: "right-target",
        type: "smoothstep",
        label: "SUSPEND_EV",
        style: { stroke: "#f97316", strokeWidth: 2 },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },
      {
        id: "charging-suspendedEVSE",
        source: "charging",
        target: "suspendedEVSE",
        sourceHandle: "right",
        targetHandle: "left",
        type: "smoothstep",
        label: "SUSPEND_EVSE",
        style: { stroke: "#f97316", strokeWidth: 2 },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },
      {
        id: "charging-finishing",
        source: "charging",
        target: "finishing",
        sourceHandle: "bottom",
        targetHandle: "top",
        type: "smoothstep",
        label: "STOP_TX",
        animated: true,
        style: { stroke: "#06b6d4", strokeWidth: 2 },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },
      {
        id: "charging-faulted",
        source: "charging",
        target: "faulted",
        sourceHandle: "left-source",
        targetHandle: "left",
        type: "default",
        label: "ERROR",
        style: { stroke: "#ef4444", strokeWidth: 2, strokeDasharray: "5, 5" },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },

      // Transitions from SuspendedEV
      {
        id: "suspendedEV-charging",
        source: "suspendedEV",
        target: "charging",
        sourceHandle: "right",
        targetHandle: "left",
        type: "smoothstep",
        label: "RESUME",
        style: { stroke: "#10b981", strokeWidth: 2 },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },
      {
        id: "suspendedEV-suspendedEVSE",
        source: "suspendedEV",
        target: "suspendedEVSE",
        sourceHandle: "top-source",
        targetHandle: "top",
        type: "smoothstep",
        label: "SUSPEND_EVSE",
        style: { stroke: "#f97316", strokeWidth: 2 },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },
      {
        id: "suspendedEV-finishing",
        source: "suspendedEV",
        target: "finishing",
        sourceHandle: "bottom",
        targetHandle: "left",
        type: "smoothstep",
        label: "STOP_TX",
        style: { stroke: "#06b6d4", strokeWidth: 2 },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },

      // Transitions from SuspendedEVSE
      {
        id: "suspendedEVSE-charging",
        source: "suspendedEVSE",
        target: "charging",
        sourceHandle: "left-source",
        targetHandle: "right-target",
        type: "smoothstep",
        label: "RESUME",
        style: { stroke: "#10b981", strokeWidth: 2 },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },
      {
        id: "suspendedEVSE-suspendedEV",
        source: "suspendedEVSE",
        target: "suspendedEV",
        sourceHandle: "top-source",
        targetHandle: "top",
        type: "smoothstep",
        label: "SUSPEND_EV",
        style: { stroke: "#f97316", strokeWidth: 2 },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },
      {
        id: "suspendedEVSE-finishing",
        source: "suspendedEVSE",
        target: "finishing",
        sourceHandle: "bottom",
        targetHandle: "right-target",
        type: "smoothstep",
        label: "STOP_TX",
        style: { stroke: "#06b6d4", strokeWidth: 2 },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },

      // Transitions from Finishing
      {
        id: "finishing-available",
        source: "finishing",
        target: "available",
        sourceHandle: "bottom",
        targetHandle: "top",
        type: "smoothstep",
        label: "PLUGOUT",
        animated: true,
        style: { stroke: "#22c55e", strokeWidth: 2 },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },
      {
        id: "finishing-faulted",
        source: "finishing",
        target: "faulted",
        sourceHandle: "left-source",
        targetHandle: "top",
        type: "default",
        label: "ERROR",
        style: { stroke: "#ef4444", strokeWidth: 2, strokeDasharray: "5, 5" },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },

      // Transitions from Reserved
      {
        id: "reserved-preparing",
        source: "reserved",
        target: "preparing",
        sourceHandle: "top-source",
        targetHandle: "left",
        type: "smoothstep",
        label: "PLUGIN",
        style: { stroke: "#22c55e", strokeWidth: 2 },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },
      {
        id: "reserved-available",
        source: "reserved",
        target: "available",
        sourceHandle: "right",
        targetHandle: "left",
        type: "smoothstep",
        label: "CANCEL",
        style: { stroke: "#6b7280", strokeWidth: 2 },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },
      {
        id: "reserved-faulted",
        source: "reserved",
        target: "faulted",
        sourceHandle: "bottom",
        targetHandle: "left",
        type: "default",
        label: "ERROR",
        style: { stroke: "#ef4444", strokeWidth: 2, strokeDasharray: "5, 5" },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },

      // Transitions from Unavailable
      {
        id: "unavailable-available",
        source: "unavailable",
        target: "available",
        sourceHandle: "left-source",
        targetHandle: "right-target",
        type: "smoothstep",
        label: "SET_AVAILABLE",
        style: { stroke: "#22c55e", strokeWidth: 2 },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },
      {
        id: "unavailable-faulted",
        source: "unavailable",
        target: "faulted",
        sourceHandle: "bottom",
        targetHandle: "right-target",
        type: "default",
        label: "ERROR",
        style: { stroke: "#ef4444", strokeWidth: 2, strokeDasharray: "5, 5" },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },

      // Transitions from Faulted
      {
        id: "faulted-available",
        source: "faulted",
        target: "available",
        sourceHandle: "top-source",
        targetHandle: "bottom-target",
        type: "smoothstep",
        label: "RESET",
        style: { stroke: "#22c55e", strokeWidth: 2 },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },
      {
        id: "faulted-unavailable",
        source: "faulted",
        target: "unavailable",
        sourceHandle: "right",
        targetHandle: "bottom-target",
        type: "smoothstep",
        label: "SET_UNAVAILABLE",
        style: { stroke: "#6b7280", strokeWidth: 2 },
        labelStyle: { fill: "#1f2937", fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.9 },
        labelBgPadding: [8, 4] as [number, number],
        labelBgBorderRadius: 4,
      },
    ],
    []
  );

  return (
    <div className={`h-full w-full flex flex-col ${className}`}>
      {/* React Flow - Top */}
      <div className="flex-1 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          nodesDraggable={true}
          fitView
          attributionPosition="bottom-left"
          minZoom={0.5}
          maxZoom={2}
          defaultEdgeOptions={{
            markerEnd: {
              type: "arrowclosed",
              width: 20,
              height: 20,
            },
          }}
        >
          <Background />
          <Controls />
          <MiniMap
            nodeColor={(node) => {
              if (node.data?.isCurrent) return "#3b82f6";
              if (!node.data?.isOperative) return "#6b7280";
              return "#22c55e";
            }}
            nodeStrokeWidth={3}
          />
        </ReactFlow>

        {/* Legend */}
        <div className="absolute top-4 right-4 bg-white dark:bg-gray-800 p-4 rounded-lg shadow-lg text-sm">
          <h3 className="font-bold mb-2 text-gray-900 dark:text-white">
            State Transition Diagram
          </h3>
          <div className="space-y-1 text-gray-700 dark:text-gray-300">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-blue-500 rounded"></div>
              <span>Current State</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-green-400 rounded"></div>
              <span>Available</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-emerald-500 rounded"></div>
              <span>Charging</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-orange-400 rounded"></div>
              <span>Suspended</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-gray-400 rounded"></div>
              <span>Inoperative</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 bg-red-500 rounded"></div>
              <span>Faulted</span>
            </div>
          </div>
        </div>
      </div>

      {/* Timeline - Bottom */}
      <div className="h-64 flex-shrink-0">
        <StateTransitionTimeline
          history={history}
          onSelectTransition={setCurrentHistoryIndex}
          currentIndex={currentHistoryIndex}
        />
      </div>
    </div>
  );
};

export default StateTransitionViewer;
