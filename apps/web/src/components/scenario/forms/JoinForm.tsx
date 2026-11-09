import { useTranslation } from "react-i18next";
import { SelectField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";

/** Schema 1.9: `all` (the default) goes on once every branch of the parallel
 *  arrived or ended; `any` at the first arrival, cancelling the others. */
export default function JoinForm({
  value,
  onChange,
}: NodeFormComponentProps<NodeFormData>) {
  const { t } = useTranslation();
  return (
    <SelectField
      label={t("scenarioEditor.join.mode")}
      value={value.mode === "any" ? "any" : "all"}
      onChange={(mode) => onChange({ ...value, mode })}
      options={[
        { value: "all", label: t("scenarioEditor.join.modeAll") },
        { value: "any", label: t("scenarioEditor.join.modeAny") },
      ]}
    />
  );
}
