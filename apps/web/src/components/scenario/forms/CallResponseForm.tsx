import { useTranslation } from "react-i18next";
import {
  CheckboxField,
  JsonTextareaField,
  SelectField,
  TextField,
} from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";

const KIND_OPTIONS = [
  { value: "result", labelKey: "scenarioEditor.callResponse.kindResult" },
  { value: "error", labelKey: "scenarioEditor.callResponse.kindError" },
  { value: "none", labelKey: "scenarioEditor.callResponse.kindNone" },
] as const;

function isJsonObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The fields that describe how a CALL is answered: kind, payload for a
 *  result, errorCode and errorDescription for an error. Shared by the
 *  callResponse node and the `onBusy` group of a replacing csmsCallTrigger. */
export function CallResponseSpecFields({
  value,
  onChange,
}: {
  value: NodeFormData;
  onChange: (value: NodeFormData) => void;
}) {
  const { t } = useTranslation();
  const kind =
    value.kind === "error" || value.kind === "none" ? value.kind : "result";
  return (
    <div className="space-y-3">
      <SelectField
        label={t("scenarioEditor.callResponse.answer")}
        value={kind}
        onChange={(next) => onChange({ ...value, kind: next })}
        options={KIND_OPTIONS.map((o) => ({
          value: o.value,
          label: t(o.labelKey),
        }))}
      />
      {kind === "result" && (
        <div>
          <JsonTextareaField
            label={t("scenarioEditor.callResponse.payload")}
            value={value.payload}
            onChange={(payload) => onChange({ ...value, payload })}
            placeholder="{}"
          />
          {value.payload !== undefined && !isJsonObject(value.payload) && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {t("scenarioEditor.ocppCall.payloadNotObject")}
            </p>
          )}
          <p className="text-xs text-muted mt-1">
            {t("scenarioEditor.callResponse.fromHelp", {
              example: '{"$from": "call.payload.requestId"}',
            })}
          </p>
        </div>
      )}
      {kind === "error" && (
        <>
          <TextField
            label={t("scenarioEditor.callResponse.errorCode")}
            value={(value.errorCode as string | undefined) ?? ""}
            onChange={(errorCode) => onChange({ ...value, errorCode })}
            placeholder={t("scenarioEditor.callResponse.errorCodePlaceholder")}
          />
          <TextField
            label={t("scenarioEditor.callResponse.errorDescription")}
            value={(value.errorDescription as string | undefined) ?? ""}
            onChange={(errorDescription) =>
              onChange({ ...value, errorDescription })
            }
          />
        </>
      )}
    </div>
  );
}

/** Schema 1.5 (#566): answers the CALL the nearest replacing csmsCallTrigger
 *  of this branch took. */
export default function CallResponseForm({
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
      <CallResponseSpecFields value={value} onChange={onChange} />
      <CheckboxField
        id="call-response-skip-validation"
        label={t("scenarioEditor.ocppCall.skipValidation")}
        checked={value.skipValidation === true}
        onChange={(skipValidation) => onChange({ ...value, skipValidation })}
      />
    </div>
  );
}
