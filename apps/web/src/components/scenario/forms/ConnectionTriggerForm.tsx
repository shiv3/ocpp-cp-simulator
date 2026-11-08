import { useTranslation } from "react-i18next";
import { NumberField, SelectField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";

export default function ConnectionTriggerForm({
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
        label={t("scenarioEditor.connectionTrigger.event")}
        value={(value.event as string | undefined) ?? "disconnected"}
        onChange={(event) => onChange({ ...value, event })}
        options={[
          {
            value: "disconnected",
            label: t("scenarioEditor.connectionTrigger.disconnected"),
          },
          {
            value: "connected",
            label: t("scenarioEditor.connectionTrigger.connected"),
          },
        ]}
      />
      <div>
        <NumberField
          label={t("scenarioEditor.form.timeoutSeconds")}
          value={typeof value.timeout === "number" ? value.timeout : 0}
          onChange={(timeout) => onChange({ ...value, timeout: timeout ?? 0 })}
          min={0}
        />
        <p className="text-xs text-muted mt-1">
          {t("scenarioEditor.connectionTrigger.timeoutHelp")}
        </p>
      </div>
    </div>
  );
}
