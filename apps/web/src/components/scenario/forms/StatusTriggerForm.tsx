import { useTranslation } from "react-i18next";
import { OCPPStatus } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
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
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <TextField
        label={t("scenarioEditor.form.label")}
        value={(value.label as string | undefined) ?? ""}
        onChange={(label) => onChange({ ...value, label })}
      />
      <SelectField
        label={t("scenarioEditor.statusTrigger.targetStatus")}
        value={
          (value.targetStatus as string | undefined) ?? OCPPStatus.Charging
        }
        onChange={(targetStatus) => onChange({ ...value, targetStatus })}
        options={STATUS_OPTIONS}
      />
      <div>
        <NumberField
          label={t("scenarioEditor.form.timeoutSeconds")}
          value={typeof value.timeout === "number" ? value.timeout : 0}
          onChange={(timeout) => onChange({ ...value, timeout: timeout ?? 0 })}
          min={0}
        />
        <p className="text-xs text-muted mt-1">
          {t("scenarioEditor.statusTrigger.timeoutHelp")}
        </p>
      </div>
    </div>
  );
}
