---
title: "Source: e2e/README.md (simulator ↔ gocpp CSMS)"
type: source
summary: Local-only end-to-end suite that runs the simulator as a real charge point against a Go CSMS fixture built with gocpp, across OCPP 1.6 / 2.0.1 / 2.1.
sources:
  - e2e/README.md
  - e2e/*.gocpp.e2e.ts
  - e2e/csms/ (Go fixture)
related:
  - ../entities/csms-peers.md
  - ../analyses/testing-strategy.md
  - ../concepts/ocpp-versions-and-transports.md
  - example-scenarios.md
updated: 2026-09-03
---

# Source: `e2e/README.md`

**Purpose.** Validate the simulator's multi-version wire output against an
independent implementation ([gocpp](../entities/csms-peers.md#gocpp)) and its
inbound handling via CSMS-initiated commands. Everything is real: WebSocket,
CP, CSMS.

**Run.** `bun run test:e2e` builds the Go CSMS fixture once, then runs
`e2e/ocpp16.gocpp.e2e.ts`, `e2e/ocpp201.gocpp.e2e.ts` and
`e2e/ocpp21.gocpp.e2e.ts`; run a single suite with
`bun test ./e2e/ocpp201.gocpp.e2e.ts`. `e2e/comprehensive.gocpp.e2e.ts` runs
`docs/examples/scenarios/all-cases.json` under every version.

**Requirements (local-only).** Go 1.26+ on PATH; the gocpp repo checked out as
a sibling (`../gocpp`, wired via a `replace` directive); Bun. CI does not
provision these, so the suites are excluded from the default `test` /
`test:vitest` scripts and from the `tsc -b` build graph.

**Layout.**

- `csms/` — one Go binary, `--version=1.6|2.0.1|2.1`; records every received
  frame as NDJSON to stdout after an `E2E_CSMS_PORTS` sentinel line; exposes
  `GET /healthz` and a typed `POST /command` for CSMS→CP actions. Built to
  `csms/e2e-csms` (gitignored).
- `support/gocppCsms.ts` — spawns/drains the fixture, parses ports, polls
  health, exposes `frames` / `command()` / `stop()`, cleans up (no orphans).
- `support/frameLog.ts` — `waitForCall` / `waitForFrame` over recorded frames.
- `support/buildCsms.ts` — builds the Go binary.
- `ocpp16|201|21.gocpp.e2e.ts` — per-version suites, driven in-process via
  `ChargePoint`, asserting on the CSMS frame log + CP state.
