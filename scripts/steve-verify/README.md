# steve-verify

Automates the SteVe (open-source OCPP 1.6 Central System) certification-scenario
verification for this repo's 44 `cert16-*` scenario templates
(`src/utils/scenarios/README.md`). Spins up a real local SteVe CSMS, launches
the simulator against it, drives each scenario's CSMS-side operator action
(RemoteStart, Reset, TriggerMessage, ...), and asserts the expected wire
behavior from the simulator's own log plus SteVe's database.

This is a from-scratch reimplementation of a verification pass that was
previously done by hand (via agent sessions) against a real SteVe instance;
see `.superpowers/sdd/steve-verify-setup.md` and
`.superpowers/sdd/steve-verify-results-g1.md`..`g4.md` for that prior work.
The suite started as an all-bash implementation and was later rewritten as a
TypeScript runner (`runner/`) for uniqueId-correlated assertions -- see
"How it works" and "Relationship to #179" below.

## Prerequisites

- Docker (with `docker compose`)
- `git`, `curl`, `bash` 4+ -- for the environment layer (`01`/`02`/`99`)
- [`bun`](https://bun.sh) -- for the runner (`runner/main.ts`)
- Free (or overridable) local ports `18180`/`18443`/`13306` for SteVe
- [`shellcheck`](https://www.shellcheck.net/) (optional, recommended)

## Quick start

```bash
cd scripts/steve-verify
./01-setup-steve.sh          # clone + bring up a local SteVe (idempotent)
./02-provision.sh            # register charge boxes/tags/profiles (idempotent)
bun runner/main.ts run-all   # drive all 44 scenarios, print a PASS/FAIL summary
```

`run-all` sweeps every scenario sequentially by default and exits non-zero if
any FAILed or errored. Add `--parallel` to fan out up to 3 concurrently (one
per `CERTCP1`..`3`):

```bash
bun runner/main.ts run-all --parallel
```

## Running scenarios

**One scenario:**

```bash
bun runner/main.ts run cert16-tc001-cold-boot
bun runner/main.ts run cert16-tc010-remote-start --cp CERTCP2 --timeout 60
```

Flags: `--cp CP_ID` (default `CERTCP1`), `--timeout N` (overrides the spec's
default post-trigger hold time, seconds), `--connector N` (default 1).

**A group:**

```bash
bun runner/main.ts run --group core
bun runner/main.ts run --group authlist-reservation
bun runner/main.ts run --group remotetrigger-smartcharging
bun runner/main.ts run --group firmware
bun runner/main.ts run --group core --parallel
```

**Everything** (`run-all` is a thin alias for `run --group all`, matching the
retired `run-all.sh`'s own CLI):

```bash
bun runner/main.ts run-all
bun runner/main.ts run-all --parallel   # up to 3 concurrent (one per CERTCP1..3)
bun runner/main.ts run-all --parallel --retry-failed-isolated  # + isolated-retry safety net, see below
```

**Teardown:**

```bash
./99-teardown.sh              # docker compose down (DB volume kept)
./99-teardown.sh --volumes    # also drop the DB volume (loses provisioning)
```

## How results are reported

- Every scenario run (single, group, or `run-all`) writes the full captured
  simulator log to `results/<template-id>.log`, and prints a `PASS`/`FAIL`
  line per check to stdout.
- Every group/`run-all` invocation additionally renders `results/summary.md`:
  a markdown table (`scenario | cp | verdict | checks | failed`) covering
  every scenario in that run, same columns the retired bash `run-all.sh`
  produced so existing docs/screenshots referencing this format stay
  truthful. Process exit code is non-zero if any scenario FAILed or errored
  (see "Parallel lane isolation" below for how `--retry-failed-isolated`
  changes that for a `--parallel` sweep). With `--retry-failed-isolated`,
  the table gains an "isolated retry" column and a flake-count note.
- A single `bun runner/main.ts run <id>` exits 0 on PASS, 1 on FAIL (no
  `summary.md` for a single-scenario run -- that's a group-sweep artifact).
- `results/` is gitignored (reproducible from a live run, not meant to be
  committed).

Each scenario is a typed `ScenarioSpec` object (`runner/spec-types.ts`),
grouped under `runner/specs/{core,authlist-reservation,remotetrigger-smartcharging,firmware}.ts`.
A spec defines:

- `drive(ctx)` -- timed CSMS-operation calls (via `ctx.steve`, the
  `SteveClient` port of `lib.sh`'s `steve_op`) for scenarios that need
  CSMS-side action (RemoteStart, Reset, TriggerMessage, SetChargingProfile,
  ...). Omitted entirely for CP-only scenarios (e.g. TC_001, TC_003) that
  just need to be watched, not driven. Its return value is threaded into
  `assert()` as `driveState`.
- `assert(ctx)` -- checks against `ctx.frames` (every parsed OCPP-J frame,
  correlated by `uniqueId` via `findCall`/`findResponseFor` in
  `runner/ocpp.ts`), `ctx.lines` (raw log lines, for lifecycle/absence
  checks), and `ctx.db` (SQL against SteVe's DB, `runner/steve.ts`'s
  `SteveDb`) where a transaction or reservation is expected. See
  `runner/specs/core.ts`'s `cert16-tc003-charging-plugin-first` and
  `cert16-tc026-remote-start-rejected` entries for worked examples
  (self-driven with DB assertions; CSMS-driven with a uniqueId-correlated
  response-status assertion).

Specs are intentionally simple: they assert the load-bearing facts a
certification reviewer would actually check (StopTransaction reason,
CALLRESULT status, `listVersion`, firmware status trains, ...), not every
byte on the wire.

## How it works

Each scenario run launches an attached simulator process on SteVe's own
`steve_default` docker network (`runner/sim.ts`'s `startSim`, a port of
`lib.sh`'s `sim_start` that spawns `docker run -i` directly instead of via
an intermediate feeder shell script -- Bun's attached `Bun.spawn` gives the
driver real timing control over stdin, so no bind-mounted feeder is
needed). It runs the simulator CLI in JSON-Lines mode (`--json`):
`connect` -> wait for the actual `BootNotification.conf` line on the wire
(bounded, warn-and-continue on timeout) -> the spec's `bootWaitSecs` settle
on top -> the `run_scenario_template` command -> hold open long enough for
the scenario (plus any CSMS-side drive steps) to finish, then stop the
container.

Once the run finishes, the full captured stdout is parsed into typed OCPP-J
frames (`runner/ocpp.ts`) and each request is paired to its response by
OCPP-J `uniqueId` -- not by "next CALLRESULT within N lines of the request"
(the retired bash suite's `check_response_status`/`check_sent_result`
window-scan), which could pick up the wrong CALLRESULT when other traffic
(a StatusNotification, a second concurrent op, ...) was interleaved on the
wire between a request and its own response. `assert()` then runs against
those correlated frames plus SteVe's DB.

## Parallel lane isolation

`--parallel` runs up to 3 scenarios concurrently, one per `CERTCP1`..`3`, all
inside a single `bun` process (`Promise.all` over one batch, not separate
child processes). Investigation for issue #184 Finding 4 (juherr's
independent SteVe pre-prod run saw 5 parallel-only false-negative FAILs --
`tc021`/`tc043-3`/`tc043-5`/`reservation-basic`/`tc054` -- that all PASSed
run in isolation) found:

- **Not session/CSRF contamination.** `SteveClient` (`runner/steve.ts`) holds
  its cookie jar as an instance field (a plain `Map`), and `runScenario()`
  constructs a fresh `SteveClient`/`SteveDb` per call -- each parallel lane
  already gets its own jar, never shared. Confirmed live: three concurrent
  `admin` logins against a running SteVe 3.13.0 all stayed valid
  simultaneously (no single-session-per-user eviction).
- **Not cross-CP DB query contamination.** Every `SteveDb` lookup used by a
  spec's `assert()` (`latestTxPk`, `latestOpenTxPk`, `latestReservationPk`,
  `waitActiveTxPk`) filters by `charge_box_id`, so two lanes on different
  CPs can't read each other's transaction/reservation row.
- **Working hypothesis: fixed-timing races under host contention.** All 5
  flaky scenarios share one shape: a SteVe-initiated async CSMS push
  (`steve.op()` -- ChangeConfiguration/SendLocalList/ReserveNow/
  TriggerMessage) whose `assert()` reads a wire-log snapshot frozen after a
  **fixed** `holdSecs` sleep (`runScenario()` in `runner/main.ts`). Under
  3-way parallel docker+JVM+DB host contention, SteVe's actual push to the
  CP can arrive later than under no contention; if it lands after that fixed
  window, the assert finds nothing and reports a false FAIL. This is the
  same class of race already called out in `runScenario()`'s own comment for
  `bootWaitSecs`/`BootNotification.conf` timing under `--parallel`, just
  hitting a different fixed wait. Not yet proven with a captured
  reproduction under load; the REST-driver migration (issue #184 Task 2,
  stateless Basic auth, no cookie/session at all) may also change this
  timing profile enough to matter, one way or the other -- worth
  re-evaluating once that lands.
- **Sequential is the reliable reporting mode** until lane isolation is
  guaranteed. `bun runner/main.ts run-all` (no `--parallel`) is the verdict
  to trust for a final sign-off.

For a faster loop that still gets a trustworthy verdict, pass
`--retry-failed-isolated` alongside `--parallel`: after the parallel sweep,
every scenario whose PARALLEL verdict was not PASS is re-run once more,
sequentially (no concurrent lane), on the same SteVe/DB. `results/summary.md`
gets an extra "isolated retry" column and a flake-count note; the runner logs
`FLAKE` (parallel FAIL/ERROR, isolated PASS) or `CONFIRMED` (fails isolated
too) for each retried scenario. The sweep's exit code only fails on a
CONFIRMED non-PASS -- a resolved flake does not fail the run. This is a
safety net, not a fix: it does not address the underlying timing race, and a
scenario that is flaky in a way the isolated retry also hits (e.g. host is
generally overloaded, not just parallel-contended) will still show
CONFIRMED. The flag has no effect without `--parallel` (a sequential sweep
is already isolated).

## Environment / configuration

Everything is env-overridable. The bash environment layer (`01`/`02`/`99`,
via `lib.sh`) and the TypeScript runner read the **same variable names**
independently (the runner does not source `lib.sh`; it reads `process.env`
directly in `runner/steve.ts`/`runner/sim.ts`), so setting one in your shell
before running either layer keeps them in sync.

| Variable                                  | Default                                               | Used by            | Purpose                              |
| ----------------------------------------- | ----------------------------------------------------- | ------------------ | ------------------------------------ |
| `STEVE_REPO_DIR`                          | `~/git/steve`                                         | `01`/`99`          | Local SteVe checkout                 |
| `STEVE_REPO_URL`                          | `github.com/steve-community/steve.git`                | `01`               | SteVe git remote                     |
| `STEVE_APP_HOST_PORT` / `..._TLS_PORT`    | `18180` / `18443`                                     | `01`, runner       | Host port remap (avoid conflicts)    |
| `STEVE_DB_HOST_PORT`                      | `13306`                                               | `01`               | Host port remap (avoid conflicts)    |
| `STEVE_URL`                               | `http://localhost:18180/steve/manager`                | `01`, `02`, runner | Manager UI base URL                  |
| `STEVE_USER` / `STEVE_PASS`               | `admin` / `1234`                                      | `02`, runner       | Manager UI login                     |
| `STEVE_NETWORK`                           | `steve_default`                                       | `01`, runner       | docker network the sim joins         |
| `STEVE_DB_CONTAINER`                      | `steve-db-1`                                          | `02`, runner       | Container name for `docker exec`     |
| `STEVE_DB_USER` / `..._PASS` / `..._NAME` | `steve` / `changeme` / `stevedb`                      | `02`, runner       | DB credentials                       |
| `SIM_IMAGE`                               | `oven/bun:1.3-alpine`                                 | runner             | Simulator container image            |
| `SIM_WS_URL`                              | `ws://app:8180/steve/websocket/CentralSystemService/` | runner             | CSMS WebSocket URL (docker-internal) |
| `DEFAULT_CP_ID`                           | `CERTCP1`                                             | runner             | `run`'s default `--cp`               |

The port defaults deliberately avoid `3306`/`8180` -- common local
collisions (an existing MySQL/MariaDB or an SSH tunnel) on developer
machines; override if `18180`/`18443`/`13306` are also taken.

## Known limitations (honest)

- **Not a full protocol conformance suite.** Specs assert the specific
  wire/DB facts each `cert16-*` scenario's README description calls out --
  they do not validate every field of every OCPP message, nor exercise
  negative/malformed-input paths beyond what the scenario itself encodes.
- **Mostly timing-based, not fully event-driven.** Most `drive()` functions
  still use fixed sleeps tuned against this environment's (fast, local)
  round-trip times, mirroring the retired bash suite's approach. A much
  slower/loaded environment could need larger `bootWaitSecs`/`holdSecs`
  values in the affected spec objects, or `--timeout` on the command line.
  A few completion barriers where a fixed sleep previously raced a real
  dependency (SetChargingProfile actually applying before TC_066/TC_067's
  second op; a transaction row actually existing before TC_028/TC_057's
  DB-driven follow-up) poll instead (`sim.waitForLine`/`SteveDb.waitActiveTxPk`).
- **Shared idTag pool under heavy `--parallel` use.** Several specs use a
  fixed tag (e.g. `CERT-TAG-1`) for CSMS-initiated ops rather than deriving
  a per-CP tag; `max_active_transaction_count=5` gives headroom for the
  default 3-way `--parallel` fan-out, but running many groups in parallel
  simultaneously could contend.
- **`--parallel` lanes are not fully isolated (issue #184 Finding 4).**
  See "Parallel lane isolation" above -- sequential is the reliable
  reporting mode; `--retry-failed-isolated` is a safety net, not a fix.
- **SteVe-specific.** Response statuses that are SteVe's own policy rather
  than CP behavior (e.g. TC_064's DataTransfer response status) are asserted
  loosely (a response was received) rather than pinned to a specific status.
- **`SendLocalList` idempotency quirk.** SteVe's `updateType=FULL` sends its
  _entire_ known `ocpp_tag` table back to the CP regardless of which single
  tag is selected in the form (`updateType=DIFFERENTIAL` respects the
  selection) -- noted in the TC_043.4/.5 specs, not a defect in this suite.
- **No CI wiring.** This suite needs a real Docker daemon and several
  minutes for SteVe's first-boot Maven build; it is meant to be run
  on-demand by a developer/agent doing certification sign-off, not as part
  of the repo's automated CI.
- **`shellcheck` is optional.** If it isn't installed, `01`-`99` and
  `lib.sh` still work; re-run with it installed for the extra lint pass.

## Relationship to #179

This runner's expectations/verdicts/reports are an **external harness**
today: it drives the simulator as a black box over its existing CLI/JSON
protocol and asserts against wire logs it parses itself, entirely outside
the simulator's own codebase. Issue #179 tracks productizing equivalent
capabilities (typed scenario expectations, correlated request/response
assertions, structured verdicts) as part of the simulator's own RPC API.
This runner's assertion model (`runner/assert.ts`'s `AssertRecorder`,
`runner/ocpp.ts`'s uniqueId-correlated frame pairing) is intentionally
shaped to be portable onto that API once it exists, rather than deepening
its own log-scraping.

## Directory layout

```
scripts/steve-verify/
  README.md
  lib.sh                    # bash environment-layer helpers (config, db, steve_login)
  01-setup-steve.sh          # clone/refresh SteVe, apply compose edits, bring up
  02-provision.sh            # charge boxes, tags, charging profiles, stale-tx cleanup
  99-teardown.sh              # compose down (+ optional volume wipe)
  runner/                    # TypeScript runner (bun)
    main.ts                   # CLI: run/run-all, groups, --parallel, --retry-failed-isolated, summary writer
    sim.ts                     # docker-spawned simulator process (JSON-Lines stdin)
    ocpp.ts                     # OCPP-J frame parser + uniqueId correlation
    steve.ts                     # SteVe manager-UI login/ops + DB access
    assert.ts                     # typed assertion DSL (AssertRecorder)
    spec-types.ts                  # ScenarioSpec/DriveContext/AssertContext shapes
    specs/
      core.ts                      # 15 scenarios
      authlist-reservation.ts       # 13 scenarios
      remotetrigger-smartcharging.ts # 12 scenarios
      firmware.ts                    # 4 scenarios
    __tests__/                 # pure unit tests (bun test; also picked up by
                                # npm run test:bun's "bun.test" filter)
  results/                    # gitignored: per-scenario logs + summary.md
```
