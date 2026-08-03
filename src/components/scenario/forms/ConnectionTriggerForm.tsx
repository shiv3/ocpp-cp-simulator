import { NumberField, SelectField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";

export default function ConnectionTriggerForm({
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
      <SelectField
        label="Event"
        value={(value.event as string | undefined) ?? "disconnected"}
        onChange={(event) => onChange({ ...value, event })}
        options={[
          { value: "disconnected", label: "Disconnected" },
          { value: "connected", label: "Connected" },
        ]}
      />
      <div>
        <NumberField
          label="Timeout (seconds)"
          value={typeof value.timeout === "number" ? value.timeout : 0}
          onChange={(timeout) => onChange({ ...value, timeout: timeout ?? 0 })}
          min={0}
        />
        <p className="text-xs text-muted mt-1">
          0 = No timeout. Resolves immediately if the charge point is already in
          the selected state.
        </p>
      </div>
    </div>
  );
}
