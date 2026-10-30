import { monitorBehaviour, type VariableMonitor } from "./VariableMonitor";

/**
 * The watched device-model value at one point in time: `text` as
 * GetVariables renders it (empty for a write-only value, N07.FR.10), and
 * `numeric` when the value is a number.
 */
export interface MonitoredReading {
  readonly numeric?: number;
  readonly text: string;
  /** The variable's Target value, when it has one and it is set (#538). */
  readonly target?: number;
}

/** What the evaluator remembers about one monitor between two values. */
export interface MonitorState {
  /** Upper/LowerThreshold: the value is beyond the threshold. */
  readonly triggered: boolean;
  /** Delta: the value when the monitor was set or last reported (N07.FR.18). */
  readonly baseline: MonitoredReading;
}

export interface MonitorNotice {
  readonly trigger: "Alerting" | "Delta" | "Periodic";
  /** `true` when a threshold monitor returns within range (N07.FR.02). */
  readonly cleared: boolean;
}

export interface MonitorEvaluationStep {
  readonly state: MonitorState;
  readonly notice?: MonitorNotice;
}

/**
 * One N07 evaluation step. `previous` is `undefined` when the monitor has
 * just been set: a threshold the value already exceeds triggers at once,
 * and a Delta takes the current value as its baseline. A periodic monitor
 * never fires on a value: its timer does (N08).
 */
export function evaluateMonitor(
  monitor: Pick<VariableMonitor, "type" | "value">,
  previous: MonitorState | undefined,
  reading: MonitoredReading,
): MonitorEvaluationStep {
  const behaviour = monitorBehaviour(monitor.type);
  if (behaviour === "periodic") {
    return { state: { triggered: false, baseline: reading } };
  }
  if (behaviour === "delta") {
    if (previous === undefined) {
      return { state: { triggered: false, baseline: reading } };
    }
    if (!deltaExceeded(monitor.value, previous.baseline, reading)) {
      return { state: previous };
    }
    return {
      state: { triggered: false, baseline: reading },
      notice: { trigger: "Delta", cleared: false },
    };
  }

  const wasTriggered = previous?.triggered ?? false;
  // A non-numeric reading cannot cross a threshold, and a TargetDelta has
  // nothing to compare without a target: keep the state.
  const exceeded = beyondBound(monitor, reading) ?? wasTriggered;
  const state = { triggered: exceeded, baseline: reading };
  if (exceeded === wasTriggered) return { state };
  return { state, notice: { trigger: "Alerting", cleared: !exceeded } };
}

/** Whether an alert monitor's value is beyond its bound; `undefined` when
 *  the reading cannot say. */
function beyondBound(
  monitor: Pick<VariableMonitor, "type" | "value">,
  reading: MonitoredReading,
): boolean | undefined {
  const actual = reading.numeric;
  if (actual === undefined) return undefined;
  switch (monitor.type) {
    case "UpperThreshold":
      return actual > monitor.value; // N07.FR.16: above, not on
    case "LowerThreshold":
      return actual < monitor.value; // N07.FR.17: below, not on
    case "TargetDelta":
      // 2.1 N07.FR.22: "more than plus or minus value".
      return reading.target === undefined
        ? undefined
        : Math.abs(actual - reading.target) > monitor.value;
    case "TargetDeltaRelative":
      // 2.1 N07.FR.23: "more than plus or minus (value * Target value)";
      // the band is measured on the target's magnitude.
      return reading.target === undefined
        ? undefined
        : Math.abs(actual - reading.target) >
            monitor.value * Math.abs(reading.target);
    default:
      return undefined;
  }
}

function deltaExceeded(
  step: number,
  baseline: MonitoredReading,
  reading: MonitoredReading,
): boolean {
  if (reading.numeric !== undefined && baseline.numeric !== undefined) {
    // N07.FR.18: "changed more than plus or minus" the step.
    return Math.abs(reading.numeric - baseline.numeric) > step;
  }
  // N07.FR.19: a non-numeric value fires on any change.
  return reading.text !== baseline.text;
}
