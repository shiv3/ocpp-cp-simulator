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
`e2e/scenario.gocpp.e2e.ts`, `e2e/comprehensive.gocpp.e2e.ts`,
`e2e/behavior.gocpp.e2e.ts` (the negative paths, below) and `e2e/daemonShutdown.gocpp.e2e.ts` (a real daemon process: `StopTransaction` on SIGTERM with `--shutdown-stop-transactions`, `--no-connect-restored`; #622).
Run a single suite with `bun test ./e2e/ocpp201.gocpp.e2e.ts`.

## Requirements

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

The suites are excluded from the default `test` / `test:vitest` scripts and
from the `tsc -b` build graph, and the pull-request CI does not run them. The
[`E2E` workflow](../.github/workflows/e2e.yml) does, every Monday at 03:17 UTC
and on demand from the Actions tab (#624): it sets up Go from
`csms/go.mod`, runs the fixture's lint and unit tests and then
`bun run test:e2e`, against the pinned gocpp. When a run fails it uploads the
`e2e-traces` artifact (30 days): with `E2E_TRACE_DIR` set,
`support/gocppCsms.ts` writes, for every fixture process,
`csms-<version>-<pid>-<n>.ndjson` (the frames in the order the CSMS received
them) and `.stderr.log`. Set the variable locally to get the same files.

The fixture has its own checks, runnable without Bun's e2e suites or a
simulator: `bun run lint:e2e-csms` (`gofmt` and `go vet`) and
`bun run test:e2e-csms` (`go test -race`). Started alone,
`e2e/csms/e2e-csms --version=1.6` prints the `E2E_CSMS_PORTS` line and serves
the endpoints below on 127.0.0.1.

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

## Switchable CSMS behavior (#623)

By default the fixture answers Accepted to BootNotification, Authorize and the
idTag of a transaction. `POST /behavior` (a JSON body; an unknown field or an
invalid value is a 400 and changes nothing) switches that at run time;
`GET /behavior` reads the state and `DELETE /behavior` restores the defaults.
`support/gocppCsms.ts` wraps them as `setBehavior()` / `resetBehavior()`.

| Field                     | Meaning                                                                                                                                                                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boot`                    | BootNotification statuses (`Accepted`, `Pending`, `Rejected`) answered in order, per charge point id; the last one repeats. Setting it restarts every charge point at the first entry.                                                                                |
| `bootIntervalSeconds`     | The `interval` of every BootNotification answer (default 300, at least 1).                                                                                                                                                                                            |
| `mode`                    | `accept-all` (default), `whitelist`, `blacklist`, `rate-limit` or `offline`.                                                                                                                                                                                          |
| `idTags`                  | The tags of the whitelist or blacklist.                                                                                                                                                                                                                               |
| `rateMax`, `rateWindowMs` | `rate-limit`: one idTag may make `rateMax` authorization requests (default 1) in a sliding window of `rateWindowMs` (default 60000); further ones are answered `Blocked`. Authorize and the idTag of a StartTransaction / TransactionEvent each count as one request. |

Authorization verdicts: `whitelist` answers a tag it does not list `Invalid`
(1.6) / `Unknown` (2.x); `blacklist` and `rate-limit` answer `Blocked`. Under
2.x the idTokenInfo of a TransactionEvent answer is added only while a mode
other than `accept-all` is set, so the default wire output is unchanged.
`offline` is not an authorization policy: it drops every open OCPP connection
and answers a new WebSocket upgrade 503 until another mode is set, which is
what a CSMS outage looks like to the simulator. The control endpoints stay up.

`POST /sequence` runs CSMS→CP commands in the background:
`{ "steps": [{ "delayMs": 400, "command": { "cpId": "…", "action": "…" } }], "periodMs": 5000, "repeat": 3 }`.
Each step waits `delayMs` after the previous one, and the `command` is the
body `POST /command` takes. With `periodMs` the whole sequence restarts that
long after the previous round began, `repeat` rounds in total (0 = until
stopped; `repeat` above 1 needs `periodMs`). The answer is `{ "id" }`;
`GET /sequence` lists every run with the result of each step sent so far and
`DELETE /sequence` stops all runs. Wrapped as `startSequence()` /
`sequences()` / `stopSequences()`.

`behavior.gocpp.e2e.ts` covers, under 1.6 and 2.0.1: Pending, Pending,
Accepted (the station sends nothing but BootNotification meanwhile — 1.6
§4.2 / 2.0.1 B02), whitelist and blacklist rejection, rate limiting, and the
offline drop and reconnect; and a delayed command sequence. It resets the
behavior after each test.

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
