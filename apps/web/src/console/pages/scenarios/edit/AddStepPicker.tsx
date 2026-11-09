import { useTranslation } from "react-i18next";
import React, { useId, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";

import { NODE_FORM_REGISTRY } from "../../../../components/scenario/forms/nodeFormRegistry";
import { cn } from "@/lib/utils";
import { STEP_CATEGORIES, STEP_HELP } from "../../../lib/scenarioSteps";
import { tileForStructure, tileForType } from "../run/stepVisuals";
import type { MessageKey } from "../../../../i18n";
import {
  ScenarioNodeType,
  type AnyScenarioNodeType,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

/**
 * Structures are entries that are not a node type: picking one inserts a block
 * (a Repeat block, or a Switch / Choice branch block). Entries are listed only
 * when the host passes `onPickStructure`; the plain Switch and Choice step
 * entries are then replaced by the structure ones.
 */
export type StructureKind = "loop" | "switch" | "choice";

const STRUCTURE_ENTRIES: ReadonlyArray<{
  kind: StructureKind;
  /** The STEP_CATEGORIES label it is listed under. */
  category: string;
  titleKey: MessageKey;
  helpKey: MessageKey;
}> = [
  {
    kind: "loop",
    category: "Flow control",
    titleKey: "scenarios.addStep.structure.loop",
    helpKey: "scenarios.addStep.structure.loopHelp",
  },
  {
    kind: "switch",
    category: "Flow control",
    titleKey: "scenarios.addStep.structure.switch",
    helpKey: "scenarios.addStep.structure.switchHelp",
  },
  {
    kind: "choice",
    category: "Flow control",
    titleKey: "scenarios.addStep.structure.choice",
    helpKey: "scenarios.addStep.structure.choiceHelp",
  },
];

/** Ids of structure entries share the type ids' `active` state under this prefix. */
const STRUCTURE_PREFIX = "structure:";

export interface AddStepPickerProps {
  onPick: (type: AnyScenarioNodeType) => void;
  /** Wired by the host to offer structure entries (Repeat). Omit to hide them. */
  onPickStructure?: (kind: StructureKind) => void;
  /** A structure that cannot go to this slot: listed but disabled, with the
   *  (translated) reason as its title. */
  structureRefusals?: Partial<Record<StructureKind, string>>;
  onClose: () => void;
}

/** The type's icon in its category colour (same as the step cards'). */
const TypeTile: React.FC<{ type: string; size: "sm" | "md" }> = ({
  type,
  size,
}) => {
  const { icon: Icon, className } = type.startsWith(STRUCTURE_PREFIX)
    ? tileForStructure(type.slice(STRUCTURE_PREFIX.length))
    : tileForType(type);
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
const AddStepPicker: React.FC<AddStepPickerProps> = ({
  onPick,
  onPickStructure,
  structureRefusals,
  onClose,
}) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const helpId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (title: string, help: string) =>
      title.toLowerCase().includes(q) || help.toLowerCase().includes(q);
    return STEP_CATEGORIES.map((category) => ({
      label: category.label,
      labelKey: category.labelKey,
      entries: [
        ...category.types
          .filter(
            (type) =>
              !onPickStructure ||
              (type !== ScenarioNodeType.SWITCH &&
                type !== ScenarioNodeType.CHOICE),
          )
          .filter((type) =>
            matches(
              t(NODE_FORM_REGISTRY[type].title),
              t(STEP_HELP[type as keyof typeof STEP_HELP]),
            ),
          )
          .map((type) => ({
            id: type as string,
            type: type as AnyScenarioNodeType | null,
            structure: null as StructureKind | null,
            title: t(NODE_FORM_REGISTRY[type].title),
            help: t(STEP_HELP[type as keyof typeof STEP_HELP]),
          })),
        ...(onPickStructure ? STRUCTURE_ENTRIES : [])
          .filter(
            (e) =>
              e.category === category.label &&
              matches(t(e.titleKey), t(e.helpKey)),
          )
          .map((e) => ({
            id: STRUCTURE_PREFIX + e.kind,
            type: null as AnyScenarioNodeType | null,
            structure: e.kind as StructureKind | null,
            title: t(e.titleKey),
            help: t(e.helpKey),
          })),
      ],
    })).filter((category) => category.entries.length > 0);
  }, [query, t, onPickStructure]);

  const refusalOf = (kind: StructureKind | null) =>
    kind ? structureRefusals?.[kind] : undefined;

  const shownEntry = active
    ? sections.flatMap((s) => s.entries).find((e) => e.id === active)
    : undefined;

  const items = () =>
    Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>(
        "button[data-step-option]",
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
    const onItem = target.hasAttribute("data-step-option");
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
              {category.entries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  data-step-option=""
                  data-step-type={entry.type ?? undefined}
                  data-step-structure={entry.structure ?? undefined}
                  aria-describedby={
                    shownEntry
                      ? shownEntry.id === entry.id
                        ? helpId
                        : undefined
                      : undefined
                  }
                  disabled={refusalOf(entry.structure) !== undefined}
                  title={refusalOf(entry.structure)}
                  onClick={() =>
                    entry.type
                      ? onPick(entry.type)
                      : entry.structure && onPickStructure?.(entry.structure)
                  }
                  onMouseEnter={() => setActive(entry.id)}
                  onFocus={() => setActive(entry.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-cx-fg2 hover:bg-cx-sub focus-visible:bg-cx-sub disabled:cursor-not-allowed disabled:opacity-50",
                    shownEntry?.id === entry.id && "bg-cx-sub",
                  )}
                >
                  <TypeTile type={entry.id} size="sm" />
                  <span className="min-w-0 flex-1 truncate">{entry.title}</span>
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
          {shownEntry ? (
            <>
              <div className="mb-1.5 flex items-center gap-2 font-medium text-cx-fg">
                <TypeTile type={shownEntry.id} size="md" />
                <span>{shownEntry.title}</span>
              </div>
              <p className="text-xs leading-relaxed text-cx-muted">
                {shownEntry.help}
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
