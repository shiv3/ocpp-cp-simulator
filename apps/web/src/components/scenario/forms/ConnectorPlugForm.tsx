import { SelectField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";
import { useT } from "../../../i18n";

export default function ConnectorPlugForm({
  value,
  onChange,
}: NodeFormComponentProps<NodeFormData>) {
  const t = useT();
  return (
    <div className="space-y-3">
      <TextField
        label={t("scenarioEditor.form.label")}
        value={(value.label as string | undefined) ?? ""}
        onChange={(label) => onChange({ ...value, label })}
      />
      <SelectField
        label={t("scenarioEditor.form.action")}
        value={(value.action as string | undefined) ?? "plugin"}
        onChange={(action) => onChange({ ...value, action })}
        options={[
          { value: "plugin", label: t("scenarioEditor.connectorPlug.plugin") },
          {
            value: "plugout",
            label: t("scenarioEditor.connectorPlug.plugout"),
          },
        ]}
      />
    </div>
  );
}
