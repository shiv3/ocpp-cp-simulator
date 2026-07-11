import { SelectField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";
import {
  RESPONSE_OVERRIDE_ACTIONS,
  RESPONSE_OVERRIDE_STATUSES,
} from "../../../cp/application/scenario/ScenarioTypes";

const DEFAULT_ACTION: (typeof RESPONSE_OVERRIDE_ACTIONS)[number] =
  "RemoteStartTransaction";

export default function ResponseOverrideForm({
  value,
  onChange,
}: NodeFormComponentProps<NodeFormData>) {
  const actionOptions = RESPONSE_OVERRIDE_ACTIONS.map((action) => ({
    value: action,
    label: action,
  }));

  const currentAction = (value.action as string | undefined) ?? DEFAULT_ACTION;
  const validStatuses =
    RESPONSE_OVERRIDE_STATUSES[
      currentAction as keyof typeof RESPONSE_OVERRIDE_STATUSES
    ] ?? RESPONSE_OVERRIDE_STATUSES[DEFAULT_ACTION];

  const statusOptions = validStatuses.map((status) => ({
    value: status,
    label: status,
  }));

  const handleActionChange = (action: string) => {
    const nextStatuses =
      RESPONSE_OVERRIDE_STATUSES[
        action as keyof typeof RESPONSE_OVERRIDE_STATUSES
      ] ?? RESPONSE_OVERRIDE_STATUSES[DEFAULT_ACTION];
    const currentStatus = value.status as string | undefined;
    const nextStatus =
      currentStatus && nextStatuses.includes(currentStatus)
        ? currentStatus
        : nextStatuses[0];
    onChange({ ...value, action, status: nextStatus });
  };

  return (
    <div className="space-y-3">
      <TextField
        label="Label"
        value={(value.label as string | undefined) ?? ""}
        onChange={(label) => onChange({ ...value, label })}
      />
      <SelectField
        label="Action"
        value={currentAction}
        onChange={handleActionChange}
        options={actionOptions}
      />
      <SelectField
        label="Status"
        value={(value.status as string | undefined) ?? validStatuses[0]}
        onChange={(status) => onChange({ ...value, status })}
        options={statusOptions}
      />
    </div>
  );
}
