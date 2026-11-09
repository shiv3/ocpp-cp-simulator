import { useTranslation } from "react-i18next";
import React from "react";
import { AlertTriangle, Info, XCircle, type LucideIcon } from "lucide-react";

import type {
  Diagnostic,
  DiagnosticSeverity,
} from "@ocpp-cp-simulator/core/scenario/diagnostic";
import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { validateScenarioGraph } from "@ocpp-cp-simulator/core/scenario/scenarioGraphValidator";
import {
  highlightedBy,
  issueMarks,
  type IssueMark,
  type IssueMarks,
} from "../../../lib/graphIssueMarks";
import { outlineScenario } from "../../../lib/scenarioOutline";
import type { BlockTree } from "../../../lib/blockTree";
import { isDrawableTree, stepNumbers } from "../../../lib/stepTree";
import { nodeTitle } from "../run/stepVisuals";

/*
 * The editor's diagnostics in the views: worked out once per change
 * (`useScenarioIssues`), described as the warning box's lines, and marked
 * on the steps (`useStepIssues`, `IssueBadge`) and the Graph view's edges.
 */

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

/**
 * A diagnostic's line: its message, naming the step by the number its box
 * shows (the outline's number for a scenario the views cannot draw) and its
 * title.
 */
export function useDescribeIssue(
  scenario: Pick<ScenarioDefinition, "nodes" | "edges">,
  tree: BlockTree | null,
): (issue: Diagnostic) => string {
  const { t } = useTranslation();
  return React.useMemo(() => {
    const drawable = tree !== null && isDrawableTree(tree);
    const numbers = drawable ? stepNumbers(tree) : null;
    const outline = drawable ? null : outlineScenario(scenario);
    return (issue: Diagnostic) => {
      const node = scenario.nodes.find((n) => n.id === issue.nodeId);
      const n =
        (node ? numbers?.get(node.id) : undefined) ??
        outline?.find((step) => step.node.id === node?.id)?.number ??
        "";
      return t(`scenarios.editor.issue.${issue.code}` as never, {
        n,
        title: node ? nodeTitle(node) : "",
        handle: String(issue.data?.handle ?? ""),
        problem: String(issue.data?.problem ?? ""),
      });
    };
  }, [scenario, tree, t]);
}

const NO_SCENARIO = { nodes: [], edges: [] };

/**
 * The scenario's wiring diagnostics (`validateScenarioGraph`), worked out
 * once per change, with their lines and their marks in the view shown: the
 * Graph view draws edges; the Steps view and the outline do not, so an edge's
 * diagnostic marks its source step there.
 */
export function useScenarioIssues(
  scenario: Pick<ScenarioDefinition, "nodes" | "edges"> | null,
  tree: BlockTree | null,
  view: "graph" | "steps" | "outline",
  /** The edges the Graph view draws (by id); null when it draws none. */
  graphEdges: ReadonlySet<string> | null = null,
): {
  issues: readonly Diagnostic[];
  describe: (issue: Diagnostic) => string;
  marks: IssueMarks;
} {
  const def = scenario ?? NO_SCENARIO;
  const issues = React.useMemo(
    () => (scenario ? validateScenarioGraph(scenario) : []),
    [scenario],
  );
  const describe = useDescribeIssue(def, tree);
  const marks = React.useMemo(
    () =>
      issueMarks(
        issues,
        def,
        view === "graph" && graphEdges ? graphEdges : new Set<string>(),
        describe,
      ),
    [issues, def, view, graphEdges, describe],
  );
  return { issues, describe, marks };
}
