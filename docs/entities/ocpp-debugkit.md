---
title: OCPP DebugKit (`@ocpp-debugkit/toolkit`)
type: entity
summary: Third-party failure-pattern analysis engine behind `ocpp-cp-sim analyze`; consumes the shared trace format, understands OCPP 1.6J only, and is pinned to an exact version.
sources:
  - package.json (`@ocpp-debugkit/toolkit` pin)
  - src/cli/analyze/
  - "issue #188"
related:
  - analyze.md
  - ../concepts/trace-format.md
updated: 2026-09-03
---

# OCPP DebugKit

[OCPP DebugKit](https://github.com/ocpp-debugkit/toolkit) is an external
toolkit that detects a fixed catalog of known OCPP failure shapes
(`UNEXPECTED_START`, `STATUS_TRANSITION_VIOLATION`, `METER_VALUE_ANOMALY`,
`STATION_OFFLINE_DURING_SESSION`, `DIAGNOSTICS_FAILURE`, …) in a message
timeline and renders Markdown / HTML reports.

## Relationship to this project

- The [trace format](../concepts/trace-format.md) (issue #188) was designed as
  the implementation-independent contract between a producer of OCPP traffic
  (this simulator) and an analyzer (DebugKit), so neither is coupled to the
  other's internal models.
- The [`analyze` subcommand](analyze.md) is the integration: it splits a trace
  by charge point (and optionally connector) to work around the toolkit's
  single-station model, excludes SOAP / non-1.6 records, and feeds the rest to
  the toolkit's `/core` and `/reporter` entry points via dynamic `import()`.
- Two toolkit rules were fixed upstream to group by `connectorId` as a result
  of issue #188 (`STATUS_TRANSITION_VIOLATION`, `METER_VALUE_ANOMALY`, since
  0.4.2).

## Version policy

`@ocpp-debugkit/toolkit` is pinned to an exact version (currently `0.4.2`, no
`^` range). Detection rules can change behavior between versions, so an upgrade
is a deliberate change that re-verifies the test matrix in
`src/cli/analyze/__tests__/` — not an automatic dependency bump.

## Limits to keep in mind

- Not a conformance checker: "no known failure detected" ≠ "OCPP compliant"
  (every report carries this disclaimer).
- 1.6J only; the session timeline is transaction-focused.
