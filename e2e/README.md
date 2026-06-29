# End-to-end tests — simulator (CP) ↔ gocpp CSMS

These tests drive the simulator as a **real charge point** over a **real WebSocket**
against a **real Central System (CSMS) built with [gocpp](https://github.com/shiv3/gocpp)**,
across OCPP **1.6 / 2.0.1 / 2.1**. They validate the simulator's multi-version wire
output against an independent implementation, and its inbound handling via
CSMS-initiated commands.

## Run

```sh
bun run test:e2e
```

This builds the Go CSMS fixture once, then runs all three suites
(`e2e/ocpp16.gocpp.e2e.ts`, `e2e/ocpp201.gocpp.e2e.ts`, `e2e/ocpp21.gocpp.e2e.ts`).
Run a single suite with `bun test ./e2e/ocpp201.gocpp.e2e.ts`.

## Requirements (local-only)

- **Go 1.26+** on PATH (the CSMS fixture is a Go program).
- The **gocpp repo checked out as a sibling** of this repo: `../gocpp`
  (the fixture's `go.mod` uses `replace github.com/shiv3/gocpp => ../../../gocpp`).
- **Bun** (already required by the repo).

CI does not yet provision Go + the sibling checkout, so these tests are
**local-only** for now; they are excluded from the default `test` / `test:vitest`
scripts and from the `tsc -b` build graph.

## Layout

- `csms/` — the Go CSMS fixture. One binary, `--version=1.6|2.0.1|2.1`: one
  `csms.Server` per process, records every received frame as NDJSON to stdout
  (after an `E2E_CSMS_PORTS` sentinel line), and exposes `GET /healthz` +
  a typed `POST /command` for CSMS→CP actions. Built to `csms/e2e-csms` (gitignored).
- `support/gocppCsms.ts` — spawns/drains the fixture, parses ports, polls health,
  exposes `frames` / `command()` / `stop()`; cleans up (no orphans).
- `support/frameLog.ts` — accumulates recorded frames; `waitForCall` / `waitForFrame`.
- `support/buildCsms.ts` — builds the Go binary.
- `ocpp16|201|21.gocpp.e2e.ts` — the per-version suites (driven in-process via
  `ChargePoint`, asserting on the CSMS frame log + CP state).
