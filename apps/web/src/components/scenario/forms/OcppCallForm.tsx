import { CheckboxField, JsonTextareaField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";

function isJsonObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
      {!isJsonObject(value.payload) && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          The payload must be a JSON object. It is kept as typed, and the run
          fails on this step until it is one.
        </p>
      )}
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
