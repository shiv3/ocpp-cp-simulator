import { useTranslation } from "react-i18next";
import React, { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { Handle, Position, type Node } from "@xyflow/react";
import type { StatusNotificationNodeData } from "@ocpp-cp-sim/core/cp/application/scenario/ScenarioTypes";

/**
 * §4.9 StatusNotification.req node — pushes a full status payload
 * (status + errorCode + info + vendorErrorCode) without mutating the
 * connector's runtime status field. Used to drive Faulted-with-context
 * paths CSMS implementations care about.
 */
const StatusNotificationNode: React.FC<
  NodeProps<Node<StatusNotificationNodeData>>
> = ({ data, selected }) => {
  const { t } = useTranslation();
  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-white dark:bg-gray-800 min-w-[200px] ${
        selected ? "border-blue-500" : "border-gray-300 dark:border-gray-600"
      }`}
    >
      <Handle type="target" position={Position.Top} className="w-3 h-3" />

      <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
        StatusNotification (§4.9)
      </div>
      <div className="text-sm font-bold text-primary">
        {data.status}
        {data.connectorId !== undefined
          ? ` · ${t("scenarioNodes.conn", { id: data.connectorId })}`
          : ""}
      </div>
      {data.errorCode && data.errorCode !== "NoError" && (
        <div className="text-xs text-red-700 dark:text-red-300 font-mono">
          {data.errorCode}
        </div>
      )}
      {data.info && (
        <div className="text-xs text-muted truncate" title={data.info}>
          info: {data.info}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
    </div>
  );
};

export default memo(StatusNotificationNode);
