/**
 * Represents a point on the MeterValue curve
 */
export interface CurvePoint {
  /** Time in minutes from transaction start */
  time: number;
  /** MeterValue in kWh */
  value: number;
}

/**
 * Configuration for automatic MeterValue sending
 */
export interface AutoMeterValueConfig {
  /** Whether auto MeterValue is enabled */
  enabled: boolean;
  /** Control points for the Bezier curve */
  curvePoints: CurvePoint[];
  /** Interval for sending MeterValue (in seconds) */
  intervalSeconds: number;
  /** Whether to calculate interval automatically from curve duration */
  autoCalculateInterval: boolean;
}

/**
 * Calculate a point on a cubic Bezier curve
 */
export function calculateBezierPoint(
  t: number,
  points: CurvePoint[]
): number {
  if (points.length === 0) return 0;
  if (points.length === 1) return points[0].value;
  if (points.length === 2) {
    // Linear interpolation
    return points[0].value + (points[1].value - points[0].value) * t;
  }

  // For multiple points, use De Casteljau's algorithm
  const n = points.length - 1;
  let tempPoints = [...points];

  for (let i = 1; i <= n; i++) {
    const newPoints: CurvePoint[] = [];
    for (let j = 0; j <= n - i; j++) {
      newPoints.push({
        time: (1 - t) * tempPoints[j].time + t * tempPoints[j + 1].time,
        value: (1 - t) * tempPoints[j].value + t * tempPoints[j + 1].value,
      });
    }
    tempPoints = newPoints;
  }

  return tempPoints[0].value;
}

/**
 * Get MeterValue at a specific time based on the curve
 */
export function getMeterValueAtTime(
  elapsedMinutes: number,
  config: AutoMeterValueConfig
): number {
  if (config.curvePoints.length === 0) return 0;

  const sortedPoints = [...config.curvePoints].sort((a, b) => a.time - b.time);
  const minTime = sortedPoints[0].time;
  const maxTime = sortedPoints[sortedPoints.length - 1].time;

  // Clamp elapsed time to curve range
  const clampedTime = Math.max(minTime, Math.min(maxTime, elapsedMinutes));

  // Normalize t to [0, 1] range
  const t =
    maxTime > minTime ? (clampedTime - minTime) / (maxTime - minTime) : 0;

  return calculateBezierPoint(t, sortedPoints);
}

/**
 * Default auto MeterValue configuration
 */
export const defaultAutoMeterValueConfig: AutoMeterValueConfig = {
  enabled: false,
  curvePoints: [
    { time: 0, value: 0 },
    { time: 30, value: 50 },
  ],
  intervalSeconds: 10,
  autoCalculateInterval: false,
};
