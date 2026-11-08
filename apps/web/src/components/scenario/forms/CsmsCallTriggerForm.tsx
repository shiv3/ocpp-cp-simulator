import {
  NumberField,
  JsonTextareaField,
  SelectField,
  TextField,
} from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";
import { CSMS_CALL_TRIGGER_ACTIONS } from "@ocpp-cp-sim/core/cp/application/scenario/ScenarioTypes";
import { useT } from "../../../i18n";

export default function CsmsCallTriggerForm({
  value,
  onChange,
}: NodeFormComponentProps<NodeFormData>) {
  const t = useT();
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
    </div>
  );
}
