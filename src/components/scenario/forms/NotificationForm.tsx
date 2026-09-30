import { JsonTextareaField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";

export default function NotificationForm({
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
        label="Message Type"
        value={(value.messageType as string | undefined) ?? ""}
        onChange={(messageType) => onChange({ ...value, messageType })}
        placeholder="e.g., Heartbeat, DataTransfer"
      />
      <JsonTextareaField
        label="Payload (JSON)"
        value={value.payload}
        onChange={(payload) => onChange({ ...value, payload })}
        placeholder='{"key": "value"}'
      />
    </div>
  );
}
