import { useTranslation } from "react-i18next";
import { TextField } from "./FormFields";
import { ScenarioValueField } from "./ScenarioValueField";
import type { NodeFormComponentProps, NodeFormData } from "./types";

export const STATE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Schema 1.6 (#654): stores a JSON value in the run's state, read back by
 *  `$from` `state.<key>`. */
export default function SetStateForm({
  value,
  onChange,
  context,
}: NodeFormComponentProps<NodeFormData>) {
  const { t } = useTranslation();
  const key = typeof value.key === "string" ? value.key : "";
  return (
    <div className="space-y-3">
      <TextField
        label={t("scenarioEditor.form.label")}
        value={(value.label as string | undefined) ?? ""}
        onChange={(label) => onChange({ ...value, label })}
      />
      <div>
        <TextField
          label={t("scenarioEditor.setState.key")}
          value={key}
          onChange={(next) => onChange({ ...value, key: next })}
          placeholder="attempts"
        />
        {!STATE_KEY_PATTERN.test(key) && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {t("scenarioEditor.setState.keyInvalid")}
          </p>
        )}
      </div>
      <div className="@lg:col-span-2">
        <ScenarioValueField
          testId="set-state-value"
          label={t("scenarioEditor.setState.value")}
          value={value.value}
          stateKeys={context?.stateKeys}
          onChange={(next) => onChange({ ...value, value: next })}
          help={t("scenarioEditor.setState.valueHelp")}
        />
      </div>
    </div>
  );
}
