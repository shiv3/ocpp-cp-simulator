import React, { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { useT } from "../../../i18n";
import { Handle, Position, type Node } from "@xyflow/react";
import type { NotificationNodeData } from "@ocpp-cp-sim/core/cp/application/scenario/ScenarioTypes";

const NotificationNode: React.FC<NodeProps<Node<NotificationNodeData>>> = ({
  data,
  selected,
}) => {
  const t = useT();
  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white dark:bg-gray-800 min-w-[180px] ${
        selected ? "border-blue-500" : "border-gray-300 dark:border-gray-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />

      <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
        {t("scenarioNodes.title.notification")}
      </div>
      <div className="flex items-center gap-2">
        <div className="text-2xl">📤</div>
        <div>
          <div className="font-bold text-sm text-primary">
            {data.messageType}
          </div>
          <div className="text-xs text-muted">
            {t("scenarioNodes.meter.sendMessage")}
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(NotificationNode);
