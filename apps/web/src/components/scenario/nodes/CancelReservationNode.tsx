import { useTranslation } from "react-i18next";
import React, { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { Handle, Position, type Node } from "@xyflow/react";
import type { CancelReservationNodeData } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

const CancelReservationNode: React.FC<
  NodeProps<Node<CancelReservationNodeData>>
> = ({ data, selected }) => {
  const { t } = useTranslation();
  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-orange-50 dark:bg-orange-900 min-w-[180px] ${
        selected
          ? "border-blue-500"
          : "border-orange-400 dark:border-orange-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />

      <div className="text-xs font-semibold text-orange-700 dark:text-orange-300 mb-1">
        {t("scenarioNodes.title.cancelReservation")}
      </div>
      <div className="font-bold text-sm text-primary mb-1">{data.label}</div>
      <div className="text-xs text-muted">
        {t("scenarioNodes.reservationId", { id: data.reservationId })}
      </div>

      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(CancelReservationNode);
