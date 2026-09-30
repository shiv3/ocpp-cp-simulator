import { CheckboxField, JsonTextareaField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";

/** #389: an expert OCPP call — action, JSON payload and the per-call expert
 *  switches. The action must be a station-initiated CALL of the station's
 *  OCPP-J version; the run fails on a refused call. */
export default function OcppCallForm({
  value,
  onChange,
}: NodeFormComponentProps<NodeFormData>) {
  return (
    <div className="space-y-3">
      <TextField
        label="Label"
        value={(value.label as string | undefined) ?? ""}
        onChange={(label) => onChange({ ...value, label })}
      />
      <TextField
        label="Action"
        value={(value.action as string | undefined) ?? ""}
        onChange={(action) => onChange({ ...value, action })}
        placeholder="e.g., Heartbeat, StatusNotification, MeterValues"
      />
      <JsonTextareaField
        label="Payload (JSON)"
        value={value.payload}
        onChange={(payload) => onChange({ ...value, payload })}
        placeholder="{}"
      />
      <CheckboxField
        id="ocpp-call-skip-validation"
        label="Skip schema validation (send an invalid payload on purpose)"
        checked={value.skipValidation === true}
        onChange={(skipValidation) => onChange({ ...value, skipValidation })}
      />
      <CheckboxField
        id="ocpp-call-apply-response"
        label="Apply the answer to the station's state"
        checked={value.applyResponse === true}
        onChange={(applyResponse) => onChange({ ...value, applyResponse })}
      />
    </div>
  );
}
