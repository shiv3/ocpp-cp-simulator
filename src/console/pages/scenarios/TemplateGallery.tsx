import React from "react";

import {
  scenarioTemplates,
  type ScenarioTemplate,
} from "../../../utils/scenarioTemplates";

export interface TemplateGalleryProps {
  onUseTemplate: (template: ScenarioTemplate) => void;
}

const VISIBLE_COUNT = 8;

/**
 * Horizontal-scroll gallery of the first `VISIBLE_COUNT` built-in scenario
 * templates, with a count note for the rest. `scenarioTemplates` currently
 * has 40+ entries (cert16 suites dominate) — showing all of them inline
 * would drown the page, so this is a teaser; the full set stays reachable
 * from the scenario editor's own template picker.
 */
const TemplateGallery: React.FC<TemplateGalleryProps> = ({ onUseTemplate }) => {
  const visible = scenarioTemplates.slice(0, VISIBLE_COUNT);
  const remaining = scenarioTemplates.length - visible.length;

  return (
    <div className="mb-6">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
          Templates
        </h2>
        {remaining > 0 && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            +{remaining} more available in the scenario editor
          </span>
        )}
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {visible.map((template) => (
          <div
            key={template.id}
            className="w-64 shrink-0 rounded-lg border border-gray-200 p-3 dark:border-gray-700"
          >
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {template.name}
            </div>
            <p className="mt-1 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">
              {template.description}
            </p>
            <button
              type="button"
              onClick={() => onUseTemplate(template)}
              className="mt-3 rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              Use template
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default TemplateGallery;
