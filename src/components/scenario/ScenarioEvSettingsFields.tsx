import React, { useState } from "react";

import { MIN_UI_POWER_FACTOR } from "../../cp/domain/connector/ChargingCurve";
import {
  EV_PRESETS,
  type EVSettings,
} from "../../cp/domain/connector/EVSettings";
import { cn } from "../../lib/utils";

export interface ScenarioEvSettingsFieldsProps {
  /** The scenario's EV settings; an empty field inherits. */
  value: Partial<EVSettings>;
  onChange: (next: Partial<EVSettings>) => void;
  /** The Default EV Settings from Settings, shown as placeholders. */
  defaultEvSettings: EVSettings | null;
  initiallyExpanded?: boolean;
  className?: string;
}

/**
 * A scenario's EV settings, applied to the target connector when the
 * scenario starts. Partial: an empty field keeps the connector's current
 * value. Shared by the classic graph editor's settings dialog and the web
 * console's scenario editor.
 */
const ScenarioEvSettingsFields: React.FC<ScenarioEvSettingsFieldsProps> = ({
  value,
  onChange,
  defaultEvSettings,
  initiallyExpanded = true,
  className,
}) => {
  const [expanded, setExpanded] = useState(initiallyExpanded);

  return (
    <div
      className={cn(
        "rounded border border-gray-200 dark:border-gray-700",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-2 py-1.5 text-xs font-semibold text-primary hover:bg-gray-50 dark:hover:bg-gray-800"
      >
        <span>🚗 Scenario EV Settings</span>
        <span className="text-gray-700 dark:text-gray-300">
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded ? (
        <div className="px-2 pb-2 space-y-2">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-300 mb-0.5">
              EV Model preset
            </label>
            <select
              aria-label="EV Model preset"
              className="input-base w-full text-xs"
              value={value.modelName ?? ""}
              onChange={(e) => {
                const preset = e.target.value;
                if (!preset) {
                  onChange({});
                  return;
                }
                if (preset === "Custom") {
                  onChange({
                    ...value,
                    modelName: "Custom",
                  });
                  return;
                }
                const presetValues = EV_PRESETS[preset] ?? {};
                onChange({
                  ...value,
                  modelName: preset,
                  ...presetValues,
                });
              }}
            >
              <option value="">
                (use default
                {defaultEvSettings ? `: ${defaultEvSettings.modelName}` : ""})
              </option>
              {Object.keys(EV_PRESETS).map((preset) => (
                <option key={preset} value={preset}>
                  {preset}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-300 mb-0.5">
                Battery (kWh)
              </label>
              <input
                aria-label="Battery (kWh)"
                type="number"
                className="input-base w-full text-xs"
                placeholder={
                  defaultEvSettings
                    ? String(defaultEvSettings.batteryCapacityKwh)
                    : "—"
                }
                value={value.batteryCapacityKwh ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  onChange({
                    ...value,
                    batteryCapacityKwh:
                      v === "" ? undefined : Math.max(1, parseFloat(v)),
                  });
                }}
                min={1}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-300 mb-0.5">
                Max Power (kW)
              </label>
              <input
                aria-label="Max Power (kW)"
                type="number"
                className="input-base w-full text-xs"
                placeholder={
                  defaultEvSettings
                    ? String(defaultEvSettings.maxChargingPowerKw)
                    : "—"
                }
                value={value.maxChargingPowerKw ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  onChange({
                    ...value,
                    maxChargingPowerKw:
                      v === "" ? undefined : Math.max(1, parseFloat(v)),
                  });
                }}
                min={1}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-300 mb-0.5">
                Initial SoC (%)
              </label>
              <input
                aria-label="Initial SoC (%)"
                type="number"
                className="input-base w-full text-xs"
                placeholder={
                  defaultEvSettings ? String(defaultEvSettings.initialSoc) : "—"
                }
                value={value.initialSoc ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  onChange({
                    ...value,
                    initialSoc:
                      v === ""
                        ? undefined
                        : Math.min(100, Math.max(0, parseInt(v, 10))),
                  });
                }}
                min={0}
                max={100}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-300 mb-0.5">
                Target SoC (%)
              </label>
              <input
                aria-label="Target SoC (%)"
                type="number"
                className="input-base w-full text-xs"
                placeholder={
                  defaultEvSettings ? String(defaultEvSettings.targetSoc) : "—"
                }
                value={value.targetSoc ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  onChange({
                    ...value,
                    targetSoc:
                      v === ""
                        ? undefined
                        : Math.min(100, Math.max(0, parseInt(v, 10))),
                  });
                }}
                min={0}
                max={100}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-300 mb-0.5">
                Current Type
              </label>
              <select
                aria-label="Current Type"
                className="input-base w-full text-xs"
                value={value.currentType ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  onChange({
                    ...value,
                    currentType: v === "" ? undefined : (v as "AC" | "DC"),
                    phases: v === "DC" ? undefined : value.phases,
                  });
                }}
              >
                <option value="">
                  (use default
                  {defaultEvSettings
                    ? `: ${defaultEvSettings.currentType ?? "AC"}`
                    : ""}
                  )
                </option>
                <option value="AC">AC</option>
                <option value="DC">DC</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-300 mb-0.5">
                Phases
              </label>
              <select
                aria-label="Phases"
                className="input-base w-full text-xs"
                value={value.phases !== undefined ? String(value.phases) : ""}
                disabled={value.currentType === "DC"}
                onChange={(e) => {
                  const v = e.target.value;
                  onChange({
                    ...value,
                    phases:
                      v === "" ? undefined : ((v === "3" ? 3 : 1) as 1 | 3),
                  });
                }}
              >
                <option value="">(use default)</option>
                <option value="1">1 (single-phase)</option>
                <option value="3">3 (three-phase)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-300 mb-0.5">
                Voltage (V)
              </label>
              <input
                aria-label="Voltage (V)"
                type="number"
                className="input-base w-full text-xs"
                placeholder={
                  defaultEvSettings?.voltageV
                    ? String(defaultEvSettings.voltageV)
                    : "230"
                }
                value={value.voltageV ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  onChange({
                    ...value,
                    voltageV: v === "" ? undefined : Math.max(1, parseFloat(v)),
                  });
                }}
                min={1}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-300 mb-0.5">
                Power Factor
              </label>
              <input
                aria-label="Power Factor"
                type="number"
                className="input-base w-full text-xs"
                placeholder={
                  defaultEvSettings?.powerFactor
                    ? String(defaultEvSettings.powerFactor)
                    : "1"
                }
                value={value.powerFactor ?? ""}
                disabled={value.currentType === "DC"}
                onChange={(e) => {
                  const v = e.target.value;
                  // Clamped to MIN_UI_POWER_FACTOR, never 0: a
                  // cos phi of 0 means no real power flows, so the
                  // derived current would be infinite (#301).
                  // Empty stays undefined — that is "inherit the
                  // default", not "zero".
                  const parsed = parseFloat(v);
                  onChange({
                    ...value,
                    powerFactor:
                      v === "" || !Number.isFinite(parsed)
                        ? undefined
                        : Math.min(1, Math.max(MIN_UI_POWER_FACTOR, parsed)),
                  });
                }}
                min={MIN_UI_POWER_FACTOR}
                max={1}
                step={0.01}
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-300 mb-0.5">
              Charging curve
            </label>
            <div className="space-y-1">
              {(value.chargingCurve ?? []).map((point, index) => (
                <div key={index} className="flex items-center gap-1">
                  <input
                    type="number"
                    className="input-base w-16 text-xs"
                    aria-label={`Charging curve point ${index + 1} SoC percent`}
                    value={point.socPercent}
                    min={0}
                    max={100}
                    onChange={(e) => {
                      const curve = [...(value.chargingCurve ?? [])];
                      curve[index] = {
                        ...curve[index]!,
                        socPercent: Math.min(
                          100,
                          Math.max(0, parseFloat(e.target.value) || 0),
                        ),
                      };
                      onChange({
                        ...value,
                        chargingCurve: curve,
                      });
                    }}
                  />
                  <span className="text-xs text-gray-700 dark:text-gray-300">
                    % →
                  </span>
                  <input
                    type="number"
                    className="input-base w-16 text-xs"
                    aria-label={`Charging curve point ${index + 1} power fraction`}
                    value={point.powerFraction}
                    min={0}
                    max={1}
                    step={0.01}
                    onChange={(e) => {
                      const curve = [...(value.chargingCurve ?? [])];
                      curve[index] = {
                        ...curve[index]!,
                        powerFraction: Math.min(
                          1,
                          Math.max(0, parseFloat(e.target.value) || 0),
                        ),
                      };
                      onChange({
                        ...value,
                        chargingCurve: curve,
                      });
                    }}
                  />
                  <span className="text-xs text-gray-700 dark:text-gray-300">
                    fraction
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove charging curve point ${index + 1}`}
                    className="text-xs text-gray-700 dark:text-gray-300 hover:text-red-600 px-1"
                    onClick={() => {
                      const curve = (value.chargingCurve ?? []).filter(
                        (_, i) => i !== index,
                      );
                      onChange({
                        ...value,
                        chargingCurve: curve.length > 0 ? curve : undefined,
                      });
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={() =>
                  onChange({
                    ...value,
                    chargingCurve: [
                      ...(value.chargingCurve ?? []),
                      { socPercent: 0, powerFraction: 1 },
                    ],
                  })
                }
              >
                + Add point
              </button>
            </div>
          </div>
          <p className="text-xs text-gray-700 dark:text-gray-300 leading-snug">
            Empty fields fall back to{" "}
            {defaultEvSettings ? (
              <>
                the <strong>Default EV Settings</strong> (
                {defaultEvSettings.modelName}) configured in Settings.
              </>
            ) : (
              <>the connector's current value (built-in default).</>
            )}{" "}
            The auto-meter "Stop mode" inside MeterValue nodes can derive its
            stop condition from these settings.
          </p>
        </div>
      ) : null}
    </div>
  );
};

export default ScenarioEvSettingsFields;
