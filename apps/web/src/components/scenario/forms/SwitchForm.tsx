import { useTranslation } from "react-i18next";
import { JsonValueField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";

/** Schema 1.6 (#654): goes on along `case-<n>` for the first case equal to
 *  the value, else along `default`. */
export default function SwitchForm({
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
      <JsonValueField
        label={t("scenarioEditor.switch.value")}
        value={value.value}
        onChange={(next) => onChange({ ...value, value: next })}
        placeholder='{"$from": "state.mode"}'
        help={t("scenarioEditor.switch.valueHelp", {
          example: '{"$from": "state.mode"}',
        })}
        rows={2}
      />
      <JsonValueField
        label={t("scenarioEditor.switch.cases")}
        value={value.cases}
        validate={(next) =>
          Array.isArray(next) ? null : "scenarioEditor.switch.casesNotArray"
        }
        onChange={(cases) => onChange({ ...value, cases })}
        placeholder='["a", 1, true]'
        help={t("scenarioEditor.switch.casesHelp")}
      />
    </div>
  );
}
