import { useTranslation } from "react-i18next";
import React, { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { Handle, Position, type Node } from "@xyflow/react";
import type { UseBehaviorNodeData } from "@ocpp-cp-sim/core/cp/application/scenario/ScenarioTypes";

/** Schema 1.5 (#566): uses a behavior loaded on the station. */
const UseBehaviorNode: React.FC<NodeProps<Node<UseBehaviorNodeData>>> = ({
  data,
  selected,
}) => {
  const { t } = useTranslation();
  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white dark:bg-gray-800 min-w-[220px] ${
        selected ? "border-blue-500" : "border-gray-300 dark:border-gray-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />
      <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
        {t("scenarioNodes.title.useBehavior")}
      </div>
      <div
        className="text-sm font-mono text-primary truncate"
        title={data.behaviorId}
      >
        {data.behaviorId}
      </div>
      {data.mode === "disable" ? (
        <div className="text-xs text-red-600 dark:text-red-400 mt-1">
          {t("scenarioNodes.useBehavior.disabled")}
        </div>
      ) : data.params && Object.keys(data.params).length > 0 ? (
        <div
          className="text-xs font-mono text-secondary mt-1 truncate"
          title={JSON.stringify(data.params)}
        >
          {Object.entries(data.params)
            .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
            .join(" ")}
        </div>
      ) : null}
      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(UseBehaviorNode);
