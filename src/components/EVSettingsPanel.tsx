import React, { useCallback, useState } from "react";
import { Label, Select, TextInput } from "flowbite-react";
import {
  type EVSettings,
  EV_PRESETS,
  defaultEVSettings,
} from "../cp/domain/connector/EVSettings";
import { BatteryVisualization } from "./BatteryVisualization";

interface EVSettingsPanelProps {
  settings: EVSettings;
  currentSoc: number | null;
  meterValue: number;
  isCharging: boolean;
  onChange: (settings: EVSettings) => void;
}

export const EVSettingsPanel: React.FC<EVSettingsPanelProps> = ({
  settings,
  currentSoc,
  meterValue,
  isCharging,
  onChange,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);

  const handlePresetChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const preset = e.target.value;
      if (preset === "Custom") {
        onChange({ ...settings, modelName: "Custom" });
      } else {
        const presetValues = EV_PRESETS[preset];
        onChange({
          ...settings,
          modelName: preset,
          ...presetValues,
        });
      }
    },
    [settings, onChange],
  );

  const handleFieldChange = useCallback(
    (field: keyof EVSettings, value: string | number) => {
      onChange({
        ...settings,
        [field]: value,
        modelName:
          settings.modelName === "Custom" ? "Custom" : settings.modelName,
      });
    },
    [settings, onChange],
  );

  const displaySoc = currentSoc ?? settings.initialSoc;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
      {/* Header */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors rounded-t-lg"
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">EV</span>
          <span className="font-medium text-gray-900 dark:text-white">
            EV Settings
          </span>
        </div>
        <svg
          className={`w-5 h-5 text-gray-500 transition-transform ${isExpanded ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {isExpanded && (
        <div className="p-3 pt-0 space-y-4">
          {/* Battery Visualization */}
          <div className="pt-2">
            <BatteryVisualization
              currentSoc={displaySoc}
              targetSoc={settings.targetSoc}
              batteryCapacityKwh={settings.batteryCapacityKwh}
              currentEnergyWh={meterValue}
              chargingPowerKw={
                isCharging ? settings.maxChargingPowerKw : undefined
              }
              isCharging={isCharging}
            />
          </div>

          {/* EV Model Preset */}
          <div>
            <Label
              htmlFor="ev-model"
              value="EV Model"
              className="text-xs text-gray-500 dark:text-gray-400"
            />
            <Select
              id="ev-model"
              sizing="sm"
              value={settings.modelName}
              onChange={handlePresetChange}
            >
              {Object.keys(EV_PRESETS).map((preset) => (
                <option key={preset} value={preset}>
                  {preset}
                </option>
              ))}
            </Select>
          </div>

          {/* Battery Capacity & Max Power */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label
                htmlFor="battery-capacity"
                value="Battery (kWh)"
                className="text-xs text-gray-500 dark:text-gray-400"
              />
              <TextInput
                id="battery-capacity"
                type="number"
                sizing="sm"
                value={settings.batteryCapacityKwh}
                onChange={(e) =>
                  handleFieldChange(
                    "batteryCapacityKwh",
                    parseFloat(e.target.value) ||
                      defaultEVSettings.batteryCapacityKwh,
                  )
                }
                min={1}
                max={500}
              />
            </div>
            <div>
              <Label
                htmlFor="max-power"
                value="Max Power (kW)"
                className="text-xs text-gray-500 dark:text-gray-400"
              />
              <TextInput
                id="max-power"
                type="number"
                sizing="sm"
                value={settings.maxChargingPowerKw}
                onChange={(e) =>
                  handleFieldChange(
                    "maxChargingPowerKw",
                    parseFloat(e.target.value) ||
                      defaultEVSettings.maxChargingPowerKw,
                  )
                }
                min={1}
                max={500}
              />
            </div>
          </div>

          {/* Initial SoC & Target SoC */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label
                htmlFor="initial-soc"
                value="Initial SoC (%)"
                className="text-xs text-gray-500 dark:text-gray-400"
              />
              <TextInput
                id="initial-soc"
                type="number"
                sizing="sm"
                value={settings.initialSoc}
                onChange={(e) =>
                  handleFieldChange(
                    "initialSoc",
                    Math.min(100, Math.max(0, parseInt(e.target.value) || 0)),
                  )
                }
                min={0}
                max={100}
              />
            </div>
            <div>
              <Label
                htmlFor="target-soc"
                value="Target SoC (%)"
                className="text-xs text-gray-500 dark:text-gray-400"
              />
              <TextInput
                id="target-soc"
                type="number"
                sizing="sm"
                value={settings.targetSoc}
                onChange={(e) =>
                  handleFieldChange(
                    "targetSoc",
                    Math.min(100, Math.max(0, parseInt(e.target.value) || 80)),
                  )
                }
                min={0}
                max={100}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EVSettingsPanel;
