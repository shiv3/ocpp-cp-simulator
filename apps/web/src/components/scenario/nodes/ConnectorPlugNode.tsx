import { useTranslation } from "react-i18next";
import React, { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { Handle, Position, type Node } from "@xyflow/react";
import type { ConnectorPlugNodeData } from "@ocpp-cp-sim/core/cp/application/scenario/ScenarioTypes";

const ConnectorPlugNode: React.FC<NodeProps<Node<ConnectorPlugNodeData>>> = ({
  data,
  selected,
}) => {
  const { t } = useTranslation();
  const actionIcon = data.action === "plugin" ? "🔌" : "🔓";
  const actionText =
    data.action === "plugin"
      ? t("scenarioNodes.plug.in")
      : t("scenarioNodes.plug.out");
  const actionColor =
    data.action === "plugin"
      ? "text-green-700 dark:text-green-300"
      : "text-red-700 dark:text-red-300";

  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white dark:bg-gray-800 min-w-[180px] ${
        selected ? "border-blue-500" : "border-gray-300 dark:border-gray-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />

      <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
        {t("scenarioNodes.title.connectorPlug")}
      </div>
      <div className="flex items-center gap-2">
        <div className="text-2xl">{actionIcon}</div>
        <div>
          <div className={`font-bold text-sm ${actionColor}`}>{actionText}</div>
          <div className="text-xs text-muted">
            {t("scenarioNodes.plug.cableAction")}
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(ConnectorPlugNode);
