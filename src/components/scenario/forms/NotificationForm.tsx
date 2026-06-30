import { TextareaField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";

function payloadText(payload: unknown): string {
  return typeof payload === "string"
    ? payload
    : JSON.stringify(payload || {}, null, 2);
}

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
      <TextareaField
        label="Payload (JSON)"
        value={payloadText(value.payload)}
        onChange={(payload) => {
          try {
            onChange({ ...value, payload: JSON.parse(payload) });
          } catch {
            onChange({ ...value, payload });
          }
        }}
        placeholder='{"key": "value"}'
      />
    </div>
  );
}
