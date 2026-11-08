import { SelectField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";
import { useT } from "../../../i18n";

export default function TransactionForm({
  value,
  onChange,
}: NodeFormComponentProps<NodeFormData>) {
  const t = useT();
  const action = (value.action as string | undefined) ?? "start";

  return (
    <div className="space-y-3">
      <TextField
        label={t("scenarioEditor.form.label")}
        value={(value.label as string | undefined) ?? ""}
        onChange={(label) => onChange({ ...value, label })}
      />
      <SelectField
        label={t("scenarioEditor.form.action")}
        value={action}
        onChange={(nextAction) => onChange({ ...value, action: nextAction })}
        options={[
          { value: "start", label: t("scenarioEditor.transaction.start") },
          { value: "stop", label: t("scenarioEditor.transaction.stop") },
        ]}
      />
      {action === "start" ? (
        <TextField
          label={t("scenarioEditor.transaction.tagId")}
          value={(value.tagId as string | undefined) ?? ""}
          onChange={(tagId) => onChange({ ...value, tagId })}
          placeholder="RFID123456"
        />
      ) : null}
    </div>
  );
}
