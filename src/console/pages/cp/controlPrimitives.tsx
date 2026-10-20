import React from "react";

import { cn } from "@/lib/utils";

/** A titled box of related controls in a card's Controls block; reports its
 *  own failure. */
export const Group: React.FC<{
  title: string;
  error: string | null;
  children: React.ReactNode;
}> = ({ title, error, children }) => (
  <div
    role="group"
    aria-label={title}
    className="flex flex-col gap-2 rounded-[9px] border border-cx-border p-3"
  >
    <h4 className="text-[12.5px] font-semibold text-cx-fg2">{title}</h4>
    {children}
    {error && (
      <p role="alert" className="text-xs text-cx-rose">
        {error}
      </p>
    )}
  </div>
);

export const Row: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex flex-wrap items-center gap-1.5">{children}</div>
);

export const Hint: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className }) => (
  <span className={cn("text-[11.5px] text-cx-muted", className)}>
    {children}
  </span>
);
