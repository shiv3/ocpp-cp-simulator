import { useTranslation } from "react-i18next";
import type { JsonObject } from "@ocpp-cp-simulator/contracts/behavior";
import BehaviorParamsForm from "./BehaviorParamsForm";
import { useBehaviorParamsCatalog } from "./behaviorCatalog";
import { JsonTextareaField, SelectField, TextField } from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";

/** Schema 1.5 (#566): names a behavior loaded on the station. The run fails
 *  if no loaded behavior has that id. Schema 1.6 (#654): `mode` "disable"
 *  answers its CALLs with `accepted` for the run, and `params` are its knobs,
 *  rendered from the behavior's params schema. */
export default function UseBehaviorForm({
  value,
  onChange,
}: NodeFormComponentProps<NodeFormData>) {
  const { t } = useTranslation();
  const catalog = useBehaviorParamsCatalog();
  const behaviorId = (value.behaviorId as string | undefined) ?? "";
  const mode = value.mode === "disable" ? "disable" : "use";
  const params = value.params as JsonObject | undefined;
  const declared = catalog.get(behaviorId);

  return (
    <div className="space-y-3">
      <TextField
        label={t("scenarioEditor.form.label")}
        value={(value.label as string | undefined) ?? ""}
        onChange={(label) => onChange({ ...value, label })}
      />
      <TextField
        label={t("scenarioEditor.useBehavior.behaviorId")}
        value={behaviorId}
        onChange={(next) => onChange({ ...value, behaviorId: next })}
        placeholder={t("scenarioEditor.useBehavior.behaviorIdPlaceholder")}
      />
      <SelectField
        label={t("scenarioEditor.useBehavior.mode")}
        value={mode}
        onChange={(next) =>
          // Disabling takes no params: leaving "use" drops them.
          onChange({
            ...value,
            mode: next,
            ...(next === "disable" ? { params: undefined } : {}),
          })
        }
        options={[
          { value: "use", label: t("scenarioEditor.useBehavior.modeUse") },
          {
            value: "disable",
            label: t("scenarioEditor.useBehavior.modeDisable"),
          },
        ]}
      />
      {mode === "disable" ? (
        <p className="text-xs text-secondary">
          {t("scenarioEditor.useBehavior.disableHelp")}
        </p>
      ) : declared ? (
        <BehaviorParamsForm
          behaviorId={behaviorId}
          declared={declared}
          value={params}
          onChange={(next) => onChange({ ...value, params: next })}
        />
      ) : (
        <JsonTextareaField
          label={t("scenarioEditor.useBehavior.paramsJson")}
          value={params}
          optional
          onChange={(next) =>
            onChange({
              ...value,
              params: next === "" ? undefined : (next as JsonObject),
            })
          }
          placeholder={t("scenarioEditor.useBehavior.paramsJsonPlaceholder")}
        />
      )}
    </div>
  );
}
