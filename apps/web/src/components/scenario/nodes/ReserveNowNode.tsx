import React, { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { useT } from "../../../i18n";
import { Handle, Position, type Node } from "@xyflow/react";
import type { ReserveNowNodeData } from "@ocpp-cp-sim/core/cp/application/scenario/ScenarioTypes";

const ReserveNowNode: React.FC<NodeProps<Node<ReserveNowNodeData>>> = ({
  data,
  selected,
}) => {
  const t = useT();
  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-amber-50 dark:bg-amber-900 min-w-[180px] ${
        selected ? "border-blue-500" : "border-amber-400 dark:border-amber-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />

      <div className="text-xs font-semibold text-amber-700 dark:text-amber-300 mb-1">
        {t("scenarioNodes.title.reserveNow")}
      </div>
      <div className="font-bold text-sm text-primary mb-1">{data.label}</div>
      <div className="text-xs text-muted space-y-0.5">
        <div>{t("scenarioNodes.idTag", { value: data.idTag })}</div>
        <div>
          {t("scenarioNodes.expiryMinutes", { minutes: data.expiryMinutes })}
        </div>
        {data.parentIdTag && (
          <div>{t("scenarioNodes.parent", { value: data.parentIdTag })}</div>
        )}
        {data.reservationId && (
          <div>
            {t("scenarioNodes.reservationId", { id: data.reservationId })}
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(ReserveNowNode);
