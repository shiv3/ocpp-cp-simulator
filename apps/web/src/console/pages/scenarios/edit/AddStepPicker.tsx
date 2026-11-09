import { useTranslation } from "react-i18next";
import React, { useId, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

import { NODE_FORM_REGISTRY } from "../../../../components/scenario/forms/nodeFormRegistry";
import { cn } from "@/lib/utils";
import { STEP_CATEGORIES, STEP_HELP } from "../../../lib/scenarioSteps";
import { tileForType } from "../run/stepVisuals";
import type { ScenarioNodeType } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

export interface AddStepPickerProps {
  onPick: (type: ScenarioNodeType) => void;
  onClose: () => void;
}

/** The type's icon in its category colour (same as the step cards'). */
const TypeTile: React.FC<{ type: ScenarioNodeType; size: "sm" | "md" }> = ({
  type,
  size,
}) => {
  const { icon: Icon, className } = tileForType(type);
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md",
        size === "sm" ? "h-6 w-6" : "h-8 w-8 rounded-lg",
        className,
      )}
    >
      <Icon
        strokeWidth={2}
        className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"}
      />
    </span>
  );
};

/**
 * Inline "add a step" panel (not a Radix Popover — none is installed in this
 * repo, and an inline expanding panel avoids portal/focus complications in
 * jsdom dom tests while behaving identically for the operator). Renders
 * `STEP_CATEGORIES` as labeled sections, filtered by a search box matching
 * each type's title and description. The type under the pointer or keyboard
 * focus (ArrowUp/ArrowDown move between types) is described in a pane on the
 * right; below a container width of 28rem the pane stacks under the list.
 */
const AddStepPicker: React.FC<AddStepPickerProps> = ({ onPick, onClose }) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<ScenarioNodeType | null>(null);
  const helpId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    return STEP_CATEGORIES.map((category) => ({
      label: category.label,
      labelKey: category.labelKey,
      types: category.types.filter(
        (type) =>
          t(NODE_FORM_REGISTRY[type].title).toLowerCase().includes(q) ||
          t(STEP_HELP[type as keyof typeof STEP_HELP])
            .toLowerCase()
            .includes(q),
      ),
    })).filter((category) => category.types.length > 0);
  }, [query, t]);

  const shown =
    active && sections.some((s) => s.types.includes(active)) ? active : null;

  const items = () =>
    Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>(
        "button[data-step-type]",
      ) ?? [],
    );

  const move = (from: HTMLElement | null, delta: number) => {
    const all = items();
    const at = from ? all.indexOf(from as HTMLButtonElement) : -1;
    const next =
      at < 0
        ? delta > 0
          ? all[0]
          : all[all.length - 1]
        : all[Math.max(0, Math.min(all.length - 1, at + delta))];
    next?.focus();
    next?.scrollIntoView?.({ block: "nearest" });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const target = e.target as HTMLElement;
    const onItem = target.hasAttribute("data-step-type");
    if (!onItem && target.tagName !== "INPUT") return;
    e.preventDefault();
    move(onItem ? target : null, e.key === "ArrowDown" ? 1 : -1);
  };

  return (
    <div
      className="@container rounded-[10px] border border-cx-border bg-cx-card shadow-[0_1px_2px_rgba(20,20,30,0.05)] dark:shadow-none p-2"
      onKeyDown={onKeyDown}
    >
      <div className="mb-2 flex items-center gap-2">
        <input
          autoFocus
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("scenarios.addStep.searchPlaceholder")}
          aria-label={t("scenarios.addStep.search")}
          className="flex-1 rounded-md border border-cx-border-strong bg-transparent px-2 py-1 text-sm"
        />
        <button
          type="button"
          aria-label={t("scenarios.addStep.close")}
          onClick={onClose}
          className="rounded p-1 text-cx-faint hover:bg-cx-sub"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex flex-col gap-2 @md:flex-row @md:gap-3">
        <div
          ref={listRef}
          role="group"
          aria-label={t("scenarios.addStep.listLabel")}
          className="max-h-64 min-w-0 flex-1 space-y-2 overflow-y-auto"
        >
          {sections.length === 0 && (
            <div className="px-1 py-2 text-xs text-cx-faint">
              {t("scenarios.addStep.noMatches")}
            </div>
          )}
          {sections.map((category) => (
            <div key={category.label}>
              <div className="px-1 text-xs font-semibold uppercase tracking-wide text-cx-faint">
                {t(category.labelKey)}
              </div>
              {category.types.map((type) => (
                <button
                  key={type}
                  type="button"
                  data-step-type={type}
                  aria-describedby={shown === type ? helpId : undefined}
                  onClick={() => onPick(type)}
                  onMouseEnter={() => setActive(type)}
                  onFocus={() => setActive(type)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-cx-fg2 hover:bg-cx-sub focus-visible:bg-cx-sub",
                    shown === type && "bg-cx-sub",
                  )}
                >
                  <TypeTile type={type} size="sm" />
                  <span className="min-w-0 flex-1 truncate">
                    {t(NODE_FORM_REGISTRY[type].title)}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
        <div
          id={helpId}
          data-testid="step-picker-help"
          className="max-h-64 shrink-0 overflow-y-auto rounded-md border border-cx-border bg-cx-sub/50 p-3 text-sm @md:w-60"
        >
          {shown ? (
            <>
              <div className="mb-1.5 flex items-center gap-2 font-medium text-cx-fg">
                <TypeTile type={shown} size="md" />
                <span>{t(NODE_FORM_REGISTRY[shown].title)}</span>
              </div>
              <p className="text-xs leading-relaxed text-cx-muted">
                {t(STEP_HELP[shown as keyof typeof STEP_HELP])}
              </p>
            </>
          ) : (
            <p className="text-xs leading-relaxed text-cx-faint">
              {t("scenarios.addStep.helpHint")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default AddStepPicker;
