import React, { useEffect } from "react";
import { Handle, Position, useUpdateNodeInternals } from "@xyflow/react";

export interface BranchHandle {
  /** The edge's `sourceHandle`. */
  id: string;
  label: string;
  title?: string;
}

/** One source handle per branch, side by side along the bottom of a node.
 *  Each handle's `id` is the `sourceHandle` an edge drawn from it carries. */
const BranchHandles: React.FC<{
  nodeId: string;
  branches: BranchHandle[];
}> = ({ nodeId, branches }) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const signature = branches.map((b) => b.id).join("|");
  useEffect(() => {
    updateNodeInternals(nodeId);
  }, [nodeId, signature, updateNodeInternals]);
  return (
    <div className="flex gap-1 mt-3 -mb-3">
      {branches.map((branch) => (
        <div
          key={branch.id}
          className="relative flex-1 min-w-[40px] pb-4 text-center"
          title={branch.title ?? branch.label}
        >
          <div className="text-[10px] font-mono text-secondary truncate">
            {branch.label}
          </div>
          <Handle
            id={branch.id}
            type="source"
            position={Position.Bottom}
            className="w-3 h-3"
          />
        </div>
      ))}
    </div>
  );
};

export default BranchHandles;
