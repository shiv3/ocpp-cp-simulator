import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import { NumberField, SelectField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";

const STATUS_OPTIONS = [
  OCPPStatus.Available,
  OCPPStatus.Preparing,
  OCPPStatus.Charging,
  OCPPStatus.SuspendedEVSE,
  OCPPStatus.SuspendedEV,
  OCPPStatus.Finishing,
  OCPPStatus.Reserved,
  OCPPStatus.Unavailable,
  OCPPStatus.Faulted,
].map((status) => ({ value: status, label: status }));

export default function StatusTriggerForm({
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
        label="Target Status"
        value={
          (value.targetStatus as string | undefined) ?? OCPPStatus.Charging
        }
        onChange={(targetStatus) => onChange({ ...value, targetStatus })}
        options={STATUS_OPTIONS}
      />
      <div>
        <NumberField
          label="Timeout (seconds)"
          value={typeof value.timeout === "number" ? value.timeout : 0}
          onChange={(timeout) => onChange({ ...value, timeout: timeout ?? 0 })}
          min={0}
        />
        <p className="text-xs text-muted mt-1">
          0 = No timeout (wait indefinitely for status change)
        </p>
      </div>
    </div>
  );
}
