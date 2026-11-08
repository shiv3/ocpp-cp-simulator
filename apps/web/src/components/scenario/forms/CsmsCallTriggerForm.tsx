import { useTranslation } from "react-i18next";
import {
  NumberField,
  JsonTextareaField,
  SelectField,
  TextField,
} from "./FormFields";
import { CallResponseSpecFields } from "./CallResponseForm";
import type { NodeFormComponentProps, NodeFormData } from "./types";
import { CSMS_CALL_TRIGGER_ACTIONS } from "@ocpp-cp-sim/core/cp/application/scenario/ScenarioTypes";

export default function CsmsCallTriggerForm({
  value,
  onChange,
}: NodeFormComponentProps<NodeFormData>) {
  const { t } = useTranslation();
  const actionOptions = CSMS_CALL_TRIGGER_ACTIONS.map((action) => ({
    value: action,
    label: action,
  }));

  return (
    <div className="space-y-3">
      <TextField
        label={t("scenarioEditor.form.label")}
        value={(value.label as string | undefined) ?? ""}
        onChange={(label) => onChange({ ...value, label })}
      />
      <SelectField
        label={t("scenarioEditor.form.action")}
        value={(value.action as string | undefined) ?? "Reset"}
        onChange={(action) => onChange({ ...value, action })}
        options={actionOptions}
      />
      <div>
        <SelectField
          label={t("scenarioEditor.csmsCallTrigger.behavior")}
          value={value.behavior === "replace" ? "replace" : "observe"}
          onChange={(behavior) =>
            onChange({
              ...value,
              behavior: behavior === "replace" ? "replace" : undefined,
            })
          }
          options={[
            {
              value: "observe",
              label: t("scenarioEditor.csmsCallTrigger.observe"),
            },
            {
              value: "replace",
              label: t("scenarioEditor.csmsCallTrigger.replace"),
            },
          ]}
        />
        <p className="text-xs text-muted mt-1">
          {t("scenarioEditor.csmsCallTrigger.replaceHelp")}
        </p>
      </div>
      <div>
        <NumberField
          label={t("scenarioEditor.form.timeoutSeconds")}
          value={typeof value.timeout === "number" ? value.timeout : 0}
          onChange={(timeout) => onChange({ ...value, timeout: timeout ?? 0 })}
          min={0}
        />
        <p className="text-xs text-muted mt-1">
          {t("scenarioEditor.csmsCallTrigger.timeoutHelp")}
        </p>
      </div>
      <div>
        <JsonTextareaField
          label={t("scenarioEditor.csmsCallTrigger.payloadCondition")}
          value={value.payload}
          onChange={(payload) => onChange({ ...value, payload })}
          placeholder='{"key": "HeartbeatInterval"}'
          optional
        />
        <p className="text-xs text-muted mt-1">
          {t("scenarioEditor.csmsCallTrigger.payloadHelp")}
        </p>
      </div>
      {value.behavior === "replace" && (
        <fieldset className="space-y-3 rounded border border-gray-300 dark:border-gray-600 p-3">
          <legend className="px-1 text-xs font-semibold text-primary">
            {t("scenarioEditor.csmsCallTrigger.onBusy")}
          </legend>
          <CallResponseSpecFields
            value={
              typeof value.onBusy === "object" &&
              value.onBusy !== null &&
              !Array.isArray(value.onBusy)
                ? (value.onBusy as NodeFormData)
                : {}
            }
            onChange={(onBusy) => onChange({ ...value, onBusy })}
          />
        </fieldset>
      )}
    </div>
  );
}
