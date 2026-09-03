---
title: analyze subcommand
type: entity
summary: "`ocpp-cp-sim analyze` — OCPP DebugKit failure-pattern reports over a v1.1 trace file or a running daemon's stored logs, with per-charge-point / per-connector splitting."
sources:
  - src/cli/analyze/
  - src/cli/analyze/__tests__/
  - src/trace/logEntryToTrace.ts
  - "issue #188"
related:
  - cli.md
  - ocpp-debugkit.md
  - ../concepts/trace-format.md
  - ../concepts/log-format.md
updated: 2026-09-03
---

# `analyze` subcommand

```bash
ocpp-cp-sim analyze <trace.jsonl> [--output <file>] [--format html|markdown]
                     [--split-by charge-point|connector]
ocpp-cp-sim analyze --from-daemon --cp-id <id> [--http-url <url>]
                     [--http-basic-auth-user <u> --http-basic-auth-pass <p>]
                     [--output <file>] [--format html|markdown]
                     [--split-by charge-point|connector]
```

Runs [OCPP DebugKit](ocpp-debugkit.md)'s failure-pattern detection over a
v1.1 trace ([Trace format](../concepts/trace-format.md)) and writes a report.
Unlike every other [CLI](cli.md) mode, `analyze` never bootstraps a charge
point or starts a server. In its default form it only reads the given file and
writes a report; with `--from-daemon` it instead makes the same kind of
short-lived client connection as `--send`/`--stop`/`--events` to pull the
trace from a running [daemon](daemon.md), then closes it — see
[Reading from a running daemon](#reading-from-a-running-daemon---from-daemon)
below.

```bash
# Markdown to stdout (default)
ocpp-cp-sim analyze trace.jsonl

# Self-contained HTML report written to a file
ocpp-cp-sim analyze trace.jsonl --output report.html

# Force a format regardless of the --output extension
ocpp-cp-sim analyze trace.jsonl --output report.txt --format html

# From a running daemon's stored logs, no trace file needed
ocpp-cp-sim analyze --from-daemon --cp-id CP001 --output report.html

# One report per connector instead of one per charge point
ocpp-cp-sim analyze trace.jsonl --split-by connector --output report.html
```

## Reading from a running daemon (`--from-daemon`)

A trace file only exists if the daemon was started with `--trace-output`.
An operator running a long-lived daemon — in Kubernetes, say — usually
wasn't, and restarting it just to get one loses whatever session is in
flight and starts the trace from empty. `--from-daemon` avoids both: the
daemon already persists every log line it produces and exposes them per
charge point over the `logs.get` RPC
([Log format → Related RPC methods](../concepts/log-format.md#related-rpc-methods)),
and that log line shape (`{timestamp, level, type, message, cpId}`) is exactly
what [`logEntryToTrace.ts`](../../src/trace/logEntryToTrace.ts) already adapts
into trace records for `--log-format json` and the browser log-viewer
download (see
[Trace format → Producing records](../concepts/trace-format.md#producing-records)).
`--from-daemon` is that same adapter run against the live log store, not a
second trace format, and it requires no daemon restart.

- `--cp-id <id>` is required: `logs.get` is scoped to one charge point, the
  same way `--send`/`--events` are scoped by `--cp-id`. `analyze` rejects
  `--from-daemon` with no `--cp-id`, and rejects `--cp-id` /
  `--http-url` / `--http-basic-auth-*` without `--from-daemon` — a daemon
  and a trace file are two different trace sources, and silently preferring
  one over the other would hide which of them a report actually describes,
  so a positional trace file combined with `--from-daemon` is also rejected.
- `--http-url <url>` targets the daemon, same as the other client modes
  (default `http://127.0.0.1:9700`).
- `--http-basic-auth-user <u>` / `--http-basic-auth-pass <p>` authenticate
  against a daemon started with `--web-console-basic-auth-*`, exactly like
  the top-level `--http-basic-auth-*` flags for `--send`/`--stop`/`--events`
  do; the two must be given together, since a half-specified credential is a
  misconfiguration, not a request for anonymous access.
- `analyze --from-daemon` only sees what the log store still holds: with no
  `--state-db`, that's the daemon's bounded in-memory Logger buffer, which
  is lost on restart; with `--state-db`, it's the persisted `logs` table,
  which can itself be trimmed by the `logs.clear` RPC or `state.reset`
  ([State persistence](../concepts/state-persistence.md)). A
  session whose log lines have aged out or were cleared is invisible to
  `analyze --from-daemon` the same way it would be to any other consumer of
  `logs.get` — a fresh `--trace-output` file remains the only source
  guaranteed to have everything captured since the process last
  (re)started.
- If the daemon has no stored OCPP wire log lines for that charge point at
  all — e.g. its logs are only scenario/diagnostic chatter, which
  `logEntryToTrace.ts` maps to nothing — `analyze` exits 1 instead of
  producing an empty report:

  ```
  Error: the daemon has no stored OCPP wire logs for charge point CP001 (nothing to analyze)
  ```

  A connection or auth failure while fetching the logs (daemon unreachable,
  wrong `--http-basic-auth-*`, unknown `--cp-id`) is also reported and exits
  1, prefixed `Error: cannot read logs from daemon: `.

## Formats

| Value               | When it's used                                         | Output                                                               |
| ------------------- | ------------------------------------------------------ | -------------------------------------------------------------------- |
| `--format markdown` | Default, unless `--output` ends in `.html`             | Markdown text                                                        |
| `--format html`     | Default when `--output` ends in `.html`; can be forced | A single self-contained HTML file (inline CSS, no external requests) |

## Multi charge-point traces

The DebugKit toolkit's analysis pipeline has no concept of `chargePointId` —
it was built around a single-station 1.6J model. Handing it a trace that
mixes several charge points as-is would silently flatten them into one
station, and two charge points that happen to reuse the same OCPP
`messageId` (routine, since messageIds are only unique per connection) could
have their CALLs/CALLRESULTs cross-correlate, hiding a real failure on one of
them.

`analyze` compensates by splitting the trace by `chargePointId` **before**
handing anything to the toolkit, and analyzing each charge point
independently:

- A trace with exactly one charge point (or only unattributed records)
  produces one report. With `--output <file>`, it is written to exactly that
  path.
- A trace with multiple charge points produces one report per charge point.
  With `--output out.html`, each is written as `out.<chargePointId>.html`
  (the charge point id is inserted before the extension and sanitized for
  the filesystem: anything outside `[A-Za-z0-9._-]` becomes `_`). Records
  with no `chargePointId` at all are grouped together and reported as charge
  point `(no chargePointId)`. If two charge point ids sanitize to the same
  filename (e.g. `CP/A` and `CP_A`), the later one in the trace gets a
  numeric suffix instead of overwriting the first (`out.CP_A.html`,
  `out.CP_A.2.html`, ...), and a note identifying the original charge point
  id and the path used is printed to stderr.
- With no `--output`: by default (no `--format`), all reports are printed to
  stdout as Markdown, each under its own `# Charge point <id>` heading. With
  an explicit `--format html`, each report is instead a self-contained HTML
  document, and since an HTML document has no sensible place for that
  heading, reports are separated by an `<!-- Charge point <id> -->` comment
  marker instead (still one valid concatenated stream to redirect to a
  file). An explicit `--format` always wins over the `--output` extension
  (see [Formats](#formats) above) — this applies with or without
  `--output`.

## Splitting by connector (`--split-by connector`)

Same root cause as the chargePointId problem above, one level down: most of
the toolkit's rules operate over a whole station's events at once. Since
0.4.2 exactly two of them group by `connectorId` —
`STATUS_TRANSITION_VIOLATION` and `METER_VALUE_ANOMALY`, both fixed upstream
off the back of issue #188. Every other rule still folds all connectors into
one series, so a multi-connector station's findings are read against a
timeline that interleaves connectors with nothing to do with each other.

`--split-by connector` (default `--split-by charge-point`, i.e. today's
behavior, unchanged) further splits each charge point's records by
connector before analysis, so each connector gets its own report:

- A record's connector is derived from `payload.connectorId` for
  `StatusNotification`, `MeterValues`, `StartTransaction`, and
  `RemoteStartTransaction`. `StopTransaction` / `RemoteStopTransaction`
  carry only `transactionId`; their connector is resolved by correlating
  each `StartTransaction` CALL's `messageId` to the `transactionId` in its
  CALLRESULT, then mapping that transaction back to the StartTransaction's
  connector. A CALLRESULT/CALLERROR itself carries no connector and
  inherits whichever connector the CALL it answers resolved to.
  `connectorId: 0` is station-level per OCPP 1.6 (the "whole station"
  pseudo-connector), never connector 1.
- Records with no derivable connector at all — `BootNotification`,
  `Heartbeat`, `Authorize`, `DiagnosticsStatusNotification`,
  `FirmwareStatusNotification`, `connectorId: 0`, or an unresolvable
  `StopTransaction` — are **replicated into every connector's report**.
  Rules like `UNEXPECTED_START` need to see the station's
  `BootNotification`; a per-connector report that lacked it would itself
  report a _new_ false positive ("StartTransaction without preceding
  BootNotification"), the exact kind of artifact this flag exists to
  remove. The consequence: a station-level finding (e.g. a real
  `DIAGNOSTICS_FAILURE`) can appear in more than one connector's report —
  read it as "this affects the whole station, seen from connector N's
  report," not as N separate failures.
- A charge point with no connector-scoped record at all (e.g. a boot-only
  trace) has nothing to split on; it falls back to one report under its
  plain charge point id, same as `--split-by charge-point`.
- Report filenames follow the same `--output` splitting as multiple charge
  points (above), with connector groups named
  `<chargePointId>-connector<N>`: `--output out.html` with charge point
  `CP001` and two connectors produces `out.CP001-connector1.html` and
  `out.CP001-connector2.html`.

This is opt-in rather than always-on: unlike the chargePointId split above
(a pure toolkit bug with no legitimate alternative reading), "should
`STATION_OFFLINE_DURING_SESSION` / `UNEXPECTED_START` etc. see the whole
station or just one connector" is a real judgment call, so the default
stays today's whole-station behavior.

## Excluded records

The toolkit only understands OCPP 1.6J. Records transported over SOAP
(`transport: "soap"`) and records with a non-1.6 `ocppVersion` (e.g.
`2.0.1`, `2.1`) are excluded before analysis rather than being silently
misread as 1.6J frames — analyzing them would produce meaningless results.
Records with no `ocppVersion` at all are kept (treated as 1.6J, matching the
trace format's own default). Non-zero exclusion counts are printed to
stderr, e.g.:

```
excluded: 2 soap record(s), 1 non-1.6 record(s), 0 unparseable line(s)
```

A line that fails to parse as JSON, or parses to something other than a JSON
object, is counted as an unparseable line and skipped — it never aborts the
run.

## Disclaimer

Failure-pattern detection is not a conformance checker: it recognizes a
fixed catalog of known failure shapes, not the OCPP specification itself.
Every `analyze` run — regardless of format or outcome — prints this sentence
to stderr, appends it as a trailing paragraph to every Markdown report, and
injects it as a `<p>` immediately before `</body>` in every HTML report:

> Failure-pattern detection is not OCPP compliance certification: "no known
> failure detected" does not mean "OCPP compliant".

## Timeline is transaction-focused

The toolkit's session timeline is built around transactions
(`StartTransaction`/`StopTransaction`/`MeterValues`). Events outside a
transaction — `StatusNotification`, some bare `CALLRESULT`s — are folded
into a catch-all "no session" bucket rather than shown against the
transaction they happened alongside. This is the toolkit's own model, not
something `analyze` works around; read the report's timeline as
transaction-focused, not as a complete blow-by-blow of every wire message
(the Event Appendix at the end of each report still lists every event).

## Dependency

`analyze` requires `@ocpp-debugkit/toolkit`, pinned to an exact version
(currently `0.4.2`, no `^` range) in `package.json` — this is a third-party
analysis engine whose detection rules can change behavior between versions,
so upgrades are a deliberate, coordinated change (re-verify the test matrix
in `src/cli/analyze/__tests__/`), not an automatic dependency bump. The
toolkit's `/core` and `/reporter` entry points are loaded via dynamic
`import()` only inside the `analyze` code path, so every other CLI mode is
unaffected if the dependency is ever missing. See [OCPP DebugKit](ocpp-debugkit.md).
