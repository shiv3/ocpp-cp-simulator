import { NumberField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";
import { useT } from "../../../i18n";

export default function RemoteStopTriggerForm({
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
      <div>
        <NumberField
          label={t("scenarioEditor.form.timeoutSeconds")}
          value={typeof value.timeout === "number" ? value.timeout : 0}
          onChange={(timeout) => onChange({ ...value, timeout: timeout ?? 0 })}
          min={0}
        />
        <p className="text-xs text-muted mt-1">
          {t("scenarioEditor.remoteStop.timeoutHelp")}
        </p>
      </div>
    </div>
  );
}
