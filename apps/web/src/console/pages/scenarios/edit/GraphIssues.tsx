import { useTranslation } from "react-i18next";
import React from "react";

import { cn } from "@/lib/utils";
import type { Diagnostic } from "@ocpp-cp-simulator/core/scenario/diagnostic";
import type { IssueMarks } from "../../../lib/graphIssueMarks";
import { SEVERITY } from "./issueMarkUi";

/**
 * What the scenario's wiring would do wrong at run time (`validateScenarioGraph`:
 * a fork the executor only half-runs, a step nothing reaches, an edge to a
 * missing node), one line each. Advisory: nothing here blocks Save.
 *
 * A line about a step is a button: it selects that step (the inspector
 * opens) and scrolls it into view. Hovering or focusing a line highlights
 * what it marks in the view (`onHoverIssue`); a hovered marked step
 * highlights its lines (`hoveredStepId`).
 */
const GraphIssues: React.FC<{
  issues: readonly Diagnostic[];
  describe: (issue: Diagnostic) => string;
  marks: IssueMarks;
  hoveredStepId?: string | null;
  onHoverIssue?: (index: number | null) => void;
  onSelectStep?: (stepId: string) => void;
}> = ({
  issues,
  describe,
  marks,
  hoveredStepId,
  onHoverIssue,
  onSelectStep,
}) => {
  const { t } = useTranslation();
  if (issues.length === 0) return null;

  return (
    <div
      role="status"
      data-testid="graph-issues"
      className="mb-3 rounded-md border border-cx-amber/40 bg-cx-amber/10 px-1.5 py-1.5 text-sm text-cx-fg2"
    >
      <ul className="space-y-0.5">
        {issues.map((issue, i) => {
          const style = SEVERITY[issue.severity];
          const Icon = style.icon;
          const target = marks.targets[i];
          const stepId = target?.stepId ?? null;
          const lit =
            hoveredStepId != null &&
            (target?.nodeIds.includes(hoveredStepId) ?? false);
          const content = (
            <>
              <Icon
                aria-hidden
                className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", style.text)}
              />
              <span className="sr-only">
                {t(`scenarios.editor.severity.${issue.severity}`)}:{" "}
              </span>
              <span data-issue={issue.code}>{describe(issue)}</span>
            </>
          );
          const line = cn(
            "flex w-full items-start gap-2 rounded px-1.5 py-0.5 text-left",
            lit && style.tint,
          );
          return (
            <li key={i}>
              {stepId && onSelectStep ? (
                <button
                  type="button"
                  data-issue-line={i}
                  title={t("scenarios.editor.issueShowStep")}
                  onClick={() => onSelectStep(stepId)}
                  onMouseEnter={() => onHoverIssue?.(i)}
                  onMouseLeave={() => onHoverIssue?.(null)}
                  onFocus={() => onHoverIssue?.(i)}
                  onBlur={() => onHoverIssue?.(null)}
                  className={cn(
                    line,
                    "hover:bg-cx-amber/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cx-accent",
                  )}
                >
                  {content}
                </button>
              ) : (
                <div
                  data-issue-line={i}
                  onMouseEnter={() => onHoverIssue?.(i)}
                  onMouseLeave={() => onHoverIssue?.(null)}
                  className={line}
                >
                  {content}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default GraphIssues;
