import React from "react";

import { cn } from "@/lib/utils";
import type { CpListView } from "./cpListFilters";

const VIEWS: Array<{ view: CpListView; label: string }> = [
  { view: "hierarchy", label: "Hierarchy" },
  { view: "cp", label: "Charge points" },
  { view: "connectors", label: "Connectors" },
];

/** Segmented control that picks how the list is laid out. */
const ViewSwitch: React.FC<{
  view: CpListView;
  onChange: (view: CpListView) => void;
}> = ({ view, onChange }) => (
  <div
    role="group"
    aria-label="View"
    className="inline-flex overflow-hidden rounded-md border border-gray-200 dark:border-gray-700"
  >
    {VIEWS.map((item) => (
      <button
        key={item.view}
        type="button"
        aria-pressed={view === item.view}
        onClick={() => onChange(item.view)}
        className={cn(
          "border-l border-gray-200 px-3 py-1.5 text-sm first:border-l-0 dark:border-gray-700",
          view === item.view
            ? "bg-gray-900 font-medium text-white dark:bg-gray-100 dark:text-gray-900"
            : "bg-white text-gray-600 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800",
        )}
      >
        {item.label}
      </button>
    ))}
  </div>
);

export default ViewSwitch;
