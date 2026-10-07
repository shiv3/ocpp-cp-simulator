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
    <div className="rounded-[10px] border border-cx-border bg-cx-card shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none p-2">
      <div className="mb-2 flex items-center gap-2">
        <input
          autoFocus
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search step types…"
          aria-label="Search step types"
          className="flex-1 rounded-md border border-cx-border-strong bg-transparent px-2 py-1 text-sm"
        />
        <button
          type="button"
          aria-label="Close add-step picker"
          onClick={onClose}
          className="rounded p-1 text-cx-faint hover:bg-cx-sub"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="max-h-64 space-y-2 overflow-y-auto">
        {sections.length === 0 && (
          <div className="px-1 py-2 text-xs text-cx-faint">No matches</div>
        )}
        {sections.map((category) => (
          <div key={category.label}>
            <div className="px-1 text-xs font-semibold uppercase tracking-wide text-cx-faint">
              {category.label}
            </div>
            {category.types.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => onPick(type)}
                className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-cx-fg2 hover:bg-cx-sub"
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
