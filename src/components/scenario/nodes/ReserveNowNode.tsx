import React, { memo } from "react";
import { Handle, Position, NodeProps } from "@xyflow/react";
import { ReserveNowNodeData } from "../../../cp/application/scenario/ScenarioTypes";

const ReserveNowNode: React.FC<NodeProps<ReserveNowNodeData>> = ({
  data,
  selected,
}) => {
  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-amber-50 dark:bg-amber-900 min-w-[180px] ${
        selected ? "border-blue-500" : "border-amber-400 dark:border-amber-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />

      <div className="text-xs font-semibold text-amber-600 dark:text-amber-300 mb-1">
        Reserve Now
      </div>
      <div className="font-bold text-sm text-primary mb-1">{data.label}</div>
      <div className="text-xs text-muted space-y-0.5">
        <div>ID Tag: {data.idTag}</div>
        <div>Expiry: {data.expiryMinutes} min</div>
        {data.parentIdTag && (
          <div>Parent: {data.parentIdTag}</div>
        )}
        {data.reservationId && (
          <div>Reservation ID: {data.reservationId}</div>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(ReserveNowNode);
