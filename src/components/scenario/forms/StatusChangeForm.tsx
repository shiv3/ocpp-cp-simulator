import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import { SelectField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";

export default function StatusChangeForm({
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
        label="Status"
        value={(value.status as string | undefined) ?? OCPPStatus.Available}
        onChange={(status) => onChange({ ...value, status })}
        options={Object.values(OCPPStatus).map((status) => ({
          value: status,
          label: status,
        }))}
      />
    </div>
  );
}
