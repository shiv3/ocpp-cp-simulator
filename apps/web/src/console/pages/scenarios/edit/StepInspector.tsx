import type { TFunction } from "@/i18n";
import { useTranslation } from "react-i18next";
import React, { Suspense, lazy, useState } from "react";

import {
  TextField,
  TextareaField,
} from "../../../../components/scenario/forms/FormFields";
import {
  NODE_FORM_REGISTRY,
  isScenarioNodeType,
} from "../../../../components/scenario/forms/nodeFormRegistry";
import type {
  LaneTarget,
  NodeFormContext,
  NodeFormData,
} from "../../../../components/scenario/forms/types";
import { collectStateKeys } from "../../../../components/scenario/forms/scenarioValue";
import { applySelectHandleEdit } from "../../../lib/selectHandleEdit";
import { deriveStepLayout, stepIndexOf } from "../../../lib/stepLayout";
import { nodeTitle } from "../run/stepVisuals";
import {
  applyCurveConfigToMeterNode,
  meterNodeToCurveConfig,
} from "../../../../components/scenario/meterValueNodeConfig";
import type { AutoMeterValueConfig } from "@ocpp-cp-simulator/core/cp/domain/connector/MeterValueCurve";
import {
  type ScenarioDefinition,
  type ScenarioNode,
  type ScenarioNodeData,
  ScenarioNodeType,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import EmptyState from "../../../components/EmptyState";

// Lazy + Suspense: a canvas-heavy component only needed when a MeterValue
// step's "Configure curve" action is used.
const MeterValueCurveModal = lazy(
  () => import("../../../../components/MeterValueCurveModal"),
);

export interface StepInspectorProps {
  /** The selected step node, or `null` when nothing is selected. */
  node: ScenarioNode | null;
  onChange: (data: ScenarioNodeData) => void;
  /** The scenario around the step: the forms then offer its setState keys
   *  and show where a switch's / choice's lanes lead. */
  scenario?: ScenarioDefinition;
  /** A change to more than the step's data (a switch case reordered moves
   *  its lane's edge too). Absent: such edits change the data alone. */
  onScenarioChange?: (next: ScenarioDefinition) => void;
}

/** What the step's form may know of the scenario around it. */
function formContext(
  t: TFunction,
  scenario: ScenarioDefinition | undefined,
  node: ScenarioNode,
  toNodeData: (form: NodeFormData) => ScenarioNodeData,
  onScenarioChange: StepInspectorProps["onScenarioChange"],
): NodeFormContext | undefined {
  if (!scenario) return undefined;
  const context: NodeFormContext = {
    stateKeys: collectStateKeys(scenario.nodes),
  };
  const prefix =
    node.type === ScenarioNodeType.SWITCH
      ? "case"
      : node.type === ScenarioNodeType.CHOICE
        ? "option"
        : null;
  if (prefix === null) return context;
  let layout: ReturnType<typeof deriveStepLayout> | null = null;
  context.laneTarget = (handle): LaneTarget | null => {
    // The executor follows the first edge on a handle.
    const edge = scenario.edges.find(
      (e) => e.source === node.id && e.sourceHandle === handle,
    );
    if (!edge) return null;
    const target = scenario.nodes.find((n) => n.id === edge.target);
    if (!target) return { kind: "step", text: edge.target };
    if (target.type === ScenarioNodeType.END) return { kind: "end" };
    layout ??= deriveStepLayout(scenario);
    const n = layout.supported ? stepIndexOf(layout, target.id) : null;
    const label = String(target.data.label ?? "").trim();
    const title = label === "" ? nodeTitle(target) : label;
    return {
      kind: "step",
      text: n === null ? title : t("scenarioEditor.lane.step", { n, title }),
    };
  };
  if (onScenarioChange) {
    context.onReindex = (next, mapping) =>
      onScenarioChange(
        applySelectHandleEdit(
          scenario,
          node.id,
          toNodeData(next),
          prefix,
          mapping,
        ),
      );
  }
  return context;
}

/**
 * The scenario editor's step inspector: renders the registry form
 * for whichever step is selected (Task 7 brief — `entry.Component` reused
 * verbatim), plus a common Label/Description section that
 * every step type gets regardless of whether its own form surfaces those
 * fields (several registry forms, e.g. ConfigSetForm/CancelReservationForm,
 * currently render no fields of their own beyond `NoExtraConfigForm`).
 */
const StepInspector: React.FC<StepInspectorProps> = ({
  node,
  onChange,
  scenario,
  onScenarioChange,
}) => {
  const { t } = useTranslation();
  const [isCurveModalOpen, setIsCurveModalOpen] = useState(false);

  if (!node) {
    return (
      <EmptyState
        title={t("scenarios.inspector.selectStep")}
        hint={t("scenarios.inspector.selectStepHint")}
      />
    );
  }

  if (!isScenarioNodeType(node.type)) {
    return (
      <EmptyState
        title={t("scenarios.inspector.unknownType")}
        hint={String(node.type ?? "")}
      />
    );
  }

  const entry = NODE_FORM_REGISTRY[node.type];
  const formValue = entry.nodeDataToForm(node.data);
  const Form = entry.Component;

  const handleFormChange = (next: NodeFormData) => {
    onChange(entry.formToNodeData(next));
  };

  const context = formContext(
    t,
    scenario,
    node,
    entry.formToNodeData,
    onScenarioChange,
  );

  const handleCurveSave = (config: AutoMeterValueConfig) => {
    handleFormChange(applyCurveConfigToMeterNode(formValue, config));
    setIsCurveModalOpen(false);
  };

  // Two columns once the inspector is wide enough (under the steps in the
  // side panel), one beside the steps on the page: a container query, since
  // the window width says nothing about where the inspector sits.
  return (
    <div data-testid="step-inspector" className="@container space-y-4">
      <h2 className="text-base font-semibold text-cx-fg">{t(entry.title)}</h2>

      <div className="grid grid-cols-1 gap-3 border-b border-cx-border pb-4 @lg:grid-cols-2">
        <TextField
          label={t("scenarios.inspector.label")}
          value={(formValue.label as string | undefined) ?? ""}
          onChange={(label) => handleFormChange({ ...formValue, label })}
        />
        <TextareaField
          label={t("scenarios.inspector.description")}
          value={(formValue.description as string | undefined) ?? ""}
          onChange={(description) =>
            handleFormChange({ ...formValue, description })
          }
          rows={2}
        />
      </div>

      {/* The registry forms stack their fields in one `space-y-3` div: lay
          that div out as the same grid, a textarea (JSON, payloads) across
          both columns. */}
      <div className="@lg:[&>div]:grid @lg:[&>div]:grid-cols-2 @lg:[&>div]:gap-3 @lg:[&>div>*]:my-0 @lg:[&>div>*:has(textarea)]:col-span-2">
        <Form
          value={formValue}
          onChange={handleFormChange}
          onOpenMeterCurve={() => setIsCurveModalOpen(true)}
          context={context}
        />
      </div>

      {isCurveModalOpen && (
        <Suspense fallback={null}>
          <MeterValueCurveModal
            isOpen={isCurveModalOpen}
            onClose={() => setIsCurveModalOpen(false)}
            initialConfig={meterNodeToCurveConfig(formValue)}
            onSave={handleCurveSave}
          />
        </Suspense>
      )}
    </div>
  );
};

export default StepInspector;
