import { NumberField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";

export default function DelayForm({
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
      <NumberField
        label="Delay (seconds)"
        value={typeof value.delaySeconds === "number" ? value.delaySeconds : 0}
        onChange={(delaySeconds) =>
          onChange({ ...value, delaySeconds: delaySeconds ?? 0 })
        }
        min={0}
      />
    </div>
  );
}
