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
  const autoIncrement = Boolean(value.autoIncrement);
  const stopMode = (value.stopMode as string | undefined) ?? "manual";
  const curvePointCount = Array.isArray(value.curvePoints)
    ? value.curvePoints.length
    : 0;

  return (
    <div className="space-y-3">
      <TextField
        label="Label"
        value={(value.label as string | undefined) ?? ""}
        onChange={(label) => onChange({ ...value, label })}
      />
      <NumberField
        label="Initial Value (Wh)"
        value={typeof value.value === "number" ? value.value : 0}
        onChange={(nextValue) => onChange({ ...value, value: nextValue ?? 0 })}
      />
      <CheckboxField
        id="sendMessage"
        label="Send MeterValue Message"
        checked={Boolean(value.sendMessage)}
        onChange={(sendMessage) => onChange({ ...value, sendMessage })}
      />
      <div className="border-t border-gray-200 dark:border-gray-700 pt-3">
        <div className="mb-2">
          <CheckboxField
            id="autoIncrement"
            label="Auto Increment"
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
                label="Stop Mode"
                value={stopMode}
                onChange={(nextStopMode) =>
                  onChange({ ...value, stopMode: nextStopMode })
                }
                options={[
                  {
                    value: "manual",
                    label: "Manual (use maxTime / maxValue below)",
                  },
                  {
                    value: "evSettings",
                    label: "EV Settings (delivered kWh from EV)",
                  },
                ]}
              />
              {stopMode === "evSettings" ? (
                <p className="mt-1 text-xs text-gray-700 dark:text-gray-300 leading-snug">
                  Stops when delivered kWh &gt;= capacity x (target - initial) /
                  100. Uses the scenario&apos;s EV settings (above) or the
                  connector&apos;s current EV state if the scenario doesn&apos;t
                  override.
                </p>
              ) : null}
            </div>

            {stopMode !== "evSettings" ? (
              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label="Increment Interval (s)"
                  value={toInputNumber(value.incrementInterval)}
                  onChange={(incrementInterval) =>
                    onChange({ ...value, incrementInterval })
                  }
                  placeholder="10"
                  min={1}
                />
                <NumberField
                  label="Increment Amount (Wh)"
                  value={toInputNumber(value.incrementAmount)}
                  onChange={(incrementAmount) =>
                    onChange({ ...value, incrementAmount })
                  }
                  placeholder="1000"
                  min={1}
                />
                <NumberField
                  label="Max Time (s, 0=inf)"
                  value={toInputNumber(value.maxTime)}
                  onChange={(maxTime) => onChange({ ...value, maxTime })}
                  placeholder="0"
                  min={0}
                />
                <NumberField
                  label="Max Value (Wh, 0=inf)"
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
                Configure Auto Increment Curve
              </button>
              <p className="text-xs text-muted mt-1">
                {curvePointCount > 0
                  ? `Configured with ${curvePointCount} curve points`
                  : "Optional: configure meter value auto-increment curve"}
              </p>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
