import { useTranslation } from "react-i18next";
import React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A collapsible side panel: a button on its edge folds it into a thin rail that
 * keeps the button (and the panel's name, sideways). Selecting a step in the
 * views opens it again (the host calls `setCollapsed(false)`).
 */
const CollapsibleSide: React.FC<{
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /** The panel's name (the rail's label). */
  label: string;
  className?: string;
  /** The padding etc. of the content (not of the rail). */
  contentClassName?: string;
  testId?: string;
  children: React.ReactNode;
}> = ({
  collapsed,
  onCollapsedChange,
  label,
  className,
  contentClassName,
  testId,
  children,
}) => {
  const { t } = useTranslation();
  // The panel's content stays mounted but hidden while collapsed: a form
  // half-filled survives a fold.
  return (
    <div
      data-testid={testId}
      data-collapsed={collapsed ? "" : undefined}
      className={cn(
        "relative min-w-0 rounded-[10px] border border-cx-border bg-cx-card shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none",
        className,
      )}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={t(
          collapsed
            ? "scenarios.inspector.expand"
            : "scenarios.inspector.collapse",
        )}
        title={t(
          collapsed
            ? "scenarios.inspector.expand"
            : "scenarios.inspector.collapse",
        )}
        onClick={() => onCollapsedChange(!collapsed)}
        className={cn(
          "absolute z-10 flex h-6 w-6 items-center justify-center rounded-full border border-cx-border-strong bg-cx-card text-cx-muted hover:border-cx-accent hover:text-cx-accent",
          collapsed ? "left-1/2 top-2 -translate-x-1/2" : "-left-3 top-3",
        )}
      >
        {collapsed ? (
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
        )}
      </button>
      {collapsed && (
        <span
          aria-hidden
          className="absolute inset-x-0 top-10 flex justify-center text-xs text-cx-faint [writing-mode:vertical-rl]"
        >
          {label}
        </span>
      )}
      <div hidden={collapsed} className={contentClassName}>
        {children}
      </div>
    </div>
  );
};

export default CollapsibleSide;
