import React from "react";

import { cn } from "@/lib/utils";
import type { Labels } from "../../protocol/labels";

export interface LabelChipsProps {
  labels?: Labels;
  className?: string;
}

/**
 * A charge point's labels (#446) as small `key=value` chips, in the order the
 * daemon returned them. Renders nothing when there are none.
 */
const LabelChips: React.FC<LabelChipsProps> = ({ labels, className }) => {
  const entries = Object.entries(labels ?? {});
  if (entries.length === 0) return null;
  return (
    <span
      className={cn("inline-flex flex-wrap items-center gap-1", className)}
      aria-label="Labels"
    >
      {entries.map(([key, value]) => (
        <span
          key={key}
          data-label={key}
          className="whitespace-nowrap rounded border border-cx-border bg-cx-sub px-1.5 py-px font-mono text-[11px] text-cx-fg2"
        >
          {key}
          {value ? <span className="text-cx-muted">={value}</span> : null}
        </span>
      ))}
    </span>
  );
};

export default LabelChips;
