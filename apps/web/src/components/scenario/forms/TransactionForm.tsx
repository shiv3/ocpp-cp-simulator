import { SelectField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";

export default function TransactionForm({
  value,
  onChange,
}: NodeFormComponentProps<NodeFormData>) {
  const action = (value.action as string | undefined) ?? "start";

  return (
    <div className="space-y-3">
      <TextField
        label="Label"
        value={(value.label as string | undefined) ?? ""}
        onChange={(label) => onChange({ ...value, label })}
      />
      <SelectField
        label="Action"
        value={action}
        onChange={(nextAction) => onChange({ ...value, action: nextAction })}
        options={[
          { value: "start", label: "Start Transaction" },
          { value: "stop", label: "Stop Transaction" },
        ]}
      />
      {action === "start" ? (
        <TextField
          label="Tag ID"
          value={(value.tagId as string | undefined) ?? ""}
          onChange={(tagId) => onChange({ ...value, tagId })}
          placeholder="RFID123456"
        />
      ) : null}
    </div>
  );
}
