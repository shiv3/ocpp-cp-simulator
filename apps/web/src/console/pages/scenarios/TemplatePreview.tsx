import { useTranslation } from "react-i18next";
import React, { useMemo, useState } from "react";

import { useTemplateText } from "@/i18n/templates";
import type { ScenarioTemplate } from "@ocpp-cp-simulator/core/utils/scenarioTemplates";
import { ScenarioNodeType } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import EmptyState from "../../components/EmptyState";
import SegmentedControl from "../../components/SegmentedControl";
import { deriveStepLayout, layoutSteps } from "../../lib/stepLayout";
import StepInspector from "./edit/StepInspector";
import UnsupportedOutline from "./edit/UnsupportedOutline";
import { useScenarioIssues } from "./edit/GraphIssues";
import StepsGraphView from "./run/StepsGraphView";
import StepsView from "./run/StepsView";

type PreviewView = "steps" | "graph";

/** The template's scenario, built once per template (never saved). */
function previewScenario(template: ScenarioTemplate) {
  return template.createScenario("preview", null);
}

const noop = () => {};

/**
 * One template as the scenario editor would show it, read-only: its name,
 * description and trigger, the Steps or Graph view of its steps, and the
 * inspector of the step picked there — the same forms as the editor's, but
 * disabled (a `<fieldset disabled>`), since a template is only edited as the
 * copy **Use template** makes. A shape the views cannot draw is listed as an
 * outline, as in the editor.
 */
const TemplatePreview: React.FC<{
  template: ScenarioTemplate;
  onUse: (template: ScenarioTemplate) => void;
  /** Narrow dialogs: back to the list (the list and the preview do not fit
   *  side by side). */
  onBack?: () => void;
}> = ({ template, onUse, onBack }) => {
  const { t } = useTranslation();
  const text = useTemplateText();
  const scenario = useMemo(() => previewScenario(template), [template]);
  const layout = useMemo(() => deriveStepLayout(scenario), [scenario]);
  const [view, setView] = useState<PreviewView>("graph");
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  // Read-only: no warning box, only the marks (a shipped template should
  // have none).
  const { marks } = useScenarioIssues(
    scenario,
    layout,
    layout.supported ? view : "outline",
  );
  const issues = useMemo(() => ({ marks }), [marks]);

  const selected =
    scenario.nodes.find(
      (n) =>
        n.id === selectedStepId &&
        n.type !== ScenarioNodeType.START &&
        n.type !== ScenarioNodeType.END,
    ) ?? null;
  const stepCount = layout.supported
    ? layoutSteps(layout).length
    : scenario.nodes.filter(
        (n) =>
          n.type !== ScenarioNodeType.START && n.type !== ScenarioNodeType.END,
      ).length;
  const branches = layout.fork?.branches.length ?? 0;
  const trigger = scenario.trigger;

  return (
    <section
      aria-label={t("scenarios.templateBrowser.previewLabel", {
        name: text.name(template),
      })}
      data-testid="template-preview"
      data-preview-template-id={template.id}
      className="flex min-h-0 flex-col"
    >
      <header className="flex flex-wrap items-start gap-3 border-b border-cx-border pb-3">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="text-sm text-cx-accent hover:underline md:hidden"
          >
            {t("scenarios.templateBrowser.backToList")}
          </button>
        )}
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-cx-fg">
              {text.name(template)}
            </h3>
            <span className="rounded border border-cx-border px-1.5 py-px font-mono text-[11px] text-cx-muted">
              {template.targetType}
            </span>
          </div>
          <p className="mt-1 text-sm text-cx-fg2">
            {text.description(template)}
          </p>
          <p className="mt-1.5 text-xs text-cx-muted">
            {[
              t("scenarios.count.step", { count: stepCount }),
              branches > 0
                ? t("scenarios.count.branch", { count: branches })
                : null,
              trigger?.type === "statusChange"
                ? `${t("scenarios.meta.triggerStatusChange")}${
                    trigger.conditions?.toStatus
                      ? ` → ${trigger.conditions.toStatus}`
                      : ""
                  }`
                : t("scenarios.meta.triggerManual"),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onUse(template)}
          className="shrink-0 rounded-md bg-cx-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-cx-primary-hover"
        >
          {t("scenarios.gallery.useTemplate")}
        </button>
      </header>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {layout.supported && (
          <SegmentedControl
            label={t("scenarios.editor.editorView")}
            value={view}
            onChange={setView}
            options={[
              { value: "graph", label: t("scenarios.editor.viewGraph") },
              { value: "steps", label: t("scenarios.editor.viewSteps") },
            ]}
          />
        )}
        <span className="text-xs text-cx-muted">
          {t("scenarios.templateBrowser.readOnlyNote")}
        </span>
      </div>

      {/* The editor's grid: views, then the inspector beside them when the
          preview is wide enough (a container query), else under them. */}
      <div className="@container mt-3">
        <div className="grid grid-cols-1 items-start gap-4 @[720px]:grid-cols-[minmax(0,1fr)_minmax(260px,340px)]">
          <div className="min-w-0">
            {!layout.supported ? (
              <UnsupportedOutline
                scenario={scenario}
                selectedStepId={selectedStepId}
                onSelectStep={setSelectedStepId}
                note={null}
                issues={issues}
              />
            ) : view === "graph" ? (
              <StepsGraphView
                layout={layout}
                selectedStepId={selectedStepId}
                onSelectStep={setSelectedStepId}
                issues={issues}
              />
            ) : (
              <StepsView
                layout={layout}
                selectedStepId={selectedStepId}
                onSelectStep={setSelectedStepId}
                issues={issues}
              />
            )}
          </div>
          <div
            data-testid="template-step-detail"
            className="min-w-0 rounded-[10px] border border-cx-border bg-cx-card p-4"
          >
            {selected ? (
              // The editor's forms, disabled as a whole.
              <fieldset disabled className="min-w-0 disabled:opacity-90">
                <StepInspector node={selected} onChange={noop} />
              </fieldset>
            ) : (
              <EmptyState
                title={t("scenarios.inspector.selectStep")}
                hint={t("scenarios.templateBrowser.selectStepHint")}
              />
            )}
          </div>
        </div>
      </div>
    </section>
  );
};

export default TemplatePreview;
