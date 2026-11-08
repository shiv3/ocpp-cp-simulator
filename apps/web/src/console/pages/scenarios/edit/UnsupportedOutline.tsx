import { useTranslation } from "react-i18next";
import React from "react";

import { cn } from "@/lib/utils";
import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { outlineScenario } from "../../../lib/scenarioOutline";
import { stepSummary } from "../../../lib/scenarioSteps";
import { nodeTitle } from "../run/stepVisuals";

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
}> = ({ scenario, selectedStepId, onSelectStep }) => {
  const { t } = useTranslation();
  const steps = outlineScenario(scenario);
  return (
    <div data-testid="outline-only">
      <p className="mb-2 text-xs text-cx-muted">
        {t("scenarios.editor.outlineOnlyNote")}
      </p>
      <ol className="space-y-1.5">
        {steps.map(({ number, node, jumps, endsHere }) => (
          <li key={node.id}>
            <button
              type="button"
              aria-pressed={selectedStepId === node.id}
              onClick={() => onSelectStep(node.id)}
              className={cn(
                "flex w-full items-baseline gap-2 rounded-[10px] border bg-cx-card px-3 py-2 text-left text-sm",
                selectedStepId === node.id
                  ? "border-cx-accent"
                  : "border-cx-border hover:border-cx-border-strong",
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
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
};

export default UnsupportedOutline;
