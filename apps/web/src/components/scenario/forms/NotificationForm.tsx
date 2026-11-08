import { JsonTextareaField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";
import { useT } from "../../../i18n";

export default function NotificationForm({
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
      <TextField
        label={t("scenarioEditor.notification.messageType")}
        value={(value.messageType as string | undefined) ?? ""}
        onChange={(messageType) => onChange({ ...value, messageType })}
        placeholder={t("scenarioEditor.notification.messageTypePlaceholder")}
      />
      <JsonTextareaField
        label={t("scenarioEditor.form.payloadJson")}
        value={value.payload}
        onChange={(payload) => onChange({ ...value, payload })}
        placeholder='{"key": "value"}'
      />
    </div>
  );
}
