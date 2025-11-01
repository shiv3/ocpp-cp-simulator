import React from "react";
import {
  ScenarioExecutionState,
  ScenarioExecutionMode,
} from "../../cp/application/scenario/ScenarioTypes";

interface ScenarioControlPanelProps {
  executionState: ScenarioExecutionState;
  executionMode: ScenarioExecutionMode;
  onStart: (mode: ScenarioExecutionMode) => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onStep: () => void;
  onModeChange: (mode: ScenarioExecutionMode) => void;
  onSave: () => void;
}

const ScenarioControlPanel: React.FC<ScenarioControlPanelProps> = ({
  executionState,
  executionMode,
  onStart,
  onPause,
  onResume,
  onStop,
  onStep,
  onModeChange,
  onSave,
}) => {
  const isRunning = executionState === "running";
  const isPaused = executionState === "paused";
  const isIdle = executionState === "idle";
  const isStepMode = executionMode === "step";

  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-base font-semibold text-primary">
          Scenario Control
        </h3>
        <div className="flex items-center gap-3">
          <button
            onClick={onSave}
            className="btn-success text-xs px-3 py-1.5"
            title="Save Scenario"
          >
            💾 Save
          </button>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">Status:</span>
            <span
              className={`text-xs font-semibold ${getStateColor(executionState)}`}
            >
              {executionState ? executionState.toUpperCase() : "IDLE"}
            </span>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {/* Execution Mode Selection */}
        <div>
          <label className="text-xs font-semibold text-primary mb-1 block">
            Execution Mode
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => onModeChange("oneshot")}
              disabled={!isIdle}
              className={`flex-1 text-xs px-3 py-2 rounded ${
                executionMode === "oneshot" ? "btn-primary" : "btn-secondary"
              }`}
            >
              One-Shot
            </button>
            <button
              onClick={() => onModeChange("step")}
              disabled={!isIdle}
              className={`flex-1 text-xs px-3 py-2 rounded ${
                executionMode === "step" ? "btn-primary" : "btn-secondary"
              }`}
            >
              Step
            </button>
          </div>
        </div>

        {/* Control Buttons */}
        <div className="flex gap-2">
          {isIdle && (
            <button
              onClick={() => onStart(executionMode)}
              className="flex-1 btn-success"
            >
              ▶️ Start
            </button>
          )}

          {isRunning && !isStepMode && (
            <button onClick={onPause} className="flex-1 btn-warning">
              ⏸️ Pause
            </button>
          )}

          {isPaused && (
            <button onClick={onResume} className="flex-1 btn-success">
              ▶️ Resume
            </button>
          )}

          {(isRunning || isPaused) && (
            <button onClick={onStop} className="flex-1 btn-danger">
              ⏹️ Stop
            </button>
          )}

          {isStepMode && (isRunning || isPaused) && (
            <button onClick={onStep} className="flex-1 btn-info">
              ⏭️ Step
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

function getStateColor(state: ScenarioExecutionState): string {
  switch (state) {
    case "idle":
      return "text-gray-600 dark:text-gray-400";
    case "running":
      return "text-green-600 dark:text-green-400";
    case "paused":
      return "text-yellow-600 dark:text-yellow-400";
    case "completed":
      return "text-blue-600 dark:text-blue-400";
    case "error":
      return "text-red-600 dark:text-red-400";
    default:
      return "text-gray-600 dark:text-gray-400";
  }
}

export default ScenarioControlPanel;
