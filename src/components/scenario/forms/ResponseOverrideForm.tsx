import { SelectField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";
import { RESPONSE_OVERRIDE_ACTIONS } from "../../../cp/application/scenario/ScenarioTypes";

const OVERRIDE_STATUSES = [
  "Rejected",
  "Accepted",
  "Faulted",
  "Occupied",
  "Unavailable",
  "NotSupported",
  "NotImplemented",
  "Failed",
  "VersionMismatch",
] as const;

export default function ResponseOverrideForm({
  value,
  onChange,
}: NodeFormComponentProps<NodeFormData>) {
  const actionOptions = RESPONSE_OVERRIDE_ACTIONS.map((action) => ({
    value: action,
    label: action,
  }));

  const statusOptions = OVERRIDE_STATUSES.map((status) => ({
    value: status,
    label: status,
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
        value={(value.action as string | undefined) ?? "RemoteStartTransaction"}
        onChange={(action) => onChange({ ...value, action })}
        options={actionOptions}
      />
      <SelectField
        label="Status"
        value={(value.status as string | undefined) ?? "Rejected"}
        onChange={(status) => onChange({ ...value, status })}
        options={statusOptions}
      />
    </div>
  );
}
