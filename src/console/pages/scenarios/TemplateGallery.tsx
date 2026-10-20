import React, { useState } from "react";

import {
  scenarioTemplates,
  type ScenarioTemplate,
} from "../../../utils/scenarioTemplates";
import TemplateBrowserDialog from "./TemplateBrowserDialog";

export interface TemplateGalleryProps {
  onUseTemplate: (template: ScenarioTemplate) => void;
}

const VISIBLE_COUNT = 8;

/**
 * Horizontal-scroll gallery of the first `VISIBLE_COUNT` built-in scenario
 * templates, with a button that opens the searchable browser for all of them.
 * `scenarioTemplates` currently has 40+ entries (cert16 suites dominate) —
 * showing all of them inline would drown the page, so this is a teaser and
 * {@link TemplateBrowserDialog} is how every template is reached.
 */
const TemplateGallery: React.FC<TemplateGalleryProps> = ({ onUseTemplate }) => {
  const visible = scenarioTemplates.slice(0, VISIBLE_COUNT);
  const remaining = scenarioTemplates.length - visible.length;
  const [browsing, setBrowsing] = useState(false);

  return (
    <div className="mb-6">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-cx-fg2">Templates</h2>
        {remaining > 0 && (
          <button
            type="button"
            onClick={() => setBrowsing(true)}
            className="text-xs text-cx-accent hover:underline"
          >
            Browse all {scenarioTemplates.length} templates
          </button>
        )}
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {visible.map((template) => (
          <div
            key={template.id}
            className="w-64 shrink-0 rounded-lg border border-cx-border p-3"
          >
            <div className="text-sm font-medium text-cx-fg">
              {template.name}
            </div>
            <p className="mt-1 line-clamp-2 text-xs text-cx-muted">
              {template.description}
            </p>
            <button
              type="button"
              onClick={() => onUseTemplate(template)}
              className="mt-3 rounded-md border border-cx-border px-2.5 py-1 text-xs font-medium text-cx-fg2 hover:bg-cx-sub"
            >
              Use template
            </button>
          </div>
        ))}
      </div>
      <TemplateBrowserDialog
        open={browsing}
        onOpenChange={setBrowsing}
        onUseTemplate={onUseTemplate}
      />
    </div>
  );
};

export default TemplateGallery;
