import { useTranslation } from "react-i18next";
import React from "react";
import { AlertTriangle } from "lucide-react";

import type { GraphIssue } from "@ocpp-cp-simulator/core/scenario/scenarioConnectionRules";
import { validateScenarioGraph } from "@ocpp-cp-simulator/core/scenario/scenarioGraphValidator";
import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { outlineScenario } from "../../../lib/scenarioOutline";
import type { StepLayout } from "../../../lib/stepLayout";
import { stepIndexOf } from "../../../lib/stepLayout";
import { nodeTitle } from "../run/stepVisuals";

/**
 * What the scenario's wiring would do wrong at run time (`validateScenarioGraph`:
 * a fork the executor only half-runs, a step nothing reaches, an edge to a
 * missing node), one line each. Advisory: nothing here blocks Save.
 */
const GraphIssues: React.FC<{
  scenario: Pick<ScenarioDefinition, "nodes" | "edges">;
  layout: StepLayout | null;
}> = ({ scenario, layout }) => {
  const { t } = useTranslation();
  const issues = validateScenarioGraph(scenario);
  if (issues.length === 0) return null;

  const outline = layout?.supported ? null : outlineScenario(scenario);
  const describe = (issue: GraphIssue) => {
    const node = scenario.nodes.find((n) => n.id === issue.nodeId);
    const n =
      (layout?.supported && node ? stepIndexOf(layout, node.id) : null) ??
      outline?.find((step) => step.node.id === node?.id)?.number ??
      "";
    return t(`scenarios.editor.issue.${issue.code}`, {
      n,
      title: node ? nodeTitle(node) : "",
      handle: String(issue.data?.handle ?? ""),
    });
  };

  return (
    <div
      role="status"
      data-testid="graph-issues"
      className="mb-3 rounded-md border border-cx-amber/40 bg-cx-amber/10 px-3 py-2 text-sm text-cx-fg2"
    >
      <ul className="space-y-1">
        {issues.map((issue, i) => (
          <li key={i} className="flex items-start gap-2">
            <AlertTriangle
              aria-hidden
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cx-amber"
            />
            <span data-issue={issue.code}>{describe(issue)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default GraphIssues;
