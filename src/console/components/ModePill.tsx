import React from "react";

import { cn } from "@/lib/utils";

export interface ModePillProps {
  mode: "local" | "remote";
}

const ModePill: React.FC<ModePillProps> = ({ mode }) => {
  const isRemote = mode === "remote";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold",
        isRemote
          ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
          : "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {isRemote ? "Remote mode" : "Local mode"}
    </span>
  );
};

export default ModePill;
