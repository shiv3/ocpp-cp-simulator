import React from "react";

import { cn } from "@/lib/utils";
import { SEVERITY } from "../../edit/issueMarkUi";
import type { IssueMark } from "../../../../lib/graphIssueMarks";

/** The marker at the middle of a drawn edge with a diagnostic. */
const EdgeIssueMarker: React.FC<{
  mark: IssueMark;
  x: number;
  y: number;
  label: string;
  title: string;
}> = ({ mark, x, y, label, title }) => {
  const style = SEVERITY[mark.severity];
  const Icon = style.icon;
  return (
    <span
      role="img"
      data-edge-issue={mark.severity}
      aria-label={label}
      title={title}
      className={cn(
        "absolute z-10 flex h-4 w-4 items-center justify-center rounded-full border border-current bg-cx-card",
        style.text,
      )}
      style={{ left: x - 8, top: y - 8 }}
    >
      <Icon aria-hidden className="h-2.5 w-2.5" strokeWidth={2.5} />
    </span>
  );
};

export default EdgeIssueMarker;
