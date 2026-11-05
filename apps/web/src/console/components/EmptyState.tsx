import React from "react";
import { type LucideIcon } from "lucide-react";

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: React.ReactNode;
  hint?: React.ReactNode;
  action?: React.ReactNode;
}

const EmptyState: React.FC<EmptyStateProps> = ({
  icon: Icon,
  title,
  hint,
  action,
}) => (
  <div className="flex flex-col items-center justify-center gap-3 rounded-[10px] border border-dashed border-cx-border-strong p-10 text-center text-cx-muted">
    {Icon && <Icon className="h-8 w-8 text-cx-faint" />}
    <div className="text-sm font-semibold text-cx-fg2">{title}</div>
    {hint != null && <p className="max-w-sm text-sm text-cx-muted">{hint}</p>}
    {action != null && <div className="mt-1">{action}</div>}
  </div>
);

export default EmptyState;
