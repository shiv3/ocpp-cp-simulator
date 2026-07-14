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
  <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-gray-300 p-10 text-center dark:border-gray-700">
    {Icon && <Icon className="h-8 w-8 text-gray-400 dark:text-gray-500" />}
    <div className="text-sm font-semibold text-gray-700 dark:text-gray-200">
      {title}
    </div>
    {hint != null && (
      <p className="max-w-sm text-sm text-gray-500 dark:text-gray-400">
        {hint}
      </p>
    )}
    {action != null && <div className="mt-1">{action}</div>}
  </div>
);

export default EmptyState;
