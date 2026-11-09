import { useTranslation } from "react-i18next";
import React from "react";
import { AlertTriangle, Info, XCircle, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { DiagnosticSeverity } from "@ocpp-cp-simulator/core/scenario/diagnostic";
import {
  highlightedBy,
  type IssueMark,
  type IssueMarks,
} from "../../../lib/graphIssueMarks";

/** The editor's diagnostics as a view shows them. */
export interface ViewIssues {
  marks: IssueMarks;
  /** The warning line hovered or focused: its node / edge is highlighted. */
  highlight?: number | null;
  /** A marked step hovered or focused (null when it is left). */
  onHoverStep?: (nodeId: string | null) => void;
}

/** Severity looks. Full literal class strings: Tailwind only sees class
 *  names written out in source. */
export const SEVERITY: Record<
  DiagnosticSeverity,
  {
    icon: LucideIcon;
    text: string;
    /** A card's border (Graph view). */
    border: string;
    /** An inset ring (Steps view boxes, outline rows): a box shadow, so it
     *  stacks with a run-state ring and stays inside the selection outline. */
    inset: string;
    /** The extra ring while a warning line points at the card. */
    glow: string;
    /** A warning line's tint while its card is hovered. */
    tint: string;
    /** SVG stroke / fill. */
    color: string;
  }
> = {
  error: {
    icon: XCircle,
    text: "text-cx-rose",
    border: "border-cx-rose/70",
    inset:
      "shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--cx-rose)_65%,transparent)]",
    glow: "ring-4 ring-cx-rose/30",
    tint: "bg-cx-rose/15",
    color: "var(--cx-rose)",
  },
  warning: {
    icon: AlertTriangle,
    text: "text-cx-amber",
    border: "border-cx-amber/70",
    inset:
      "shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--cx-amber)_65%,transparent)]",
    glow: "ring-4 ring-cx-amber/30",
    tint: "bg-cx-amber/15",
    color: "var(--cx-amber)",
  },
  info: {
    icon: Info,
    text: "text-cx-blue",
    border: "border-cx-blue/50",
    inset:
      "shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--cx-blue)_45%,transparent)]",
    glow: "ring-4 ring-cx-blue/25",
    tint: "bg-cx-blue/10",
    color: "var(--cx-blue)",
  },
};

const ORDER: readonly DiagnosticSeverity[] = ["error", "warning", "info"];

/** "1 error, 2 warnings": the badge's accessible name. */
export function useMarkCounts(): (mark: IssueMark) => string {
  const { t } = useTranslation();
  return (mark) =>
    ORDER.map((severity) => {
      const count = mark.entries.filter((e) => e.severity === severity).length;
      return count > 0
        ? t(`scenarios.editor.marks.${severity}`, { count })
        : null;
    })
      .filter((s) => s !== null)
      .join(", ");
}

/** The messages of a mark, one per line (the tooltip and the card's
 *  accessible description). */
export function useMarkMessages(): (mark: IssueMark) => string {
  const { t } = useTranslation();
  return (mark) =>
    mark.entries
      .map((e) =>
        e.viaEdge
          ? t("scenarios.editor.marks.onEdge", { message: e.message })
          : e.message,
      )
      .join("\n");
}

/**
 * The severity badge of a marked step: the worst severity's icon and the
 * number of diagnostics, named by its counts, with the messages as its
 * tooltip.
 */
export const IssueBadge: React.FC<{
  mark: IssueMark;
  className?: string;
  style?: React.CSSProperties;
}> = ({ mark, className, style: placement }) => {
  const counts = useMarkCounts();
  const messages = useMarkMessages();
  const style = SEVERITY[mark.severity];
  const Icon = style.icon;
  return (
    <span
      role="img"
      data-issue-badge={mark.severity}
      aria-label={counts(mark)}
      title={messages(mark)}
      style={placement}
      className={cn(
        "inline-flex h-[18px] items-center gap-0.5 rounded-full border border-current/40 bg-cx-card px-1.5 text-[11px] font-semibold leading-none shadow-[0_1px_2px_rgba(20,20,30,0.08)]",
        style.text,
        className,
      )}
    >
      <Icon aria-hidden className="h-3 w-3" strokeWidth={2.25} />
      {mark.entries.length}
    </span>
  );
};

/**
 * A step's marks in a view: the badge (with an id for the card's
 * `aria-describedby`), its severity classes, whether a warning line points
 * at it, and the hover / focus handlers that point back at the lines.
 */
export function useStepIssues(issues: ViewIssues | undefined) {
  const messages = useMarkMessages();
  const counts = useMarkCounts();
  const baseId = React.useId();
  const highlight = highlightedBy(issues?.marks, issues?.highlight);
  return (stepId: string) => {
    const mark = issues?.marks.nodes.get(stepId) ?? null;
    const highlighted = highlight?.nodeIds.includes(stepId) ?? false;
    const onHoverStep = issues?.onHoverStep;
    const descriptionId = `${baseId}-${stepId}`;
    return {
      mark,
      highlighted,
      style: mark ? SEVERITY[mark.severity] : null,
      /** Spread on the card's focusable element. */
      cardProps:
        mark === null
          ? {}
          : {
              "data-issues": mark.entries.map((e) => e.code).join(" "),
              "aria-describedby": descriptionId,
              ...(onHoverStep
                ? {
                    onMouseEnter: () => onHoverStep(stepId),
                    onMouseLeave: () => onHoverStep(null),
                    onFocus: () => onHoverStep(stepId),
                    onBlur: () => onHoverStep(null),
                  }
                : {}),
            },
      /** The card's hidden description: the counts and the messages. */
      description:
        mark === null ? null : (
          <span id={descriptionId} className="sr-only">
            {`${counts(mark)}: ${messages(mark)}`}
          </span>
        ),
    };
  };
}
