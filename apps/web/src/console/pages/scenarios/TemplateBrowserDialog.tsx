import { useTranslation } from "react-i18next";
import React, { useRef, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useTemplateText } from "@/i18n/templates";
import { cn } from "@/lib/utils";
import TemplatePreview from "./TemplatePreview";

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

const Body: React.FC<Omit<TemplateBrowserDialogProps, "open">> = ({
  onOpenChange,
  onUseTemplate,
}) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const text = useTemplateText();
  const visible = filterTemplates(query, text);
  const [pickedId, setPickedId] = useState<string | null>(null);
  /** Narrow dialogs show the list or the preview, not both. */
  const [previewOpen, setPreviewOpen] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  // The picked template while the search still lists it, else the first one.
  const selected =
    visible.find((template) => template.id === pickedId) ?? visible[0] ?? null;

  const use = (template: ScenarioTemplate) => {
    onOpenChange(false);
    onUseTemplate(template);
  };

  const pick = (template: ScenarioTemplate) => {
    setPickedId(template.id);
    setPreviewOpen(true);
  };

  /** Arrow keys in the search move the selection (and keep it in view). */
  const move = (delta: number) => {
    if (visible.length === 0) return;
    const at = selected ? visible.indexOf(selected) : -1;
    const next =
      visible[Math.max(0, Math.min(visible.length - 1, at + delta))]!;
    setPickedId(next.id);
    listRef.current
      ?.querySelector(`[data-template-id="${next.id}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
      <div
        className={cn(
          "flex min-h-0 flex-col gap-3 border-cx-border p-4 md:border-r",
          previewOpen && "hidden md:flex",
        )}
      >
        <div className="flex items-center gap-3">
          <Input
            autoFocus
            type="search"
            aria-label={t("scenarios.templateBrowser.searchLabel")}
            placeholder={t("scenarios.templateBrowser.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                move(e.key === "ArrowDown" ? 1 : -1);
                return;
              }
              if (e.key !== "Enter") return;
              e.preventDefault();
              if (selected) use(selected);
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
        <ul
          ref={listRef}
          aria-label={t("scenarios.templateBrowser.listLabel")}
          className="-mr-1 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1"
        >
          {visible.map((template) => {
            const isSelected = template.id === selected?.id;
            return (
              <li
                key={template.id}
                data-template-id={template.id}
                data-selected={isSelected || undefined}
                className={cn(
                  "flex items-start gap-2 rounded-lg border p-2.5",
                  isSelected
                    ? "border-cx-accent bg-cx-accent/5"
                    : "border-cx-border hover:border-cx-border-strong",
                )}
              >
                <button
                  type="button"
                  aria-current={isSelected || undefined}
                  aria-label={t("scenarios.templateBrowser.previewTemplate", {
                    name: text.name(template),
                  })}
                  onClick={() => pick(template)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-cx-fg">
                      {text.name(template)}
                    </span>
                    <span className="rounded border border-cx-border px-1.5 py-px font-mono text-[11px] text-cx-muted">
                      {template.targetType}
                    </span>
                  </span>
                  <span className="mt-1 line-clamp-2 block text-xs text-cx-muted">
                    {text.description(template)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => use(template)}
                  className="shrink-0 rounded-md border border-cx-border px-2 py-0.5 text-xs font-medium text-cx-fg2 hover:bg-cx-sub"
                >
                  {t("scenarios.gallery.useTemplate")}
                </button>
              </li>
            );
          })}
          {visible.length === 0 && (
            <li className="py-6 text-center text-sm text-cx-muted">
              {t("scenarios.templateBrowser.noMatch", { query: query.trim() })}
            </li>
          )}
        </ul>
      </div>
      <div
        className={cn(
          "min-h-0 overflow-y-auto p-4",
          !previewOpen && "hidden md:block",
        )}
      >
        {selected ? (
          <TemplatePreview
            key={selected.id}
            template={selected}
            onUse={use}
            onBack={() => setPreviewOpen(false)}
          />
        ) : (
          <p className="py-6 text-center text-sm text-cx-muted">
            {t("scenarios.templateBrowser.nothingToPreview")}
          </p>
        )}
      </div>
    </div>
  );
};

/**
 * Every built-in scenario template, split in two: on the left a searchable
 * list (Arrow keys in the search move the selection, Enter uses it), on the
 * right the selected template as the editor would show it, read-only
 * (`TemplatePreview`). The gallery on the Library tab only teases the first
 * few; this is how the rest are reached. Narrow dialogs show one side at a
 * time.
 */
const TemplateBrowserDialog: React.FC<TemplateBrowserDialogProps> = ({
  open,
  onOpenChange,
  onUseTemplate,
}) => {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(880px,calc(100vh-32px))] w-[min(1280px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden border-cx-border-strong bg-cx-card p-0 text-cx-fg sm:rounded-xl">
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
