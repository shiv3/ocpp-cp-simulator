import React from "react";
import { calculateChargingTimeMinutes } from "../cp/domain/connector/EVSettings";

interface BatteryVisualizationProps {
  currentSoc: number;
  targetSoc: number;
  batteryCapacityKwh: number;
  currentEnergyWh: number;
  chargingPowerKw?: number;
  isCharging: boolean;
}

function formatTime(minutes: number): string {
  if (minutes <= 0) return "-";
  const hours = Math.floor(minutes / 60);
  const mins = Math.ceil(minutes % 60);
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
}

function getSocColor(soc: number): string {
  if (soc < 20) return "bg-red-500";
  if (soc < 50) return "bg-yellow-500";
  return "bg-green-500";
}

export const BatteryVisualization: React.FC<BatteryVisualizationProps> = ({
  currentSoc,
  targetSoc,
  batteryCapacityKwh,
  currentEnergyWh,
  chargingPowerKw,
  isCharging,
}) => {
  const currentKwh = currentEnergyWh / 1000;
  const estimatedMinutes =
    isCharging && chargingPowerKw && chargingPowerKw > 0
      ? calculateChargingTimeMinutes(
          currentSoc,
          targetSoc,
          batteryCapacityKwh,
          chargingPowerKw,
        )
      : null;

  return (
    <div className="space-y-3">
      {/* Battery Bar */}
      <div className="relative">
        <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded-lg overflow-hidden border-2 border-gray-300 dark:border-gray-600">
          {/* Current SoC fill */}
          <div
            className={`absolute inset-y-0 left-0 ${getSocColor(currentSoc)} transition-all duration-500`}
            style={{ width: `${Math.min(100, Math.max(0, currentSoc))}%` }}
          />
          {/* Target SoC marker */}
          {targetSoc < 100 && (
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-blue-600 dark:bg-blue-400"
              style={{ left: `${targetSoc}%` }}
              title={`Target: ${targetSoc}%`}
            />
          )}
          {/* Percentage text */}
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-sm font-bold text-gray-900 dark:text-white drop-shadow-sm">
              {currentSoc.toFixed(1)}%
            </span>
          </div>
        </div>
        {/* Battery terminal */}
        <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1 w-1.5 h-4 bg-gray-400 dark:bg-gray-500 rounded-r" />
      </div>

      {/* Details Grid */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="flex justify-between">
          <span className="text-gray-500 dark:text-gray-400">Current:</span>
          <span className="font-mono font-medium text-gray-900 dark:text-white">
            {currentKwh.toFixed(1)} kWh
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500 dark:text-gray-400">Capacity:</span>
          <span className="font-mono font-medium text-gray-900 dark:text-white">
            {batteryCapacityKwh} kWh
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500 dark:text-gray-400">Target:</span>
          <span className="font-mono font-medium text-gray-900 dark:text-white">
            {targetSoc}%
          </span>
        </div>
        {isCharging && chargingPowerKw && (
          <div className="flex justify-between">
            <span className="text-gray-500 dark:text-gray-400">Power:</span>
            <span className="font-mono font-medium text-green-600 dark:text-green-400">
              {chargingPowerKw.toFixed(1)} kW
            </span>
          </div>
        )}
      </div>

      {/* ETA */}
      {estimatedMinutes !== null && estimatedMinutes > 0 && (
        <div className="flex items-center justify-center gap-2 py-2 px-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
          <svg
            className="w-4 h-4 text-blue-600 dark:text-blue-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
            ~{formatTime(estimatedMinutes)} to {targetSoc}%
          </span>
        </div>
      )}
    </div>
  );
};

export default BatteryVisualization;
