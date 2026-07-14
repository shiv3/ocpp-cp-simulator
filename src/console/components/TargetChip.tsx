import React from "react";

export interface TargetChipProps {
  cpId: string;
  connectorId?: number | null;
}

const TargetChip: React.FC<TargetChipProps> = ({ cpId, connectorId }) => (
  <span className="inline-flex items-center rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 font-mono text-xs font-medium text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
    {connectorId != null ? `${cpId} · C${connectorId}` : cpId}
  </span>
);

export default TargetChip;
