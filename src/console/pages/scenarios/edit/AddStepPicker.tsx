import React, { useMemo, useState } from "react";
import { X } from "lucide-react";

import { NODE_FORM_REGISTRY } from "../../../../components/scenario/forms/nodeFormRegistry";
import { STEP_CATEGORIES } from "../../../lib/scenarioSteps";
import type { ScenarioNodeType } from "../../../../cp/application/scenario/ScenarioTypes";

export interface AddStepPickerProps {
  onPick: (type: ScenarioNodeType) => void;
  onClose: () => void;
}

/**
 * Inline "add a step" panel (not a Radix Popover — none is installed in this
 * repo, and an inline expanding panel avoids portal/focus complications in
 * jsdom dom tests while behaving identically for the operator). Renders
 * `STEP_CATEGORIES` as labeled sections, filtered by a search box matching
 * each type's registry `title`.
 */
const AddStepPicker: React.FC<AddStepPickerProps> = ({ onPick, onClose }) => {
  const [query, setQuery] = useState("");

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    return STEP_CATEGORIES.map((category) => ({
      label: category.label,
      types: category.types.filter((type) =>
        NODE_FORM_REGISTRY[type].title.toLowerCase().includes(q),
      ),
    })).filter((category) => category.types.length > 0);
  }, [query]);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-2 shadow-sm dark:border-gray-700 dark:bg-gray-900">
      <div className="mb-2 flex items-center gap-2">
        <input
          autoFocus
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search step types…"
          aria-label="Search step types"
          className="flex-1 rounded-md border border-gray-300 bg-transparent px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        />
        <button
          type="button"
          aria-label="Close add-step picker"
          onClick={onClose}
          className="rounded p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="max-h-64 space-y-2 overflow-y-auto">
        {sections.length === 0 && (
          <div className="px-1 py-2 text-xs text-gray-400">No matches</div>
        )}
        {sections.map((category) => (
          <div key={category.label}>
            <div className="px-1 text-xs font-semibold uppercase tracking-wide text-gray-400">
              {category.label}
            </div>
            {category.types.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => onPick(type)}
                className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
              >
                {NODE_FORM_REGISTRY[type].title}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};

export default AddStepPicker;
