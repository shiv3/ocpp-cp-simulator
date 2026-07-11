import { NumberField, SelectField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";
import { CSMS_CALL_TRIGGER_ACTIONS } from "../../../cp/application/scenario/ScenarioTypes";

export default function CsmsCallTriggerForm({
  value,
  onChange,
}: NodeFormComponentProps<NodeFormData>) {
  const actionOptions = CSMS_CALL_TRIGGER_ACTIONS.map((action) => ({
    value: action,
    label: action,
  }));

  return (
    <div className="space-y-3">
      <TextField
        label="Label"
        value={(value.label as string | undefined) ?? ""}
        onChange={(label) => onChange({ ...value, label })}
      />
      <SelectField
        label="Action"
        value={(value.action as string | undefined) ?? "Reset"}
        onChange={(action) => onChange({ ...value, action })}
        options={actionOptions}
      />
      <div>
        <NumberField
          label="Timeout (seconds)"
          value={typeof value.timeout === "number" ? value.timeout : 0}
          onChange={(timeout) => onChange({ ...value, timeout: timeout ?? 0 })}
          min={0}
        />
        <p className="text-xs text-muted mt-1">
          0 = No timeout (wait indefinitely for CSMS call)
        </p>
      </div>
    </div>
  );
}
