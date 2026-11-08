import { NumberField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";
import { useT } from "../../../i18n";

export default function DelayForm({
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
      <NumberField
        label={t("scenarioEditor.delay.delaySeconds")}
        value={typeof value.delaySeconds === "number" ? value.delaySeconds : 0}
        onChange={(delaySeconds) =>
          onChange({ ...value, delaySeconds: delaySeconds ?? 0 })
        }
        min={0}
      />
    </div>
  );
}
