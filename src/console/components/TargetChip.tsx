import React from "react";

export interface TargetChipProps {
  cpId: string;
  connectorId?: number | null;
}

const TargetChip: React.FC<TargetChipProps> = ({ cpId, connectorId }) => (
  <span className="inline-flex items-center font-mono text-[11.5px] text-cx-faint">
    {connectorId != null ? `${cpId} · C${connectorId}` : cpId}
  </span>
);

export default TargetChip;
