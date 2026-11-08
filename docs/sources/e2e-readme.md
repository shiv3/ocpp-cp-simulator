---
title: "Source: e2e/README.md (simulator ↔ gocpp CSMS)"
type: source
summary: End-to-end suite (weekly in CI, #624) that runs the simulator as a real charge point against a Go CSMS fixture built with gocpp, across OCPP 1.6 / 2.0.1 / 2.1.
sources:
  - e2e/README.md
  - e2e/*.gocpp.e2e.ts
  - e2e/csms/ (Go fixture)
related:
  - ../entities/csms-peers.md
  - ../analyses/testing-strategy.md
  - ../concepts/ocpp-versions-and-transports.md
  - example-scenarios.md
updated: 2026-11-08
---

# Source: `e2e/README.md`

**Purpose.** Validate the simulator's multi-version wire output against an
independent implementation ([gocpp](../entities/csms-peers.md#gocpp)) and its
inbound handling via CSMS-initiated commands. Everything is real: WebSocket,
CP, CSMS.

**Run.** `bun run test:e2e` builds the Go CSMS fixture once, then runs seven
suites: `e2e/ocpp16.gocpp.e2e.ts`, `e2e/chargingProfile.gocpp.e2e.ts`,
`e2e/ocpp201.gocpp.e2e.ts`, `e2e/ocpp21.gocpp.e2e.ts`,
`e2e/scenario.gocpp.e2e.ts`, `e2e/comprehensive.gocpp.e2e.ts` (runs
`docs/examples/scenarios/all-cases.json` under every version) and
`e2e/behavior.gocpp.e2e.ts` (negative paths, below). Run a
single suite with `bun test ./e2e/ocpp201.gocpp.e2e.ts`.

**Requirements.** Go 1.26+ on PATH and network access to the
Go module proxy on the first build; Bun. The gocpp revision is **pinned** in
`e2e/csms/go.mod` (`github.com/shiv3/gocpp v0.1.7`) and checksummed in
`go.sum` (#322) — no sibling checkout; the earlier `replace` to `../gocpp`
made an unrecorded working copy the oracle. Move the pin with
`go get github.com/shiv3/gocpp@<tag> && go mod tidy` in `e2e/csms`. The suites are
excluded from `test`, `test:vitest`, the `tsc -b` graph and the pull-request
CI. The `.github/workflows/e2e.yml` workflow runs them Mondays 03:17 UTC and on
demand, with Go from `csms/go.mod` and the fixture's own `lint:e2e-csms` /
`test:e2e-csms` first; a failed run uploads the `e2e-traces` artifact (30
days), written by `support/gocppCsms.ts` when `E2E_TRACE_DIR` is set: per
fixture process the received frames as NDJSON and its stderr.

**Layout.**

- `csms/` — one Go binary, `--version=1.6|2.0.1|2.1`; records every received
  frame as NDJSON to stdout after an `E2E_CSMS_PORTS` sentinel line; exposes
  `GET /healthz`, a typed `POST /command` for CSMS→CP actions, and the
  switches below. Built to `csms/e2e-csms` (gitignored). Has its own Go unit
  tests.
- `support/gocppCsms.ts` — spawns/drains the fixture, parses ports, polls
  health, exposes `frames` / `command()` / `stop()`, cleans up (no orphans).
- `support/frameLog.ts` — `waitForCall` / `waitForFrame` over recorded frames.
- `support/buildCsms.ts` — builds the Go binary.
- `ocpp16|201|21.gocpp.e2e.ts` — per-version suites, driven in-process via
  `ChargePoint`, asserting on the CSMS frame log + CP state.
- `chargingProfile.gocpp.e2e.ts` — OCPP 1.6 smart charging (#323): a 6 A
  `SetChargingProfile` on an AC 230 V / 3-phase / cos φ 0.9 connector reaches
  the CSMS as `Power.Active.Import` 3726 W and `Current.Import` 6.0 A (1242 W
  and 6.0 A with `numberPhases: 1`); `ClearChargingProfile` lifts the cap;
  `GetCompositeSchedule` returns the profile's limit and `numberPhases`.

**Switchable behavior (#623).** `POST /behavior` (`GET` reads, `DELETE`
resets; `setBehavior()` in `support/gocppCsms.ts`) sets a BootNotification
answer sequence per charge point (`boot: ["Pending","Pending","Accepted"]`,
last repeats, `bootIntervalSeconds`) and a `mode`: `accept-all` (default),
`whitelist` (unlisted tag: `Invalid` in 1.6, `Unknown` in 2.x), `blacklist`
and `rate-limit` (`Blocked`; `rateMax` requests per idTag in `rateWindowMs`),
or `offline` (drops open connections, answers upgrades 503). `POST /sequence`
runs commands in order with `delayMs`, optionally every `periodMs`, `repeat`
rounds; `GET` shows results, `DELETE` stops. The default wire output is
unchanged. Field tables are in `e2e/README.md`; `behavior.gocpp.e2e.ts` covers
Pending to Accepted, authorization rejection, rate limiting, offline with
reconnect, and a delayed sequence under 1.6 and 2.0.1.

**CSMS→CP actions** (`e2e/csms/command.go`, listed in the README):

- 1.6 — `RemoteStartTransaction`, `RemoteStopTransaction`, `Reset`,
  `ReserveNow`, `CancelReservation`, `SetChargingProfile`,
  `ClearChargingProfile`, `GetCompositeSchedule` (the last three since #323).
- 2.0.1 — `RequestStartTransaction`, `RequestStopTransaction`, `Reset`,
  `ChangeAvailability`, `TriggerMessage`, `UnlockConnector`, `GetVariables`,
  `SetVariables`, `GetBaseReport`, `ReserveNow`.
- 2.1 — `RequestStartTransaction`, `RequestStopTransaction`,
  `UsePriorityCharging`, `ReserveNow`.

Any other action returns `ok: false` with an `unsupported <version> action`
error. The fixture marshals decimals (a schedule's `limit`) as JSON numbers;
shopspring/decimal's default quoted string fails the simulator's 1.6 schema
validation.
