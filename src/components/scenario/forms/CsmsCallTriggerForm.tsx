import {
  NumberField,
  SelectField,
  TextareaField,
  TextField,
} from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";
import { CSMS_CALL_TRIGGER_ACTIONS } from "../../../cp/application/scenario/ScenarioTypes";

function payloadText(payload: unknown): string {
  if (payload === undefined) return "";
  return typeof payload === "string"
    ? payload
    : JSON.stringify(payload || {}, null, 2);
}

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
      <div>
        <TextareaField
          label="Payload condition (JSON, optional)"
          value={payloadText(value.payload)}
          onChange={(payload) => {
            try {
              onChange({ ...value, payload: JSON.parse(payload) });
            } catch {
              onChange({ ...value, payload });
            }
          }}
          placeholder='{"key": "HeartbeatInterval"}'
        />
        <p className="text-xs text-muted mt-1">
          Partial match against the incoming call payload. Empty = any payload.
        </p>
      </div>
    </div>
  );
}
