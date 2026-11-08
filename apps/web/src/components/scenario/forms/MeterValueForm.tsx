import { useTranslation } from "react-i18next";
import {
  CheckboxField,
  NumberField,
  SelectField,
  TextField,
} from "./FormFields";
import type { NodeFormComponentProps, NodeFormData } from "./types";

function toInputNumber(value: unknown): number | "" {
  return typeof value === "number" ? value : "";
}

export default function MeterValueForm({
  value,
  onChange,
  onOpenMeterCurve,
}: NodeFormComponentProps<NodeFormData>) {
  const { t } = useTranslation();
  const autoIncrement = Boolean(value.autoIncrement);
  const stopMode = (value.stopMode as string | undefined) ?? "manual";
  const curvePointCount = Array.isArray(value.curvePoints)
    ? value.curvePoints.length
    : 0;

  return (
    <div className="space-y-3">
      <TextField
        label={t("scenarioEditor.form.label")}
        value={(value.label as string | undefined) ?? ""}
        onChange={(label) => onChange({ ...value, label })}
      />
      <NumberField
        label={t("scenarioEditor.meterValue.initialValue")}
        value={typeof value.value === "number" ? value.value : 0}
        onChange={(nextValue) => onChange({ ...value, value: nextValue ?? 0 })}
      />
      <CheckboxField
        id="sendMessage"
        label={t("scenarioEditor.meterValue.sendMessage")}
        checked={Boolean(value.sendMessage)}
        onChange={(sendMessage) => onChange({ ...value, sendMessage })}
      />
      <div className="border-t border-gray-200 dark:border-gray-700 pt-3">
        <div className="mb-2">
          <CheckboxField
            id="autoIncrement"
            label={t("scenarioEditor.meterValue.autoIncrement")}
            checked={autoIncrement}
            onChange={(nextAutoIncrement) =>
              onChange({ ...value, autoIncrement: nextAutoIncrement })
            }
          />
        </div>
        {autoIncrement ? (
          <div className="ml-6 space-y-3">
            <div>
              <SelectField
                label={t("scenarioEditor.meterValue.stopMode")}
                value={stopMode}
                onChange={(nextStopMode) =>
                  onChange({ ...value, stopMode: nextStopMode })
                }
                options={[
                  {
                    value: "manual",
                    label: t("scenarioEditor.meterValue.stopModeManual"),
                  },
                  {
                    value: "evSettings",
                    label: t("scenarioEditor.meterValue.stopModeEv"),
                  },
                ]}
              />
              {stopMode === "evSettings" ? (
                <p className="mt-1 text-xs text-gray-700 dark:text-gray-300 leading-snug">
                  {t("scenarioEditor.meterValue.evHelp")}
                </p>
              ) : null}
            </div>

            {stopMode !== "evSettings" ? (
              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label={t("scenarioEditor.meterValue.incrementInterval")}
                  value={toInputNumber(value.incrementInterval)}
                  onChange={(incrementInterval) =>
                    onChange({ ...value, incrementInterval })
                  }
                  placeholder="10"
                  min={1}
                />
                <NumberField
                  label={t("scenarioEditor.meterValue.incrementAmount")}
                  value={toInputNumber(value.incrementAmount)}
                  onChange={(incrementAmount) =>
                    onChange({ ...value, incrementAmount })
                  }
                  placeholder="1000"
                  min={1}
                />
                <NumberField
                  label={t("scenarioEditor.meterValue.maxTime")}
                  value={toInputNumber(value.maxTime)}
                  onChange={(maxTime) => onChange({ ...value, maxTime })}
                  placeholder="0"
                  min={0}
                />
                <NumberField
                  label={t("scenarioEditor.meterValue.maxValue")}
                  value={toInputNumber(value.maxValue)}
                  onChange={(maxValue) => onChange({ ...value, maxValue })}
                  placeholder="0"
                  min={0}
                />
              </div>
            ) : null}

            <div className="border-t border-gray-200 dark:border-gray-700 pt-2">
              <button
                onClick={onOpenMeterCurve}
                className="btn-primary text-sm w-full"
              >
                {t("scenarioEditor.meterValue.configureCurve")}
              </button>
              <p className="text-xs text-muted mt-1">
                {curvePointCount > 0
                  ? t("scenarioEditor.meterValue.curveConfigured", {
                      count: curvePointCount,
                    })
                  : t("scenarioEditor.meterValue.curveOptional")}
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
