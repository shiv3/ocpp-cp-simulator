import { useTranslation } from "react-i18next";
import React, { useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useTemplateText } from "@/i18n/templates";

import {
  scenarioTemplates,
  type ScenarioTemplate,
} from "@ocpp-cp-sim/core/utils/scenarioTemplates";

export interface TemplateBrowserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUseTemplate: (template: ScenarioTemplate) => void;
}

/** The templates whose name or description contains `query` (case-insensitive). */
function filterTemplates(
  query: string,
  text: ReturnType<typeof useTemplateText>,
): ScenarioTemplate[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return scenarioTemplates;
  return scenarioTemplates.filter(
    (template) =>
      template.name.toLowerCase().includes(needle) ||
      template.description.toLowerCase().includes(needle) ||
      text.name(template).toLowerCase().includes(needle) ||
      text.description(template).toLowerCase().includes(needle),
  );
}

const Body: React.FC<Omit<TemplateBrowserDialogProps, "open">> = ({
  onOpenChange,
  onUseTemplate,
}) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const text = useTemplateText();
  const visible = filterTemplates(query, text);

  const use = (template: ScenarioTemplate) => {
    onOpenChange(false);
    onUseTemplate(template);
  };

  return (
    <div className="flex min-h-0 flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <Input
          autoFocus
          type="search"
          aria-label={t("scenarios.templateBrowser.searchLabel")}
          placeholder={t("scenarios.templateBrowser.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (visible.length > 0) use(visible[0]);
          }}
        />
        <span
          className="shrink-0 text-xs tabular-nums text-cx-muted"
          aria-live="polite"
        >
          {t("scenarios.templateBrowser.countOf", {
            shown: visible.length,
            total: scenarioTemplates.length,
          })}
        </span>
      </div>
      <ul className="-mr-1 max-h-[60vh] space-y-2 overflow-y-auto pr-1">
        {visible.map((template) => (
          <li
            key={template.id}
            data-template-id={template.id}
            className="flex items-start gap-3 rounded-lg border border-cx-border p-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-cx-fg">
                  {text.name(template)}
                </span>
                <span className="rounded border border-cx-border px-1.5 py-px font-mono text-[11px] text-cx-muted">
                  {template.targetType}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-cx-muted">
                {text.description(template)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => use(template)}
              className="shrink-0 rounded-md border border-cx-border px-2.5 py-1 text-xs font-medium text-cx-fg2 hover:bg-cx-sub"
            >
              {t("scenarios.gallery.useTemplate")}
            </button>
          </li>
        ))}
        {visible.length === 0 && (
          <li className="py-6 text-center text-sm text-cx-muted">
            {t("scenarios.templateBrowser.noMatch", { query: query.trim() })}
          </li>
        )}
      </ul>
    </div>
  );
};

/**
 * Searchable list of every built-in scenario template. The gallery on the
 * Library tab only teases the first few; this is how the rest are reached.
 */
const TemplateBrowserDialog: React.FC<TemplateBrowserDialogProps> = ({
  open,
  onOpenChange,
  onUseTemplate,
}) => {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100vh-32px)] w-[min(720px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden border-cx-border-strong bg-cx-card p-0 text-cx-fg sm:rounded-xl">
        <div className="border-b border-cx-border py-3 pl-4 pr-12">
          <DialogTitle className="text-[15px] font-semibold tracking-normal">
            {t("scenarios.templateBrowser.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("scenarios.templateBrowser.description")}
          </DialogDescription>
        </div>
        {open && (
          <Body onOpenChange={onOpenChange} onUseTemplate={onUseTemplate} />
        )}
      </DialogContent>
    </Dialog>
  );
};

export default TemplateBrowserDialog;
