/**
 * `analyze` subcommand orchestration (issue #188 Track 3): assembles the
 * OCPP DebugKit toolkit's own building blocks into the one pipeline it
 * doesn't ship as a single call, per charge point.
 *
 * The toolkit is imported dynamically, and ONLY its `/core` and `/reporter`
 * subpaths -- never the package root, and never `/cli` (which runs
 * `program.parse()` at module load, a real side effect on our own argv).
 * A dynamic import also means a missing/broken install fails inside
 * `runAnalyze()` with our own message instead of crashing every other CLI
 * mode at startup.
 *
 * Only `import type` (fully erased at compile time, no runtime import) is
 * used for the toolkit's types so the type-checker can see its shapes
 * without that also constituting an eager load.
 */

import * as fs from "fs";
import * as path from "path";
import { splitTraceJsonl } from "./splitTrace";
import type { AnalysisResult } from "@ocpp-debugkit/toolkit/reporter";

export interface AnalyzeOptions {
  file: string;
  output?: string;
  format?: "html" | "markdown";
}

/**
 * Issue #188 PoC item 8: the detector only recognizes a fixed catalog of
 * known failure shapes -- it is not a conformance checker. Printed
 * unconditionally (stderr, every markdown report, every HTML report) so a
 * clean run can never be read as "this station is OCPP compliant".
 */
export const ANALYZE_DISCLAIMER =
  'Failure-pattern detection is not OCPP compliance certification: "no known failure detected" does not mean "OCPP compliant".';

/** Label for the bucket of records with no `chargePointId` at all. */
const UNATTRIBUTED_GROUP_LABEL = "(no chargePointId)";

export function resolveReportFormat(
  output: string | undefined,
  format: "html" | "markdown" | undefined,
): "html" | "markdown" {
  if (format) return format;
  if (output && output.toLowerCase().endsWith(".html")) return "html";
  return "markdown";
}

/** Charge point ids are operator-controlled strings and land directly in a
 *  filename (multi-CP `--output` splitting); neutralize path separators and
 *  anything else a filesystem might treat specially. */
export function sanitizeCpIdForFilename(cpId: string): string {
  return cpId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** `out.html` + `CP001` -> `out.CP001.html` (multi-CP `--output` splitting). */
export function perGroupOutputPath(
  outputPath: string,
  chargePointId: string,
): string {
  const dir = path.dirname(outputPath);
  const ext = path.extname(outputPath);
  const base = path.basename(outputPath, ext);
  const fileName = `${base}.${sanitizeCpIdForFilename(chargePointId)}${ext}`;
  return dir === "." ? fileName : path.join(dir, fileName);
}

/** Inserts a numeric suffix before `path`'s extension: `out.CP_A.html` ->
 *  `out.CP_A.2.html`. Used to disambiguate a sanitized-filename collision
 *  between two distinct chargePointIds (e.g. "CP/A" and "CP_A" both
 *  sanitize to "CP_A"). */
function withNumericSuffix(outPath: string, n: number): string {
  const dir = path.dirname(outPath);
  const ext = path.extname(outPath);
  const base = path.basename(outPath, ext);
  const fileName = `${base}.${n}${ext}`;
  return dir === "." ? fileName : path.join(dir, fileName);
}

/** Computes each group's per-CP output path, in group iteration order,
 *  disambiguating any sanitized-filename collision deterministically: the
 *  first occupant of a filename keeps the plain path, later occupants get
 *  `.2`, `.3`, ... suffixes inserted before the extension. Returns the
 *  resolved path for each group plus a stderr note for any group that had
 *  to be disambiguated (see Fix 1, issue #188 review). */
function resolveGroupOutputPaths(
  outputPath: string,
  groups: Group[],
): { path: string; note?: string }[] {
  const used = new Set<string>();
  const resolved: { path: string; note?: string }[] = [];
  for (const group of groups) {
    const candidate = perGroupOutputPath(outputPath, group.id);
    if (!used.has(candidate)) {
      used.add(candidate);
      resolved.push({ path: candidate });
      continue;
    }
    let n = 2;
    let disambiguated = withNumericSuffix(candidate, n);
    while (used.has(disambiguated)) {
      n++;
      disambiguated = withNumericSuffix(candidate, n);
    }
    used.add(disambiguated);
    resolved.push({
      path: disambiguated,
      note:
        `Note: charge point "${group.id}" sanitizes to the same report ` +
        `filename as another charge point; writing its report to ` +
        `${disambiguated} instead of ${candidate}`,
    });
  }
  return resolved;
}

export function appendMarkdownDisclaimer(markdown: string): string {
  const separator = markdown.endsWith("\n") ? "\n" : "\n\n";
  return `${markdown}${separator}${ANALYZE_DISCLAIMER}\n`;
}

export function injectHtmlDisclaimer(html: string): string {
  const marker = "</body>";
  const fragment = `<p>${ANALYZE_DISCLAIMER}</p>`;
  const idx = html.lastIndexOf(marker);
  if (idx === -1) return `${html}${fragment}`;
  return `${html.slice(0, idx)}${fragment}${html.slice(idx)}`;
}

/** `ocppVersion` for the group's metadata, only when every record that
 *  states one agrees (records with no `ocppVersion` field don't count
 *  against uniformity) -- otherwise the field is left undefined rather than
 *  guessing. */
function detectUniformOcppVersion(jsonlText: string): string | undefined {
  let version: string | undefined;
  for (const line of jsonlText.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const value = (parsed as Record<string, unknown>).ocppVersion;
    if (typeof value !== "string") continue;
    if (version === undefined) {
      version = value;
    } else if (version !== value) {
      return undefined;
    }
  }
  return version;
}

interface Group {
  id: string;
  jsonl: string;
}

export async function runAnalyze(opts: AnalyzeOptions): Promise<number> {
  let text: string;
  try {
    text = fs.readFileSync(opts.file, "utf8");
  } catch (err) {
    process.stderr.write(
      `Error: cannot read trace file: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return 1;
  }

  const split = splitTraceJsonl(text);

  const groups: Group[] = [];
  for (const [cpId, jsonl] of split.byChargePoint)
    groups.push({ id: cpId, jsonl });
  if (split.unattributed) {
    groups.push({ id: UNATTRIBUTED_GROUP_LABEL, jsonl: split.unattributed });
  }

  if (groups.length === 0) {
    process.stderr.write(
      "Error: no analyzable records found in trace file " +
        "(all records were excluded or unparseable)\n",
    );
    return 1;
  }

  // Toolkit facts (probed against the real 0.4.0 install, not inferred):
  // no single analyze() call -- parseOpenOcppTrace -> buildSessionTimeline ->
  // detectFailures -> summarizeSessions is the pipeline, assembled here.
  let core: typeof import("@ocpp-debugkit/toolkit/core");
  let reporter: typeof import("@ocpp-debugkit/toolkit/reporter");
  try {
    core = await import("@ocpp-debugkit/toolkit/core");
    reporter = await import("@ocpp-debugkit/toolkit/reporter");
  } catch {
    process.stderr.write(
      "Error: @ocpp-debugkit/toolkit is not installed (analyze requires it)\n",
    );
    return 1;
  }
  const {
    parseOpenOcppTrace,
    buildSessionTimeline,
    detectFailures,
    summarizeSessions,
  } = core;
  const { generateMarkdownReport, generateHtmlReport } = reporter;

  const format = resolveReportFormat(opts.output, opts.format);

  // Per-group output paths are computed up front, in group iteration order,
  // so a sanitized-filename collision between two distinct chargePointIds
  // (Fix 1, issue #188 review) is resolved deterministically before any
  // file is written, rather than the second write silently clobbering the
  // first.
  const outputPaths: { path: string; note?: string }[] | undefined = opts.output
    ? groups.length === 1
      ? [{ path: opts.output }]
      : resolveGroupOutputPaths(opts.output, groups)
    : undefined;

  const stderrSummaryLines: string[] = [];
  const stdoutSections: string[] = [];
  const writtenPaths: string[] = [];
  let hadWriteError = false;

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const { events, warnings } = parseOpenOcppTrace(group.jsonl);
    const sessions = buildSessionTimeline(events);
    const failures = detectFailures(events, sessions);
    const summaries = summarizeSessions(sessions, failures);
    const result: AnalysisResult = {
      events,
      sessions,
      failures,
      summaries,
      warnings,
      metadata: {
        stationId: group.id,
        source: opts.file,
        ocppVersion: detectUniformOcppVersion(group.jsonl),
      },
    };

    const content =
      format === "html"
        ? injectHtmlDisclaimer(generateHtmlReport(result))
        : appendMarkdownDisclaimer(generateMarkdownReport(result));

    stderrSummaryLines.push(
      `${group.id}: ${events.length} events, ${failures.length} failures`,
    );

    if (outputPaths) {
      const { path: outPath, note } = outputPaths[i];
      if (note) process.stderr.write(`${note}\n`);
      // A write failure (Fix 2, issue #188 review) must not abort the run:
      // other groups still get their reports, and the per-group summaries,
      // exclusion counts, and disclaimer below are still printed. The run
      // is still flagged as an operational error via the exit code.
      try {
        fs.writeFileSync(outPath, content);
        writtenPaths.push(outPath);
      } catch (err) {
        hadWriteError = true;
        process.stderr.write(
          `Error: cannot write report file: ${outPath}: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    } else {
      // No --output: everything goes to stdout. The brief's default shape
      // is markdown with a per-group heading; a self-contained HTML report
      // has no sensible place for that heading, so an explicit `--format
      // html` with no `--output` instead separates groups with an HTML
      // comment marker (still one valid concatenated stream to redirect).
      stdoutSections.push(
        format === "html"
          ? `<!-- Charge point ${group.id} -->\n${content}`
          : `# Charge point ${group.id}\n\n${content}`,
      );
    }
  }

  for (const writtenPath of writtenPaths) {
    process.stdout.write(`Wrote report: ${writtenPath}\n`);
  }
  if (stdoutSections.length > 0) {
    process.stdout.write(stdoutSections.join("\n\n"));
  }

  for (const line of stderrSummaryLines) {
    process.stderr.write(`${line}\n`);
  }
  const { soap, unsupportedOcppVersion, unparseableLine } = split.excluded;
  if (soap > 0 || unsupportedOcppVersion > 0 || unparseableLine > 0) {
    process.stderr.write(
      `excluded: ${soap} soap record(s), ${unsupportedOcppVersion} non-1.6 record(s), ${unparseableLine} unparseable line(s)\n`,
    );
  }
  process.stderr.write(`${ANALYZE_DISCLAIMER}\n`);

  return hadWriteError ? 1 : 0;
}
