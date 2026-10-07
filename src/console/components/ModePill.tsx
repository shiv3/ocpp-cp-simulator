import React from "react";

import { cn } from "@/lib/utils";

export interface ModePillProps {
  mode: "local" | "remote";
}

/** Local / Remote as a dot plus text, with no fill. */
const ModePill: React.FC<ModePillProps> = ({ mode }) => {
  const isRemote = mode === "remote";
  return (
    <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-cx-fg2">
      <span
        aria-hidden
        className={cn(
          "h-[7px] w-[7px] rounded-full",
          isRemote ? "bg-cx-accent" : "bg-cx-emerald",
        )}
      />
      {isRemote ? "Remote mode" : "Local mode"}
    </span>
  );
};

export default ModePill;
