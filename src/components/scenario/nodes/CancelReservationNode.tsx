import React, { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { CancelReservationNodeData } from "../../../cp/application/scenario/ScenarioTypes";

const CancelReservationNode: React.FC<NodeProps<CancelReservationNodeData>> = ({
  data,
  selected,
}) => {
  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-orange-50 dark:bg-orange-900 min-w-[180px] ${
        selected ? "border-blue-500" : "border-orange-400 dark:border-orange-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />

      <div className="text-xs font-semibold text-orange-600 dark:text-orange-300 mb-1">
        Cancel Reservation
      </div>
      <div className="font-bold text-sm text-primary mb-1">{data.label}</div>
      <div className="text-xs text-muted">
        Reservation ID: {data.reservationId}
      </div>

      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(CancelReservationNode);
