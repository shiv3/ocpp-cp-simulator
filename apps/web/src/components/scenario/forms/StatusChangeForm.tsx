import { useTranslation } from "react-i18next";
import { OCPPStatus } from "@ocpp-cp-sim/core/cp/domain/types/OcppTypes";
import { SelectField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";

export default function StatusChangeForm({
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
        label={t("scenarioEditor.form.status")}
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
