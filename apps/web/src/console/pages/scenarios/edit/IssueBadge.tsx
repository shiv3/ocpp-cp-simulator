import React from "react";

import { cn } from "@/lib/utils";
import type { IssueMark } from "../../../lib/graphIssueMarks";
import { SEVERITY, useMarkCounts, useMarkMessages } from "./issueMarkUi";

/**
 * The severity badge of a marked step: the worst severity's icon and the
 * number of diagnostics, named by its counts, with the messages as its
 * tooltip.
 */
const IssueBadge: React.FC<{
  mark: IssueMark;
  className?: string;
  style?: React.CSSProperties;
}> = ({ mark, className, style: placement }) => {
  const counts = useMarkCounts();
  const messages = useMarkMessages();
  const style = SEVERITY[mark.severity];
  const Icon = style.icon;
  return (
    <span
      role="img"
      data-issue-badge={mark.severity}
      aria-label={counts(mark)}
      title={messages(mark)}
      style={placement}
      className={cn(
        "inline-flex h-[18px] items-center gap-0.5 rounded-full border border-current/40 bg-cx-card px-1.5 text-[11px] font-semibold leading-none shadow-[0_1px_2px_rgba(20,20,30,0.08)]",
        style.text,
        className,
      )}
    >
      <Icon aria-hidden className="h-3 w-3" strokeWidth={2.25} />
      {mark.entries.length}
    </span>
  );
};

export default IssueBadge;
