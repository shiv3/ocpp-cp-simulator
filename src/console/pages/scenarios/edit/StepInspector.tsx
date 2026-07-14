import React, { Suspense, lazy, useState } from "react";

import {
  TextField,
  TextareaField,
} from "../../../../components/scenario/forms/FormFields";
import {
  NODE_FORM_REGISTRY,
  isScenarioNodeType,
} from "../../../../components/scenario/forms/nodeFormRegistry";
import type { NodeFormData } from "../../../../components/scenario/forms/types";
import {
  applyCurveConfigToMeterNode,
  meterNodeToCurveConfig,
} from "../../../../components/scenario/meterValueNodeConfig";
import type { AutoMeterValueConfig } from "../../../../cp/domain/connector/MeterValueCurve";
import type {
  ScenarioNode,
  ScenarioNodeData,
} from "../../../../cp/application/scenario/ScenarioTypes";
import EmptyState from "../../../components/EmptyState";

// Lazy + Suspense, matching how the v2 ReactFlow editor
// (`src/components/scenario/ScenarioEditor.tsx`) loads this modal — it's a
// canvas-heavy component only needed when a MeterValue step's "Configure
// curve" action is used.
const MeterValueCurveModal = lazy(
  () => import("../../../../components/MeterValueCurveModal"),
);

export interface StepInspectorProps {
  /** The selected step node, or `null` when nothing is selected. */
  node: ScenarioNode | null;
  onChange: (data: ScenarioNodeData) => void;
}

/**
 * Right-hand panel of the linear scenario editor: renders the registry form
 * for whichever step is selected (Task 7 brief — `entry.Component` reused
 * verbatim outside ReactFlow), plus a common Label/Description section that
 * every step type gets regardless of whether its own form surfaces those
 * fields (several registry forms, e.g. ConfigSetForm/CancelReservationForm,
 * currently render no fields of their own beyond `NoExtraConfigForm`).
 */
const StepInspector: React.FC<StepInspectorProps> = ({ node, onChange }) => {
  const [isCurveModalOpen, setIsCurveModalOpen] = useState(false);

  if (!node) {
    return (
      <EmptyState
        title="Select a step"
        hint="Pick a step from the list on the left to edit its configuration."
      />
    );
  }

  if (!isScenarioNodeType(node.type)) {
    return (
      <EmptyState title="Unknown step type" hint={String(node.type ?? "")} />
    );
  }

  const entry = NODE_FORM_REGISTRY[node.type];
  const formValue = entry.nodeDataToForm(node.data);
  const Form = entry.Component;

  const handleFormChange = (next: NodeFormData) => {
    onChange(entry.formToNodeData(next));
  };

  const handleCurveSave = (config: AutoMeterValueConfig) => {
    handleFormChange(applyCurveConfigToMeterNode(formValue, config));
    setIsCurveModalOpen(false);
  };

  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
        {entry.title}
      </h2>

      <div className="space-y-3 border-b border-gray-100 pb-4 dark:border-gray-800">
        <TextField
          label="Label"
          value={(formValue.label as string | undefined) ?? ""}
          onChange={(label) => handleFormChange({ ...formValue, label })}
        />
        <TextareaField
          label="Description"
          value={(formValue.description as string | undefined) ?? ""}
          onChange={(description) =>
            handleFormChange({ ...formValue, description })
          }
          rows={2}
        />
      </div>

      <Form
        value={formValue}
        onChange={handleFormChange}
        onOpenMeterCurve={() => setIsCurveModalOpen(true)}
      />

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
