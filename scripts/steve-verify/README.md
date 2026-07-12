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

## Prerequisites

- Docker (with `docker compose`)
- `git`, `curl`, `bash` 4+
- Free (or overridable) local ports `18180`/`18443`/`13306` for SteVe
- [`shellcheck`](https://www.shellcheck.net/) (optional, recommended)

## Quick start

```bash
cd scripts/steve-verify
./01-setup-steve.sh          # clone + bring up a local SteVe (idempotent)
./02-provision.sh            # register charge boxes/tags/profiles (idempotent)
./run-scenario.sh cert16-tc001-cold-boot
```

That's it -- the third command drives one scenario end-to-end against the
live SteVe instance and prints a PASS/FAIL verdict.

## Running scenarios

**One scenario:**

```bash
./run-scenario.sh cert16-tc010-remote-start
./run-scenario.sh cert16-tc010-remote-start --cp CERTCP2 --timeout 60
```

**A group:**

```bash
./run-all.sh --group core
./run-all.sh --group authlist-reservation
./run-all.sh --group remotetrigger-smartcharging
./run-all.sh --group firmware
```

**Everything:**

```bash
./run-all.sh --group all
./run-all.sh --group all --parallel   # up to 3 concurrent (one per CERTCP1..3)
```

**Teardown:**

```bash
./99-teardown.sh              # docker compose down (DB volume kept)
./99-teardown.sh --volumes    # also drop the DB volume (loses provisioning)
```

## How results are reported

- `run-scenario.sh` prints a `PASS`/`FAIL` verdict line to stderr, writes the
  full simulator log to `results/<template-id>.log`, and writes a small
  key=value summary to `results/<template-id>.result`. Exit code is 0 on
  PASS, 1 on FAIL (or any setup error).
- `run-all.sh` runs a whole group through `run-scenario.sh`, then renders a
  markdown table from every `.result` file into `results/summary.md`. It
  exits non-zero if any scenario in the group FAILed or errored.
- `results/` is gitignored (reproducible from a live run, not meant to be
  committed).

Each scenario is a small "spec" file at `specs/<template-id>.spec.sh`,
sourced by `run-scenario.sh`. A spec defines two bash functions:

- `drive()` -- timed `steve_op` (CSMS-operation) calls for scenarios that
  need CSMS-side action (RemoteStart, Reset, TriggerMessage, SetChargingProfile,
  ...). Omitted entirely for CP-only scenarios (e.g. TC_001, TC_003) that
  just need to be watched, not driven.
- `assert(log_file)` -- grep-based checks against the simulator's wire log
  (`check_log_contains`, `check_log_order`, `check_response_status`, ...) and
  SQL checks against SteVe's DB (`check_db_eq`, `check_db_nonempty`) where a
  transaction or reservation is expected. See `lib.sh` for the full helper
  list and `specs/cert16-tc003-charging-plugin-first.spec.sh` /
  `specs/cert16-tc026-remote-start-rejected.spec.sh` for worked examples
  (self-driven with DB assertions; CSMS-driven with a response-override
  assertion).

Specs are intentionally simple: they assert the load-bearing lines a
certification reviewer would actually check (StopTransaction reason,
CALLRESULT status, `listVersion`, firmware status trains, ...), not every
byte on the wire.

## How it works

Each scenario run launches a detached simulator container on SteVe's own
`steve_default` docker network (`lib.sh`'s `sim_start`), using the
**post-boot stdin method**: `connect` -> sleep past `BootNotification.conf`
-> the `run_scenario_template` JSON-mode command -> hold open long enough
for the scenario (plus any CSMS-side drive steps) to finish. This sidesteps
a known CLI-invocation race where `--scenario-template`-at-startup can fire
before `BootNotification` is accepted (see
`.superpowers/sdd/steve-verify-results-g1.md`'s "Invocation correction" and
"TC_005 re-verification" sections) -- using the stdin command after the
connection is already up avoids it entirely, independent of which fixes for
that race are present on whatever branch this suite runs on.

`run-scenario.sh` waits for `Scenario execution started` in the container
log, runs the spec's `drive()` (if any) against the live SteVe manager UI
(`steve_op`, folded in from the repo's `.steve-op.sh` prototype), waits for
the container to exit on its own (bounded), captures the full log, then runs
the spec's `assert()`.

## Environment / configuration

Everything is env-overridable (see `lib.sh` for the full list and defaults):

| Variable                                   | Default                                | Purpose                            |
| ------------------------------------------ | -------------------------------------- | ---------------------------------- |
| `STEVE_REPO_DIR`                           | `~/git/steve`                          | Local SteVe checkout               |
| `STEVE_URL`                                | `http://localhost:18180/steve/manager` | Manager UI base URL                |
| `STEVE_APP_HOST_PORT` / `..._TLS_PORT`     | `18180` / `18443`                      | Host port remap (avoid conflicts)  |
| `STEVE_DB_HOST_PORT`                       | `13306`                                | Host port remap (avoid conflicts)  |
| `STEVE_NETWORK`                            | `steve_default`                        | docker network the sim joins       |
| `STEVE_APP_CONTAINER` / `..._DB_CONTAINER` | `steve-app-1` / `steve-db-1`           | Container names for exec/logs      |
| `STEVE_DB_USER` / `..._PASS` / `..._NAME`  | `steve` / `changeme` / `stevedb`       | DB credentials                     |
| `SIM_IMAGE`                                | `oven/bun:1.3-alpine`                  | Simulator container image          |
| `DEFAULT_CP_ID`                            | `CERTCP1`                              | `run-scenario.sh`'s default `--cp` |

The port defaults deliberately avoid `3306`/`8180` -- common local
collisions (an existing MySQL/MariaDB or an SSH tunnel) on developer
machines; override if `18180`/`18443`/`13306` are also taken.

## Known limitations (honest)

- **Not a full protocol conformance suite.** Specs assert the specific
  wire/DB facts each `cert16-*` scenario's README description calls out --
  they do not validate every field of every OCPP message, nor exercise
  negative/malformed-input paths beyond what the scenario itself encodes.
- **Mostly timing-based, not event-driven.** Most `drive()` functions still
  use fixed `sleep`s tuned against this environment's (fast, local)
  round-trip times, mirroring the manual verification sessions' approach.
  A much slower/loaded environment could need larger
  `SPEC_BOOT_WAIT`/`SPEC_HOLD_SECS` values in the affected spec files, or
  `--timeout` on the command line. A few completion barriers where a fixed
  sleep previously raced a real dependency (SetChargingProfile actually
  applying before TC_066/TC_067's second op; a transaction/reservation row
  actually existing before TC_028/TC_051/TC_057's DB-driven follow-up) now
  poll (`sim_wait_log`/`wait_for_condition`/`db_wait_active_tx_pk`) instead.
- **Per-process session state (fixed).** `STEVE_JAR` (the login cookie
  jar) and `steve_op()`'s scratch response file are generated per-process
  (PID-suffixed / `mktemp`) rather than shared fixed `/tmp` paths, so
  concurrent `run-scenario.sh` processes under `--parallel` no longer race
  on the same session/CSRF state.
- **Shared idTag pool under heavy `--parallel` use.** Several specs use a
  fixed tag (e.g. `CERT-TAG-1`) for CSMS-initiated ops rather than deriving
  a per-CP tag; `max_active_transaction_count=5` gives headroom for the
  default 3-way `--parallel` fan-out, but running many groups in parallel
  simultaneously could contend. (This is the remaining `--parallel`
  caveat now that session state above is per-process.)
- **SteVe-specific.** Response statuses that are SteVe's own policy rather
  than CP behavior (e.g. TC_064's DataTransfer response status) are asserted
  loosely (a response was received) rather than pinned to a specific status.
- **`SendLocalList` idempotency quirk.** SteVe's `updateType=FULL` sends its
  _entire_ known `ocpp_tag` table back to the CP regardless of which single
  tag is selected in the form (`updateType=DIFFERENTIAL` respects the
  selection) -- noted in TC_043.4/.5 specs, not a defect in this suite.
- **No CI wiring.** This suite needs a real Docker daemon and several
  minutes for SteVe's first-boot Maven build; it is meant to be run
  on-demand by a developer/agent doing certification sign-off, not as part
  of the repo's automated CI.
- **`shellcheck` is optional.** If it isn't installed, `01`-`99` and
  `lib.sh` still work; re-run with it installed for the extra lint pass.

## Directory layout

```
scripts/steve-verify/
  README.md
  lib.sh                  # shared helpers (config, db, steve_op, sim_*, check_*)
  01-setup-steve.sh        # clone/refresh SteVe, apply compose edits, bring up
  02-provision.sh          # charge boxes, tags, charging profiles, stale-tx cleanup
  run-scenario.sh           # run one scenario end-to-end
  run-all.sh                 # sweep a group, emit results/summary.md
  99-teardown.sh            # compose down (+ optional volume wipe)
  specs/
    cert16-tc001-cold-boot.spec.sh
    ... (44 total, one per src/utils/scenarios/cert16-*.json)
  results/                 # gitignored: per-scenario logs + summary.md
```
