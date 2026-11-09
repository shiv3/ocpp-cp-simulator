import { useTranslation } from "react-i18next";
import { NumberField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";

export default function DelayForm({
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
      <NumberField
        label={t("scenarioEditor.delay.delaySeconds")}
        value={typeof value.delaySeconds === "number" ? value.delaySeconds : 0}
        onChange={(delaySeconds) =>
          onChange({ ...value, delaySeconds: delaySeconds ?? 0 })
        }
        min={0}
      />
      <div>
        <TextField
          label={t("scenarioEditor.delay.until")}
          value={(value.until as string | undefined) ?? ""}
          onChange={(until) => onChange({ ...value, until })}
          placeholder="2026-01-01T09:00:00Z"
        />
        <p className="text-xs text-muted mt-1">
          {t("scenarioEditor.delay.untilHelp")}
        </p>
        {typeof value.until === "string" &&
          value.until !== "" &&
          Number.isNaN(Date.parse(value.until)) && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {t("scenarioEditor.delay.untilInvalid")}
            </p>
          )}
      </div>
      <NumberField
        label={t("scenarioEditor.delay.jitterSeconds")}
        value={
          typeof value.jitterSeconds === "number" ? value.jitterSeconds : ""
        }
        onChange={(jitterSeconds) => onChange({ ...value, jitterSeconds })}
        placeholder="0"
        min={0}
        step="any"
      />
    </div>
  );
}
