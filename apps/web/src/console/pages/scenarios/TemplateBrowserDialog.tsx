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
import { outlineScenario } from "../../lib/scenarioOutline";
import { stepSummary } from "../../lib/scenarioSteps";
import { nodeTitle } from "./run/stepVisuals";

import {
  scenarioTemplates,
  type ScenarioTemplate,
} from "@ocpp-cp-simulator/core/utils/scenarioTemplates";

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

/** The steps of a template, read-only, with loops and forks spelled out. */
const TemplateSteps: React.FC<{ template: ScenarioTemplate }> = ({
  template,
}) => {
  const { t } = useTranslation();
  const steps = outlineScenario(template.createScenario("preview", null));
  return (
    <ol
      aria-label={t("scenarios.templateBrowser.stepsLabel")}
      className="mt-2 space-y-1 border-t border-cx-border pt-2 text-xs"
    >
      {steps.map(({ number, node, jumps, endsHere }) => {
        const summary = stepSummary(node);
        const title = nodeTitle(node);
        const label = String(node.data.label ?? "").trim();
        return (
          <li key={node.id} className="flex gap-2">
            <span className="w-5 shrink-0 text-right tabular-nums text-cx-muted">
              {number}.
            </span>
            <span className="min-w-0 text-cx-fg2">
              <span className="font-medium text-cx-fg">{title}</span>
              {label !== "" && label !== title && ` · ${label}`}
              {summary !== "" && summary !== label && (
                <span className="text-cx-muted"> {summary}</span>
              )}
              {jumps.length > 0 && (
                <span className="text-cx-blue">
                  {" "}
                  {t("scenarios.templateBrowser.goesTo", {
                    steps: jumps.map((n) => `#${n}`).join(", "),
                  })}
                </span>
              )}
              {endsHere && (
                <span className="text-cx-muted">
                  {" "}
                  {t("scenarios.templateBrowser.thenEnd")}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
};

const Body: React.FC<Omit<TemplateBrowserDialogProps, "open">> = ({
  onOpenChange,
  onUseTemplate,
}) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const text = useTemplateText();
  const visible = filterTemplates(query, text);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

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
              <button
                type="button"
                aria-expanded={expanded.has(template.id)}
                onClick={() => toggle(template.id)}
                className="mt-1 text-xs text-cx-blue hover:underline"
              >
                {expanded.has(template.id)
                  ? t("scenarios.templateBrowser.hideSteps")
                  : t("scenarios.templateBrowser.showSteps")}
              </button>
              {expanded.has(template.id) && (
                <TemplateSteps template={template} />
              )}
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
