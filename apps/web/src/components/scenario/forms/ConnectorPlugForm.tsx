import { SelectField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";

export default function ConnectorPlugForm({
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
        label="Action"
        value={(value.action as string | undefined) ?? "plugin"}
        onChange={(action) => onChange({ ...value, action })}
        options={[
          { value: "plugin", label: "Plugin (Connect)" },
          { value: "plugout", label: "Plugout (Disconnect)" },
        ]}
      />
    </div>
  );
}
