import {
  NumberField,
  JsonTextareaField,
  SelectField,
  TextField,
} from "./FormFields";
import { CallResponseSpecFields } from "./CallResponseForm";
import type { NodeFormComponentProps, NodeFormData } from "./types";
import { CSMS_CALL_TRIGGER_ACTIONS } from "@ocpp-cp-sim/core/cp/application/scenario/ScenarioTypes";

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
        <SelectField
          label="Behavior"
          value={value.behavior === "replace" ? "replace" : "observe"}
          onChange={(behavior) =>
            onChange({
              ...value,
              behavior: behavior === "replace" ? "replace" : undefined,
            })
          }
          options={[
            { value: "observe", label: "observe (default)" },
            { value: "replace", label: "replace" },
          ]}
        />
        <p className="text-xs text-muted mt-1">
          replace means the scenario owns the CALL and a Call Response node must
          answer it.
        </p>
      </div>
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
      <div>
        <JsonTextareaField
          label="Payload condition (JSON, optional)"
          value={value.payload}
          onChange={(payload) => onChange({ ...value, payload })}
          placeholder='{"key": "HeartbeatInterval"}'
          optional
        />
        <p className="text-xs text-muted mt-1">
          Partial match against the incoming call payload. Empty = any payload.
        </p>
      </div>
      {value.behavior === "replace" && (
        <fieldset className="space-y-3 rounded border border-gray-300 dark:border-gray-600 p-3">
          <legend className="px-1 text-xs font-semibold text-primary">
            On busy (answer to a second CALL while the first is unanswered)
          </legend>
          <CallResponseSpecFields
            value={
              typeof value.onBusy === "object" &&
              value.onBusy !== null &&
              !Array.isArray(value.onBusy)
                ? (value.onBusy as NodeFormData)
                : {}
            }
            onChange={(onBusy) => onChange({ ...value, onBusy })}
          />
        </fieldset>
      )}
    </div>
  );
}
