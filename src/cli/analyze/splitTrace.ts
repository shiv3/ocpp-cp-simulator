/**
 * Pre-processing layer for `analyze` (issue #188 Track 3): splits a v1.1
 * trace JSONL file into one JSONL blob per charge point, and optionally
 * further into one blob per connector.
 *
 * Exists to compensate for a real limitation of the OCPP DebugKit toolkit
 * (probed against the real 0.4.0 install, not inferred): its analysis
 * pipeline has no concept of `chargePointId` at all — every record in a
 * trace is folded into one implicit station, so two charge points that
 * happen to reuse the same OCPP messageId (routine, since messageIds are
 * only unique per connection) get their CALLs/CALLRESULTs correlated
 * against each other. A CSMS that answers CP-A's `Authorize` but ignores
 * CP-B's same-id `Authorize` reads, to the toolkit, as one fully-answered
 * exchange — CP-B's real failure disappears. Splitting by chargePointId
 * BEFORE handing anything to the toolkit is the only fix; it cannot be
 * patched after the fact once messageIds have collided.
 *
 * It also only understands OCPP 1.6J: SOAP transport and non-1.6 versions
 * (2.0.1, 2.1) are accepted silently and analyzed as if they were 1.6J
 * frames, producing meaningless results. We filter those out ourselves and
 * surface the counts so the operator knows what was skipped.
 *
 * Deliberately has no dependency on the toolkit (or anything else) so it is
 * cheap to unit test in isolation and cannot be affected by how the toolkit
 * is imported/loaded elsewhere in the analyze code path.
 *
 * ---------------------------------------------------------------------------
 * Optional connector splitting (`splitBy: "connector"`, issue #188 usability
 * follow-up)
 * ---------------------------------------------------------------------------
 *
 * The toolkit's rules operate over a whole station's events at once, same
 * root defect as the chargePointId problem above: `connectorId` appears
 * exactly once in the installed `dist/core/detection.js` — inside a comment
 * — and no rule groups by it. `STATUS_TRANSITION_VIOLATION` in particular
 * treats connector A going `Available` while connector B (on the same
 * station) goes `Finishing` as one, invalid, transition (observed: 24
 * findings on a real 4-connector trace; hand-filtering that trace down to a
 * single connector reduced it to 1 real one). Unlike the measurand defect
 * fixed in `meterAnomaly.ts`, this cannot be corrected by re-deriving
 * findings after the fact — `STATUS_TRANSITION_VIOLATION` needs to never see
 * another connector's `StatusNotification`s in the first place, which means
 * the split has to happen here, before `parseOpenOcppTrace`, exactly like
 * the chargePointId split above.
 *
 * This is opt-in (`--split-by connector`, default `"charge-point"`) rather
 * than the always-on chargePointId split: chargePointId cross-talk is a pure
 * toolkit bug with no legitimate reading of the data, but "should
 * STATION_OFFLINE_DURING_SESSION / UNEXPECTED_START etc. see the whole
 * station or just one connector" is a real judgment call an operator may
 * want either way, so the default stays the current, whole-station
 * behavior.
 *
 * Deriving a record's connector:
 * - `StatusNotification`, `MeterValues`, `StartTransaction`,
 *   `RemoteStartTransaction` carry `payload.connectorId` directly.
 * - `StopTransaction` / `RemoteStopTransaction` carry only
 *   `transactionId` — resolved by first correlating each `StartTransaction`
 *   CALL's `messageId` to the `transactionId` in its CALLRESULT, then
 *   mapping that transaction back to the StartTransaction's connector.
 * - A CALLRESULT/CALLERROR itself carries no connectorId at all; it
 *   inherits the connector of the CALL it answers (matched by messageId).
 *   Without this, e.g. StartTransaction's own CALLRESULT — which carries
 *   the transactionId the StopTransaction correlation above depends on —
 *   would have nowhere connector-specific to go and would be replicated
 *   into every connector group as "station-level" (see below), producing a
 *   phantom session with that transactionId in every OTHER connector's
 *   report too. That is a new false positive: the exact kind of artifact
 *   this whole feature exists to remove.
 * - `connectorId: 0` is station-level per OCPP 1.6 (the connector-0 /
 *   "whole station" pseudo-connector), never connector 1.
 *
 * Station-level records — no derivable connector at all, whether because
 * the action carries none (`BootNotification`, `Heartbeat`, `Authorize`,
 * `DiagnosticsStatusNotification`, `FirmwareStatusNotification`, ...) or
 * because it resolved to `connectorId: 0` or an unresolvable
 * StopTransaction — are replicated into EVERY connector group. Rules like
 * `UNEXPECTED_START` need to see the station's `BootNotification`; a
 * per-connector group that lacked it would itself report a *new* false
 * positive ("StartTransaction without preceding BootNotification"), again
 * the exact artifact this change exists to remove. The unavoidable
 * consequence: a station-level finding (e.g. a real `DIAGNOSTICS_FAILURE`)
 * can appear in more than one per-connector report — read as "this affects
 * the whole station, seen from connector N's report," not as N separate
 * failures.
 *
 * A charge point with no connector-scoped record at all (e.g. a
 * boot-only trace, or one connector-less OCPP profile) has nothing to
 * derive a connector split from; rather than silently dropping every
 * record, it falls back to a single group under its plain chargePointId,
 * identical to `splitBy: "charge-point"` for that one charge point.
 *
 * Group keys are `<chargePointId>-connector<N>` (ascending numeric order),
 * which `runAnalyze.ts` already treats as an opaque group id — its
 * filename-sanitization and collision-disambiguation logic
 * (`sanitizeCpIdForFilename` / `resolveGroupOutputPaths`) needs no changes
 * to keep working on these longer ids.
 */

export type TraceSplitMode = "charge-point" | "connector";

export interface TraceSplit {
  /** Group id -> that group's records re-serialized as JSONL text.
   *  `splitBy: "charge-point"` (default): keyed by chargePointId.
   *  `splitBy: "connector"`: keyed by `<chargePointId>-connector<N>`, or
   *  the plain chargePointId for a CP with no connector-scoped records
   *  (see module docstring). */
  byChargePoint: Map<string, string>;
  /** Records with no chargePointId, as JSONL text ("" if none). Never
   *  connector-split, regardless of `splitBy`: with no chargePointId there
   *  is no meaningful transactionId/connectorId correlation scope either. */
  unattributed: string;
  excluded: {
    soap: number;
    unsupportedOcppVersion: number;
    unparseableLine: number;
  };
  /** Count of non-blank lines examined (kept + excluded); blank lines are
   *  not records and are silently ignored, matching JSONL convention for a
   *  trailing newline at end of file. */
  total: number;
}

interface ParsedRecord {
  line: string;
  record: Record<string, unknown>;
}

/** CALL actions that carry their connector directly in `payload.connectorId`. */
const CONNECTOR_ID_ACTIONS = new Set([
  "StatusNotification",
  "MeterValues",
  "StartTransaction",
  "RemoteStartTransaction",
]);
/** CALL actions that carry only `payload.transactionId`; their connector is
 *  resolved via the StartTransaction correlation (see module docstring). */
const TRANSACTION_ID_ACTIONS = new Set([
  "StopTransaction",
  "RemoteStopTransaction",
]);

function getPayloadObject(
  payload: unknown,
): Record<string, unknown> | undefined {
  return typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
}

/** A positive (>0) connectorId from a payload, or undefined if absent,
 *  non-numeric, or 0 (0 is station-level, see module docstring). */
function positiveConnectorId(
  payload: Record<string, unknown> | undefined,
): number | undefined {
  const value = payload?.connectorId;
  return typeof value === "number" && value > 0 ? value : undefined;
}

/** "station" is a distinct sentinel from `undefined`: `undefined` means "we
 *  never looked at this messageId at all" (used as the Map's natural
 *  not-found return), while "station" means "we looked, and this CALL's own
 *  action/payload doesn't resolve to a specific connector" -- both end up
 *  replicated into every connector group, but keeping them distinct avoids
 *  the two cases silently meaning the same thing by accident as this logic
 *  evolves. */
type ConnectorResolution = number | "station";

/**
 * Derives each CALL messageId's connector for one charge point's records,
 * per the rules in the module docstring. CALLRESULT/CALLERROR responses are
 * NOT in this map; callers look them up by their own messageId anyway, which
 * naturally inherits the answered CALL's resolution.
 */
function resolveConnectorsByMessageId(
  records: ParsedRecord[],
): Map<string, ConnectorResolution> {
  // Pass 1: StartTransaction CALL messageId -> connectorId (only when it
  // resolves to an actual connector; an unresolvable/station-level
  // StartTransaction can't anchor any StopTransaction correlation either).
  const startTxMessageIdToConnector = new Map<string, number>();
  for (const { record } of records) {
    if (record.messageType !== "CALL" || record.action !== "StartTransaction")
      continue;
    const messageId =
      typeof record.messageId === "string" ? record.messageId : undefined;
    if (messageId === undefined) continue;
    const connectorId = positiveConnectorId(getPayloadObject(record.payload));
    if (connectorId !== undefined)
      startTxMessageIdToConnector.set(messageId, connectorId);
  }

  // Pass 2: transactionId -> connectorId, from the CALLRESULT that answers
  // each StartTransaction CALL found above (the transactionId only appears
  // in the response, never the request).
  const txIdToConnector = new Map<number, number>();
  for (const { record } of records) {
    if (record.messageType !== "CALLRESULT") continue;
    const messageId =
      typeof record.messageId === "string" ? record.messageId : undefined;
    if (messageId === undefined) continue;
    const connectorId = startTxMessageIdToConnector.get(messageId);
    if (connectorId === undefined) continue;
    const transactionId = getPayloadObject(record.payload)?.transactionId;
    if (typeof transactionId === "number") {
      txIdToConnector.set(transactionId, connectorId);
    }
  }

  // Pass 3: every connector-scoped CALL's own messageId -> resolution.
  const messageIdToConnector = new Map<string, ConnectorResolution>();
  for (const { record } of records) {
    if (record.messageType !== "CALL") continue;
    const messageId =
      typeof record.messageId === "string" ? record.messageId : undefined;
    if (messageId === undefined) continue;
    const action =
      typeof record.action === "string" ? record.action : undefined;
    if (action === undefined) continue;

    if (action === "StartTransaction") {
      messageIdToConnector.set(
        messageId,
        startTxMessageIdToConnector.get(messageId) ?? "station",
      );
    } else if (CONNECTOR_ID_ACTIONS.has(action)) {
      const connectorId = positiveConnectorId(getPayloadObject(record.payload));
      messageIdToConnector.set(messageId, connectorId ?? "station");
    } else if (TRANSACTION_ID_ACTIONS.has(action)) {
      const transactionId = getPayloadObject(record.payload)?.transactionId;
      const resolved =
        typeof transactionId === "number"
          ? txIdToConnector.get(transactionId)
          : undefined;
      messageIdToConnector.set(messageId, resolved ?? "station");
    }
    // Any other action (BootNotification, Heartbeat, Authorize, ...) is not
    // connector-scoped at all: no entry -> resolves to "station" by the
    // lookup default in groupRecordsByConnector below.
  }

  return messageIdToConnector;
}

/**
 * Splits one charge point's already-filtered records into per-connector
 * JSONL blobs, keyed by connector number, plus a station-level lines list
 * replicated into each. Returns `null` when no record resolves to an actual
 * connector (the all-station-level fallback case, see module docstring) so
 * the caller can fall back to a single plain-chargePointId group instead of
 * silently discarding every record.
 */
function groupRecordsByConnector(
  records: ParsedRecord[],
): { connectorId: number; lines: string[] }[] | null {
  const messageIdToConnector = resolveConnectorsByMessageId(records);

  const resolutionOf = (
    record: Record<string, unknown>,
  ): ConnectorResolution => {
    const messageId =
      typeof record.messageId === "string" ? record.messageId : undefined;
    if (messageId === undefined) return "station";
    return messageIdToConnector.get(messageId) ?? "station";
  };

  const resolutions = records.map(({ record }) => resolutionOf(record));
  const connectorIds = Array.from(
    new Set(resolutions.filter((r): r is number => typeof r === "number")),
  ).sort((a, b) => a - b);

  if (connectorIds.length === 0) return null;

  return connectorIds.map((connectorId) => ({
    connectorId,
    lines: records
      .filter((_, i) => {
        const r = resolutions[i];
        return r === connectorId || r === "station";
      })
      .map(({ line }) => line),
  }));
}

export function splitTraceJsonl(
  jsonlText: string,
  splitBy: TraceSplitMode = "charge-point",
): TraceSplit {
  const byChargePointRecords = new Map<string, ParsedRecord[]>();
  const unattributedLines: string[] = [];
  const excluded = { soap: 0, unsupportedOcppVersion: 0, unparseableLine: 0 };
  let total = 0;

  for (const line of jsonlText.split("\n")) {
    if (line.trim() === "") continue;
    total++;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      excluded.unparseableLine++;
      continue;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      excluded.unparseableLine++;
      continue;
    }
    const record = parsed as Record<string, unknown>;

    if (record.transport === "soap") {
      excluded.soap++;
      continue;
    }
    if (
      typeof record.ocppVersion === "string" &&
      !record.ocppVersion.startsWith("1.6")
    ) {
      excluded.unsupportedOcppVersion++;
      continue;
    }

    const cpId =
      typeof record.chargePointId === "string" && record.chargePointId
        ? record.chargePointId
        : undefined;
    if (cpId === undefined) {
      unattributedLines.push(line);
      continue;
    }
    const bucket = byChargePointRecords.get(cpId);
    const parsedRecord: ParsedRecord = { line, record };
    if (bucket) {
      bucket.push(parsedRecord);
    } else {
      byChargePointRecords.set(cpId, [parsedRecord]);
    }
  }

  const byChargePoint = new Map<string, string>();
  for (const [cpId, records] of byChargePointRecords) {
    if (splitBy === "connector") {
      const groups = groupRecordsByConnector(records);
      if (groups === null) {
        // No connector-scoped record for this CP at all -- fall back to a
        // single group under its plain chargePointId (module docstring).
        byChargePoint.set(
          cpId,
          records.map(({ line }) => line + "\n").join(""),
        );
        continue;
      }
      for (const { connectorId, lines } of groups) {
        byChargePoint.set(
          `${cpId}-connector${connectorId}`,
          lines.map((l) => l + "\n").join(""),
        );
      }
    } else {
      byChargePoint.set(cpId, records.map(({ line }) => line + "\n").join(""));
    }
  }

  return {
    byChargePoint,
    unattributed: unattributedLines.map((l) => l + "\n").join(""),
    excluded,
    total,
  };
}
