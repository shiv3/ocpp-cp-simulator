import { useTranslation } from "react-i18next";
import React from "react";

import { cn } from "@/lib/utils";
import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { outlineScenario } from "../../../lib/scenarioOutline";
import { stepSummary } from "../../../lib/scenarioSteps";
import { nodeTitle } from "../run/stepVisuals";
import IssueBadge from "./IssueBadge";
import { useStepIssues, type ViewIssues } from "./issueMarkUi";

/**
 * The steps of a scenario neither editor view can draw (a second fork, a
 * step nothing leads to), as a list in running order with where each one
 * jumps to. A step can be selected and its settings edited; how the steps
 * connect is not editable here.
 */
const UnsupportedOutline: React.FC<{
  scenario: Pick<ScenarioDefinition, "nodes" | "edges">;
  selectedStepId: string | null;
  onSelectStep: (id: string) => void;
  /** The line above the list; the editor's (steps editable, wiring not) by
   *  default, `null` for none. */
  note?: string | null;
  /** The scenario's diagnostics, marked on the rows they are about. */
  issues?: ViewIssues;
}> = ({ scenario, selectedStepId, onSelectStep, note, issues }) => {
  const { t } = useTranslation();
  const steps = outlineScenario(scenario);
  const stepIssues = useStepIssues(issues);
  return (
    <div data-testid="outline-only">
      <p className="mb-2 text-xs text-cx-muted">
        {note === undefined ? t("scenarios.editor.outlineOnlyNote") : note}
      </p>
      <ol className="space-y-1.5">
        {steps.map(({ number, node, jumps, endsHere }) => {
          const marked = stepIssues(node.id);
          return (
            <li key={node.id} data-node-id={node.id}>
              <button
                type="button"
                aria-pressed={selectedStepId === node.id}
                onClick={() => onSelectStep(node.id)}
                {...marked.cardProps}
                className={cn(
                  "flex w-full items-baseline gap-2 rounded-[10px] border bg-cx-card px-3 py-2 text-left text-sm",
                  selectedStepId === node.id
                    ? "border-cx-accent"
                    : marked.style
                      ? marked.style.border
                      : "border-cx-border hover:border-cx-border-strong",
                  marked.highlighted && marked.style?.glow,
                )}
              >
                <span className="w-5 shrink-0 font-mono text-xs text-cx-muted">
                  {number}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-cx-fg">
                    {nodeTitle(node)}
                  </span>{" "}
                  <span className="text-xs text-cx-muted">
                    {stepSummary(node)}
                  </span>
                </span>
                {(jumps.length > 0 || endsHere) && (
                  <span className="shrink-0 font-mono text-xs text-cx-blue">
                    {[
                      ...jumps.map((n) => `#${n}`),
                      ...(endsHere ? ["end"] : []),
                    ].join(", ")}
                  </span>
                )}
                {marked.mark && (
                  <IssueBadge
                    mark={marked.mark}
                    className="shrink-0 self-center"
                  />
                )}
              </button>
              {marked.description}
            </li>
          );
        })}
      </ol>
    </div>
  );
};

export default UnsupportedOutline;
