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

This builds the Go CSMS fixture once, then runs the suites listed in the
`test:e2e` script of `package.json`: the per-version suites
(`e2e/ocpp16.gocpp.e2e.ts`, `e2e/ocpp201.gocpp.e2e.ts`, `e2e/ocpp21.gocpp.e2e.ts`),
`e2e/chargingProfile.gocpp.e2e.ts` (OCPP 1.6 smart charging),
`e2e/scenario.gocpp.e2e.ts` and `e2e/comprehensive.gocpp.e2e.ts`.
Run a single suite with `bun test ./e2e/ocpp201.gocpp.e2e.ts`.

## Requirements (local-only)

- **Go 1.26+** on PATH (the CSMS fixture is a Go program), and network access
  to the Go module proxy on the first build.
- **Bun** (already required by the repo).

The gocpp revision the fixture is measured against is **pinned** in
`csms/go.mod` (`require github.com/shiv3/gocpp v0.1.7`) and checksummed in
`csms/go.sum`, so every machine builds against the same oracle and a pass is
reproducible (#322). No sibling checkout is needed or consulted — an earlier
`replace github.com/shiv3/gocpp => ../../../gocpp` made whatever happened to be
in `../gocpp` the oracle, unrecorded. To move the pin:

```sh
cd e2e/csms && go get github.com/shiv3/gocpp@v0.1.8 && go mod tidy
```

then run the suites and commit `go.mod` + `go.sum` together. If `go` is missing,
`support/buildCsms.ts` says so instead of failing with an ENOENT stack.

CI does not yet provision Go, so these tests are **local-only** for now; they are
excluded from the default `test` / `test:vitest` scripts and from the `tsc -b`
build graph. With the sibling gone, a CI job is now only a `setup-go` step away.

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
- `chargingProfile.gocpp.e2e.ts` — OCPP 1.6 smart charging: a 6 A
  `SetChargingProfile` on a 230 V / 3-phase / cos φ 0.9 connector reaches the
  CSMS as `Power.Active.Import` 3726 W (1242 W with `numberPhases: 1`) and
  `Current.Import` 6.0 A; `ClearChargingProfile` lifts it; `GetCompositeSchedule`
  returns the limit and `numberPhases` the profile was set with (#323).

## CSMS→CP actions

`POST /command` takes `{ "cpId", "action", ...fields }`, the fields named as in
the OCPP request, and returns `{ "ok", "result", "error" }` with the CP's
response as `result`. Actions per `--version`
(`csms/command.go`):

- **1.6** — `RemoteStartTransaction`, `RemoteStopTransaction`, `Reset`,
  `ReserveNow`, `CancelReservation`, `SetChargingProfile`,
  `ClearChargingProfile`, `GetCompositeSchedule`.
- **2.0.1** — `RequestStartTransaction`, `RequestStopTransaction`, `Reset`,
  `ChangeAvailability`, `TriggerMessage`, `UnlockConnector`, `GetVariables`,
  `SetVariables`, `GetBaseReport`, `ReserveNow`.
- **2.1** — `RequestStartTransaction`, `RequestStopTransaction`,
  `UsePriorityCharging`, `ReserveNow`.

Any other action, sent to a connected CP, answers `ok: false` with an
`unsupported <version> action` error. The
fixture sends decimals (a schedule's `limit`) as JSON numbers.
