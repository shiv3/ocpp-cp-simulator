import { SelectField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";
import {
  INBOUND_POLICY_ACTIONS,
  INBOUND_POLICY_ERROR_CODES,
} from "../../../cp/application/scenario/ScenarioTypes";

const DEFAULT_ACTION: (typeof INBOUND_POLICY_ACTIONS)[number] = "Reset";
const DEFAULT_POLICY = "callerror";
const DEFAULT_ERROR_CODE: (typeof INBOUND_POLICY_ERROR_CODES)[number] =
  "NotImplemented";

export default function InboundPolicyForm({
  value,
  onChange,
}: NodeFormComponentProps<NodeFormData>) {
  const actionOptions = INBOUND_POLICY_ACTIONS.map((action) => ({
    value: action,
    label: action,
  }));

  const policyOptions = [
    { value: "answer", label: "Clear (Resume Normal)" },
    { value: "callerror", label: "Reject with CallError" },
    { value: "ignore", label: "Ignore (No Response)" },
  ];

  const errorCodeOptions = INBOUND_POLICY_ERROR_CODES.map((code) => ({
    value: code,
    label: code,
  }));

  const currentAction = (value.action as string | undefined) ?? DEFAULT_ACTION;
  const currentPolicy = (value.policy as string | undefined) ?? DEFAULT_POLICY;
  const currentErrorCode =
    (value.errorCode as string | undefined) ?? DEFAULT_ERROR_CODE;

  const handleActionChange = (action: string) => {
    onChange({ ...value, action });
  };

  const handlePolicyChange = (policy: string) => {
    const updated = { ...value, policy };
    // Auto-set errorCode when switching to callerror
    if (policy === "callerror" && !value.errorCode) {
      updated.errorCode = DEFAULT_ERROR_CODE;
    }
    onChange(updated);
  };

  const handleErrorCodeChange = (errorCode: string) => {
    onChange({ ...value, errorCode });
  };

  const handleErrorDescriptionChange = (errorDescription: string) => {
    onChange({ ...value, errorDescription });
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
        label="Policy"
        value={currentPolicy}
        onChange={handlePolicyChange}
        options={policyOptions}
      />
      {currentPolicy === "callerror" && (
        <>
          <SelectField
            label="Error Code"
            value={currentErrorCode}
            onChange={handleErrorCodeChange}
            options={errorCodeOptions}
          />
          <TextField
            label="Error Description (optional)"
            value={(value.errorDescription as string | undefined) ?? ""}
            onChange={handleErrorDescriptionChange}
          />
        </>
      )}
    </div>
  );
}
