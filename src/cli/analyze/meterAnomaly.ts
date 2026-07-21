/**
 * Post-processing layer for `analyze` (issue #188 Track 3): recomputes
 * `METER_VALUE_ANOMALY` findings correctly and replaces the toolkit's own
 * (wrong) findings with them.
 *
 * Exists to compensate for two real defects in the OCPP DebugKit toolkit's
 * rule 14, `detectMeterValueAnomaly` (probed against the real 0.4.0 install
 * by reading `node_modules/@ocpp-debugkit/toolkit/dist/core/detection.js`
 * directly, not inferred):
 *
 * 1. It pushes every `sampledValue.value` in a session into one flat
 *    `readings[]` array -- across ALL `measurand`s, `phase`s, `unit`s, and
 *    `location`s at once -- and then asserts that flat sequence never
 *    decreases. Only cumulative registers (`Energy.*.Register`) are
 *    monotonic per OCPP 1.6 §7.28; `Power.Active.Import`, `SoC`,
 *    `Current.Import`, `Voltage`, `Temperature`, etc. legitimately rise and
 *    fall within a session (a charge taper, a V2G discharge, ambient
 *    heating). A charge point that reports two measurands per sample --
 *    completely normal -- gets a false warning on nearly every message: a
 *    real observed trace with a strictly-monotonic
 *    `Energy.Active.Import.Register` (+25 Wh every 30s, exactly 3 kW) that
 *    also sent a constant `Power.Active.Import = 3000 W` in the same
 *    `MeterValues` produced 22 false "Non-monotonic meter reading: value
 *    decreased from 3000 to 625" warnings.
 * 2. `connectorId` appears exactly once in the whole file -- inside a
 *    comment. No rule groups by connector, so on a multi-connector station,
 *    two connectors' independent (each individually monotonic) meters can
 *    be interleaved into that same one flat series too (observed: 80 false
 *    warnings on a real 4-connector trace). This happens whenever
 *    `buildSessionTimeline` can't key events by `transactionId` (e.g. a
 *    trace excerpt with `MeterValues` but no correlated `StartTransaction`)
 *    and falls back to lumping every event from every connector into one
 *    `session-0`.
 *
 * The fix: bucket readings by `(connectorId, measurand, phase, unit,
 * location)` and only run the monotonicity/negative-value check within a
 * bucket, and only for the four cumulative registers. See
 * `detectCorrectedMeterValueAnomalies` below.
 *
 * This is deliberately a POST-processing step -- it runs on `sessions` and
 * `failures` already produced by the real toolkit pipeline -- rather than
 * scrubbing/regrouping the `events` handed to the toolkit beforehand (the
 * way `splitTrace.ts` pre-processes by `chargePointId`). The report's
 * timeline and Event Appendix must still show the real, unmodified
 * `MeterValues` payloads exactly as the charge point sent them; rewriting
 * or splitting events before `parseOpenOcppTrace`/`buildSessionTimeline`
 * would corrupt that record. Recomputing findings afterward, from the same
 * `session.events` the toolkit already built, keeps the event list honest
 * while still fixing what gets reported as a failure.
 */

import type {
  Failure,
  FailureSeverity,
  Session,
} from "@ocpp-debugkit/toolkit/core";

/**
 * Cumulative (monotonically non-decreasing, per OCPP 1.6 §7.28) energy
 * register measurands. Everything else (`Power.Active.Import`, `SoC`,
 * `Current.Import`, `Voltage`, `Temperature`, `Frequency`, ...) is expected
 * to rise and fall within a session and must never be monotonicity-checked.
 */
const CUMULATIVE_MEASURANDS = new Set<string>([
  "Energy.Active.Import.Register",
  "Energy.Reactive.Import.Register",
  "Energy.Active.Export.Register",
  "Energy.Reactive.Export.Register",
]);

/**
 * `SEVERITY.METER_VALUE_ANOMALY` and `SUGGESTED_STEPS.METER_VALUE_ANOMALY`,
 * copied verbatim from the installed
 * `node_modules/@ocpp-debugkit/toolkit/dist/core/detection.js` (0.4.0).
 * Neither is exported from the toolkit's public `/core` entry point --
 * `dist/core/index.js` only re-exports `detectFailures` itself, not the
 * internal `SEVERITY`/`SUGGESTED_STEPS` tables it's built from -- and
 * they're not reachable via any other subpath export either, so there is
 * nothing to import here; this is a deliberate, pinned copy, not a guess.
 * `@ocpp-debugkit/toolkit` is pinned to an exact `0.4.0` (no `^` range) in
 * package.json specifically so an upstream wording change can't silently
 * drift this copy out from under us (docs/cli.md -> analyze -> Dependency).
 */
const METER_VALUE_ANOMALY_SEVERITY: FailureSeverity = "warning";
const METER_VALUE_ANOMALY_SUGGESTED_STEPS: string[] = [
  "Verify the meter is functioning correctly and is properly calibrated",
  "Check for meter communication errors or data corruption",
  "Review the meter value sampling and reporting configuration",
  "Inspect for potential tampering or hardware malfunction",
  "Contact the meter vendor if the issue persists",
];

interface Reading {
  eventId: string;
  value: number;
}

/** Bucket key: distinct (connectorId, measurand, phase, unit, location)
 *  combinations are physically distinct meter series and must never be
 *  compared against each other for monotonicity. `null`/`undefined`
 *  components are kept distinct from any concrete value via JSON encoding,
 *  not coerced to a shared sentinel that could collide with a real value. */
function bucketKey(
  connectorId: number | null,
  measurand: string,
  phase: string | undefined,
  unit: string | undefined,
  location: string | undefined,
): string {
  return JSON.stringify([
    connectorId,
    measurand,
    phase ?? null,
    unit ?? null,
    location ?? null,
  ]);
}

/** Shape mirrors the toolkit's own MeterValues payload assumption (see the
 *  comment in detection.js): `{ connectorId, transactionId, meterValue: [{
 *  timestamp, sampledValue: [{ value, measurand?, phase?, unit?, location?
 *  }] }] }`. `payload` is `unknown` on the normalized `Event`, so every
 *  field is read defensively, same as the toolkit itself does. */
interface MeterValuesPayloadLike {
  connectorId?: unknown;
  meterValue?: unknown;
}
interface MeterValueEntryLike {
  sampledValue?: unknown;
}
interface SampledValueLike {
  value?: unknown;
  measurand?: unknown;
  phase?: unknown;
  unit?: unknown;
  location?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Extracts one session's cumulative-register readings, correctly bucketed.
 *  Mirrors detection.js's own MeterValues traversal order (event ->
 *  meterValue[] -> sampledValue[]) so findings still enumerate in a
 *  reading's natural chronological order within each bucket. */
function collectBuckets(session: Session): Map<string, Reading[]> {
  const buckets = new Map<string, Reading[]>();
  const meterEvents = session.events.filter(
    (e) => e.messageType === "Call" && e.action === "MeterValues",
  );

  for (const event of meterEvents) {
    const payload = event.payload as MeterValuesPayloadLike | null | undefined;
    const connectorId =
      typeof payload?.connectorId === "number" ? payload.connectorId : null;
    const meterValues = payload?.meterValue;
    if (!Array.isArray(meterValues)) continue;

    for (const mv of meterValues as MeterValueEntryLike[]) {
      const sampledValues = mv?.sampledValue;
      if (!Array.isArray(sampledValues)) continue;

      for (const sv of sampledValues as SampledValueLike[]) {
        const rawValue = sv?.value;
        let numValue: number | undefined;
        if (typeof rawValue === "string") {
          const parsed = Number.parseFloat(rawValue);
          if (!Number.isNaN(parsed)) numValue = parsed;
        } else if (typeof rawValue === "number") {
          numValue = rawValue;
        }
        if (numValue === undefined) continue;

        // OCPP 1.6 §7.28: `sampledValue.measurand` is OPTIONAL and defaults
        // to "Energy.Active.Import.Register" when absent. An absent
        // measurand is NOT "unknown, skip it" -- it has a spec-defined
        // meaning, so it must be treated as the cumulative register, same
        // as an explicit one.
        const measurand =
          asString(sv?.measurand) ?? "Energy.Active.Import.Register";
        if (!CUMULATIVE_MEASURANDS.has(measurand)) {
          // Not a cumulative register (Power.Active.Import, SoC,
          // Current.Import, Voltage, Temperature, ...): these legitimately
          // rise and fall within a session (charge taper, V2G discharge,
          // thermal drift). Neither the monotonicity check nor the
          // negative-value check below applies to them -- a negative
          // Power.Active.Import / Current.Import in particular is the
          // normal, expected shape of a bidirectional (V2G) charger
          // discharging back to the grid, not an anomaly.
          continue;
        }

        const key = bucketKey(
          connectorId,
          measurand,
          asString(sv?.phase),
          asString(sv?.unit),
          asString(sv?.location),
        );
        const reading: Reading = { eventId: event.id, value: numValue };
        const bucket = buckets.get(key);
        if (bucket) bucket.push(reading);
        else buckets.set(key, [reading]);
      }
    }
  }

  return buckets;
}

function makeFinding(description: string, eventIds: string[]): Failure {
  return {
    code: "METER_VALUE_ANOMALY",
    description,
    severity: METER_VALUE_ANOMALY_SEVERITY,
    eventIds,
    suggestedSteps: METER_VALUE_ANOMALY_SUGGESTED_STEPS,
  };
}

/**
 * Correctly-derived replacement for the toolkit's rule 14
 * (`detectMeterValueAnomaly`). Same scope as the toolkit's own rule --
 * sessions with no `transactionId` are skipped, matching
 * `detectMeterValueAnomaly`'s own `if (session.transactionId === null)
 * continue;` -- but within that scope, cumulative-register readings are
 * bucketed by `(connectorId, measurand, phase, unit, location)` before the
 * monotonicity/negative-value checks run, instead of the toolkit's single
 * flat per-session array.
 */
export function detectCorrectedMeterValueAnomalies(
  sessions: Session[],
): Failure[] {
  const findings: Failure[] = [];

  for (const session of sessions) {
    if (session.transactionId === null) continue;

    const buckets = collectBuckets(session);
    for (const readings of buckets.values()) {
      for (const reading of readings) {
        if (reading.value < 0) {
          findings.push(
            makeFinding(
              `Negative meter value detected: ${reading.value} in session ${session.sessionId} (transaction ${session.transactionId})`,
              [reading.eventId],
            ),
          );
        }
      }
      for (let i = 1; i < readings.length; i++) {
        const prev = readings[i - 1];
        const curr = readings[i];
        if (!prev || !curr) continue;
        if (curr.value < prev.value) {
          findings.push(
            makeFinding(
              `Non-monotonic meter reading: value decreased from ${prev.value} to ${curr.value} in session ${session.sessionId} (transaction ${session.transactionId})`,
              [prev.eventId, curr.eventId],
            ),
          );
        }
      }
    }
  }

  return findings;
}

/**
 * Strips every `METER_VALUE_ANOMALY` finding the toolkit produced and
 * replaces them with `detectCorrectedMeterValueAnomalies`'s correctly-scoped
 * ones, leaving every other failure code untouched. Called between
 * `detectFailures(...)` and `summarizeSessions(...)` in `runAnalyze.ts` so
 * `summarizeSessions`' per-session failure counts (which intersect a
 * failure's `eventIds` against `session.events`) count the corrected set,
 * not the toolkit's raw one.
 */
export function correctMeterValueAnomalies(
  sessions: Session[],
  failures: Failure[],
): Failure[] {
  const withoutMeterAnomalies = failures.filter(
    (f) => f.code !== "METER_VALUE_ANOMALY",
  );
  return [
    ...withoutMeterAnomalies,
    ...detectCorrectedMeterValueAnomalies(sessions),
  ];
}
