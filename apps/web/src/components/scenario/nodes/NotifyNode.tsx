import { useTranslation } from "react-i18next";
import React, { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { Handle, Position, type Node } from "@xyflow/react";
import type { NotifyNodeData } from "@ocpp-cp-sim/core/cp/application/scenario/ScenarioTypes";

/** Schema 1.6 (#654): sends a status notification and goes on. */
const NotifyNode: React.FC<NodeProps<Node<NotifyNodeData>>> = ({
  data,
  selected,
}) => {
  const { t } = useTranslation();
  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white dark:bg-gray-800 min-w-[200px] ${
        selected ? "border-blue-500" : "border-gray-300 dark:border-gray-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />
      <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
        {t("scenarioNodes.title.notify")}
      </div>
      <div className="text-sm font-mono text-primary truncate">{data.kind}</div>
      <div className="text-xs font-mono text-secondary truncate">
        {data.status}
      </div>
      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(NotifyNode);
