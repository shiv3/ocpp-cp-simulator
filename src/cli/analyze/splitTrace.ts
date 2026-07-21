/**
 * Pre-processing layer for `analyze` (issue #188 Track 3): splits a v1.1
 * trace JSONL file into one JSONL blob per charge point.
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
 */

export interface TraceSplit {
  /** chargePointId -> that CP's records re-serialized as JSONL text. */
  byChargePoint: Map<string, string>;
  /** Records with no chargePointId, as JSONL text ("" if none). */
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

export function splitTraceJsonl(jsonlText: string): TraceSplit {
  const byChargePointLines = new Map<string, string[]>();
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
    const bucket = byChargePointLines.get(cpId);
    if (bucket) {
      bucket.push(line);
    } else {
      byChargePointLines.set(cpId, [line]);
    }
  }

  const byChargePoint = new Map<string, string>();
  for (const [cpId, lines] of byChargePointLines) {
    byChargePoint.set(cpId, lines.map((l) => l + "\n").join(""));
  }

  return {
    byChargePoint,
    unattributed: unattributedLines.map((l) => l + "\n").join(""),
    excluded,
    total,
  };
}
