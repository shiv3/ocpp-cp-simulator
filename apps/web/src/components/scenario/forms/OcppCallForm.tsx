import { useTranslation } from "react-i18next";
import { CheckboxField, JsonTextareaField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";

function isJsonObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** #389: an expert OCPP call — action, JSON payload and the per-call expert
 *  switches. The action must be a station-initiated CALL of the station's
 *  OCPP-J version; the run fails on a refused call. */
export default function OcppCallForm({
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
      <TextField
        label={t("scenarioEditor.form.action")}
        value={(value.action as string | undefined) ?? ""}
        onChange={(action) => onChange({ ...value, action })}
        placeholder={t("scenarioEditor.ocppCall.actionPlaceholder")}
      />
      <JsonTextareaField
        label={t("scenarioEditor.form.payloadJson")}
        value={value.payload}
        onChange={(payload) => onChange({ ...value, payload })}
        placeholder="{}"
      />
      {!isJsonObject(value.payload) && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {t("scenarioEditor.ocppCall.payloadNotObject")}
        </p>
      )}
      <CheckboxField
        id="ocpp-call-skip-validation"
        label={t("scenarioEditor.ocppCall.skipValidation")}
        checked={value.skipValidation === true}
        onChange={(skipValidation) => onChange({ ...value, skipValidation })}
      />
      <CheckboxField
        id="ocpp-call-apply-response"
        label={t("scenarioEditor.ocppCall.applyResponse")}
        checked={value.applyResponse === true}
        onChange={(applyResponse) => onChange({ ...value, applyResponse })}
      />
    </div>
  );
}
