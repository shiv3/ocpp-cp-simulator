import React from "react";

import { cn } from "@/lib/utils";

/** One figure of a card: a small uppercase label over a 16px value, the
 *  mock's `.kv`, with an optional 3px bar. Render inside a `<dl>`. */
const Figure: React.FC<{
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode;
  bar?: { pct: number; className: string };
}> = ({ label, value, note, bar }) => (
  <div>
    <dt className="mb-[3px] text-[11px] uppercase tracking-[0.06em] text-cx-faint">
      {label}
    </dt>
    <dd className="text-base font-medium tracking-[-0.01em] tabular-nums text-cx-fg">
      {value}
      {note && (
        <small className="ml-1 whitespace-nowrap text-xs font-normal text-cx-muted @max-[560px]:ml-0 @max-[560px]:block">
          {note}
        </small>
      )}
      {bar && (
        <div className="mt-1.5 h-[3px] overflow-hidden rounded-sm bg-cx-sub">
          <div
            className={cn("h-full rounded-sm", bar.className)}
            style={{ width: `${Math.min(100, Math.max(0, bar.pct))}%` }}
          />
        </div>
      )}
    </dd>
  </div>
);

export default Figure;
