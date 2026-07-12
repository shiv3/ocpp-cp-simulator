# steve-verify

Automates the SteVe (open-source OCPP 1.6 Central System) certification-scenario
verification for this repo's 44 `cert16-*` scenario templates
(`src/utils/scenarios/README.md`). Spins up a real local SteVe CSMS, launches
the simulator against it, drives each scenario's CSMS-side operator action
(RemoteStart, Reset, TriggerMessage, ...) over SteVe's typed REST API, and
asserts the expected wire behavior from the simulator's own log plus SteVe's
own transaction/tag data.

This is a from-scratch reimplementation of a verification pass that was
previously done by hand (via agent sessions) against a real SteVe instance;
see `.superpowers/sdd/steve-verify-setup.md` and
`.superpowers/sdd/steve-verify-results-g1.md`..`g4.md` for that prior work.
The suite started as an all-bash implementation and was later rewritten as a
TypeScript runner (`runner/`) for uniqueId-correlated assertions -- see
"How it works" and "Relationship to #179" below.

## REST is the default driver

As of issue #184, the runner drives SteVe primarily through its typed REST
API (`/api/v1/operations/*`, `/api/v1/transactions`, `/api/v1/ocppTags` --
Basic auth, JSON, stateless) instead of the manager web UI (login/cookie/CSRF/
form-POST). REST is the **default** (`STEVE_DRIVER` unset, or `STEVE_DRIVER=api`);
the manager-UI client remains as an explicit fallback (`STEVE_DRIVER=ui`) for
older SteVe versions or for debugging. A handful of narrowly-scoped operations
have **no** REST equivalent in SteVe 3.13.0 and stay on the UI/DB path
regardless of `STEVE_DRIVER` -- see "Fallback matrix" below for exactly which,
and why. Every run prints a capability probe up front stating which surfaces
are actually live against the SteVe instance you're pointed at -- see
"Capability probe" below.

## Prerequisites

- Docker (with `docker compose`)
- `git`, `curl`, `bash` 4+ -- for the environment layer (`01`/`02`/`99`)
- [`bun`](https://bun.sh) -- for the runner (`runner/main.ts`)
- Free (or overridable) local ports `18180`/`18443`/`13306` for SteVe
- [`shellcheck`](https://www.shellcheck.net/) (optional, recommended)

## Quick start

```bash
cd scripts/steve-verify
./01-setup-steve.sh          # clone + bring up a local SteVe (idempotent; also
                              # seeds the REST API password for a FRESH checkout)
./02-provision.sh            # register charge boxes/tags/profiles (idempotent)
bun runner/main.ts run-all   # drive all 44 scenarios via the REST driver (default)
```

`run-all` prints a capability probe, then sweeps every scenario sequentially by
default and exits non-zero if any FAILed or errored. Add `--parallel` to fan
out up to 3 concurrently (one per `CERTCP1`..`3`):

```bash
bun runner/main.ts run-all --parallel
```

To use the manager-UI fallback driver instead of REST for a whole sweep:

```bash
STEVE_DRIVER=ui bun runner/main.ts run-all
```

## Running scenarios

**One scenario:**

```bash
bun runner/main.ts run cert16-tc001-cold-boot
bun runner/main.ts run cert16-tc010-remote-start --cp CERTCP2 --timeout 60
STEVE_DRIVER=ui bun runner/main.ts run cert16-tc013-hard-reset   # force the UI fallback
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

## Capability probe

Every `run`/`run-all`/`run --group` invocation opens by probing the
configured SteVe instance's REST surface and printing, in juherr's suggested
shape (issue #184 Finding 3), which capabilities are live vs. falling back --
before any scenario runs, so a session's console output states its own
fallback posture up front:

```
[runner] === SteVe capability probe ===
[runner]   SteVe API operations: available
[runner]   Transaction API: available
[runner]   OCPP tag API: available
[runner]   Reservation query API: unavailable, using DB fallback (steve-community/steve#2074)
[runner]   Charge point provisioning API: unavailable, using DB fallback (steve-community/steve#2068)
[runner]   Charging Profile API: unavailable, using UI fallback (steve-community/steve#2069)
[runner]   Async task result lookup: unavailable (steve-community/steve#2070)
[runner] === end capability probe ===
```

Each of the first six lines is a live, side-effect-free HTTP probe against
the SteVe instance `STEVE_API_URL`/`STEVE_API_USER`/`STEVE_API_PASS` point at
(a harmless filtered GET, or a POST body deliberately invalid so SteVe 400s on
request validation before it would ever dispatch to a charge point) -- not a
hardcoded claim, so the output self-corrects (flips to `available (!)`) if a
future SteVe version ships one of the currently-missing endpoints. The
seventh line (async task result lookup) is stated statically -- see
`runner/capability-probe.ts`'s header for why it can't be safely probed. A
probe HTTP failure (SteVe unreachable, wrong URL/credentials) reports
`unknown (...)` for that one line and never aborts the run -- this is
informational, not a precondition.

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

- `drive(ctx)` -- timed CSMS-operation calls (via `ctx.steve`, the `SteveOps`
  interface -- `SteveApiOps` (REST, default) or `SteveUiOps` (manager-UI form
  POST, `STEVE_DRIVER=ui`), selected once per run) for scenarios that need
  CSMS-side action (RemoteStart, Reset, TriggerMessage, SetChargingProfile,
  ...). Omitted entirely for CP-only scenarios (e.g. TC_001, TC_003) that
  just need to be watched, not driven. Its return value is threaded into
  `assert()` as `driveState`.
- `assert(ctx)` -- checks against `ctx.frames` (every parsed OCPP-J frame,
  correlated by `uniqueId` via `findCall`/`findResponseFor` in
  `runner/ocpp.ts`), `ctx.lines` (raw log lines, for lifecycle/absence
  checks), and `ctx.db` (the `SteveTx` interface -- `SteveApiDb` (REST,
  default) or `SteveDb` (direct MariaDB, `STEVE_DRIVER=ui`)) where a
  transaction or reservation is expected. See `runner/specs/core.ts`'s
  `cert16-tc003-charging-plugin-first` and `cert16-tc026-remote-start-rejected`
  entries for worked examples (self-driven with DB assertions; CSMS-driven
  with a uniqueId-correlated response-status assertion).

Specs are intentionally simple: they assert the load-bearing facts a
certification reviewer would actually check (StopTransaction reason,
CALLRESULT status, `listVersion`, firmware status trains, ...), not every
byte on the wire. Every spec drives/asserts purely through the `SteveOps`/
`SteveTx` interfaces above, so no spec needed to change when the REST driver
was added -- which driver is active is invisible to `specs/*.ts`.

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
those correlated frames plus SteVe's transaction/tag/reservation data (via
`ctx.db`, REST-backed by default).

## Fallback matrix

REST covers everything the runner's 44+3 specs actually drive or assert,
**except** four narrowly-scoped gaps in SteVe 3.13.0's REST API (tracked
upstream, issue #184 Finding 3 / [steve-community/steve#1000](https://github.com/steve-community/steve/issues/1000)).
The capability probe above re-checks the first three live every run; the
fourth (async task results) is a behavioral fact about how the REST API
responds, not a missing route, and is documented rather than probed.

| Surface                                                                                                                                                                            | Driver (`STEVE_DRIVER=api`, default)                                                                                  | `STEVE_DRIVER=ui`            | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 17 CSMS operations (Reset, RemoteStart, TriggerMessage, SetChargingProfile, ...)                                                                                                   | REST, `POST /api/v1/operations/<Op>`                                                                                  | Manager-UI form POST         | Fully REST-covered (`runner/steve-api.ts`'s `SteveApiOps`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Transaction lookup/close (active/latest tx, stop reason/timestamp, tag/count)                                                                                                      | REST, `GET/PATCH /api/v1/transactions*`                                                                               | Direct MariaDB (`SteveDb`)   | Fully REST-covered, including MeterValues (`runner/steve-api.ts`'s `SteveApiDb`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| OCPP tag create/update/delete/lookup                                                                                                                                               | REST, `POST/PUT/DELETE/GET /api/v1/ocppTags*`                                                                         | Direct SQL `INSERT`/`UPDATE` | Fully REST-covered (`02-provision.sh` + `lib.sh`'s `steve_api_*` helpers).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **One field**: setting a tag's `expiryDate` in the **past** (TC_023 `CERT023-EXP`)                                                                                                 | Direct SQL `UPDATE ocpp_tag SET expiry_date = ...` (permanent)                                                        | Same SQL `UPDATE`            | `OcppTagForm.expiryDate` is `@Future`-validated on both create AND update -- live-verified: no request shape gets a past date through the REST API. Not tracked as a SteVe gap (the validation is presumably intentional); documented here as a permanent one-field exception inside an otherwise fully-REST-covered feature.                                                                                                                                                                                                                                                                                                                                                   |
| Reservation query (latest reservation, cancellation status)                                                                                                                        | Direct MariaDB (`SteveApiDb` delegates internally)                                                                    | Direct MariaDB (`SteveDb`)   | No `/api/v1/reservations` controller exists in SteVe 3.13.0 at all (confirmed by listing the running container's compiled controller classes). Tracked: [steve-community/steve#2074](https://github.com/steve-community/steve/issues/2074).                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Charge box (CERTCP1..3) registration                                                                                                                                               | Direct MariaDB (`02-provision.sh`)                                                                                    | Same                         | No REST endpoint to register/provision a charge point. Tracked: [steve-community/steve#2068](https://github.com/steve-community/steve/issues/2068).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Charging-Profile **entity** creation (the persisted profile SetChargingProfile/RemoteStartTransaction attach to -- `02-provision.sh`'s `TC056 TxDefaultProfile`/`TC057 TxProfile`) | Manager-UI form POST (`02-provision.sh`'s `ensure_charging_profile`, needs `--data-urlencode "add=Add"` -- see below) | Same                         | No REST endpoint to create/manage Charging Profile entities (applying an _already-created_ profile via `SetChargingProfile` IS REST-covered above -- this gap is specifically entity CRUD). Tracked: [steve-community/steve#2069](https://github.com/steve-community/steve/issues/2069).                                                                                                                                                                                                                                                                                                                                                                                        |
| Async operation result for a `taskId` whose initial response had `taskFinished=false`                                                                                              | Not polled (see below)                                                                                                | N/A (UI is fire-and-forget)  | SteVe's REST operations endpoint blocks server-side up to its own 30s station-response timeout before responding at all; there is no separate "fetch this taskId's result later" endpoint. `taskFinished=false` (SteVe #2070) is live-reproducible today with an OCPP 1.6J Hard Reset (the CP sends no `Reset.conf` at all -- see `runner/steve-api.ts`'s file header). `SteveApiOps#op()` logs a `WARN` and returns normally rather than polling: every spec's `assert()` checks the simulator's own captured wire log, never this REST response, so there's nothing to poll for. Tracked: [steve-community/steve#2070](https://github.com/steve-community/steve/issues/2070). |

**The Charging-Profile UI form needs `add=Add`.** SteVe 3.13.0's
`/chargingProfiles/add` controller only invokes its add handler when the POST
body includes `add=Add` (mirroring the real `<input type="submit" name="add"
value="Add">` on that page) -- without it the POST silently 200s with no row
inserted. `02-provision.sh` sends this and keeps a post-condition existence
check.

## `web_user.api_password` seeding (REST auth)

SteVe's `/api/**` REST endpoints authenticate over a _separate_ filter chain
from the manager UI: stateless HTTP Basic auth, checked against
`web_user.api_password` -- a distinct bcrypt column from the manager login's
`web_user.password`, `NULL` by default. SteVe only seeds it (from the
`webapi.value` / `steve.auth.web-api-secret` config property) the **first
time it ever bootstraps an ADMIN user** -- i.e. only on a genuinely fresh DB
volume.

- **A fresh checkout** (`./01-setup-steve.sh` cloning SteVe for the first
  time): handled automatically. The script sets `webapi.value =
${STEVE_PASS}` in the cloned checkout's
  `src/main/resources/application-docker.properties` before `docker compose
up`, so the seeded admin's API credentials end up identical to its
  manager-UI credentials (`STEVE_USER`/`STEVE_PASS`) -- one set of creds for
  both drivers, matching this repo's provisioning.
- **An already-provisioned SteVe instance** (its ADMIN user already exists,
  so the above seeding never fires): needs a one-time manual DB fixup,
  reusing the existing manager-login bcrypt hash so API creds match it:

  ```sql
  UPDATE web_user SET api_password = password WHERE username = 'admin';
  ```

  `WebUserService` caches API-user lookups for 10 minutes (an in-memory
  Guava cache keyed by username) -- **restart the SteVe app container**
  after this `UPDATE` for it to take effect immediately, or the fix is only
  visible once the cache entry naturally expires.

If REST auth is failing and you don't recognize either case above, the
capability probe's `SteVe API operations`/`Transaction API`/`OCPP tag API`
lines will show `unknown (unexpected HTTP 401 -- check
STEVE_API_USER/STEVE_API_PASS, or web_user.api_password seeding ...)` --
that 401 (distinct from a routing 403/404) is the signature of exactly this
gap.

## Targeting an existing SteVe deployment

Every credential/URL the runner needs is an env var (see "Environment /
configuration" below) -- there is no requirement to use the bundled
`01`/`02`/`99` docker-compose stack. To point the runner at an existing SteVe
instance instead:

```bash
export STEVE_URL="https://steve.example.internal/steve/manager"   # manager UI (UI fallback + login-based checks)
export STEVE_API_URL="https://steve.example.internal/steve/api/v1"  # REST API (default driver)
export STEVE_USER=admin STEVE_PASS='...'                # manager-UI login
export STEVE_API_USER=admin STEVE_API_PASS='...'         # REST creds (see the seeding note above --
                                                          # only needed if they differ from STEVE_USER/PASS)
export STEVE_DB_CONTAINER=... STEVE_DB_USER=... STEVE_DB_PASS=... STEVE_DB_NAME=...  # only if STEVE_DRIVER=ui,
                                                                                       # or for the permanent DB-only
                                                                                       # fallbacks in the matrix above
export STEVE_NETWORK=...   # the docker network the simulator container should join to reach that instance
bun runner/main.ts run-all
```

Charge boxes (`CERTCP1..3`) and OCPP tags still need to exist on that
instance -- run `02-provision.sh` against it (it also uses the same env vars)
or provision equivalently by hand. Skip `01-setup-steve.sh` entirely (it only
manages the bundled compose stack) and `99-teardown.sh` (don't tear down an
instance you don't own).

## Parallel lane isolation

`--parallel` runs up to 3 scenarios concurrently, one per `CERTCP1`..`3`, all
inside a single `bun` process (`Promise.all` over one batch, not separate
child processes). Investigation for issue #184 Finding 4 (juherr's
independent SteVe pre-prod run saw 5 parallel-only false-negative FAILs --
`tc021`/`tc043-3`/`tc043-5`/`reservation-basic`/`tc054` -- that all PASSed
run in isolation, under the then-only manager-UI driver) found:

**Update (Task 4, REST as the default driver): the flakiness has not
recurred.** Since the REST driver landed, every `--parallel` sweep run
against this repo's SteVe 3.13.0 instance has been clean on the first try,
with no isolated retries needed: Task 3's `core --parallel` (15/15, twice)
and `authlist-reservation --parallel` (13/13), and Task 4's full
`run-all --parallel` (all 44, including every scenario from juherr's original
5-FAIL list). This is consistent with -- though not conclusive proof of --
the "not session/CSRF contamination" finding below: the REST driver holds no
per-lane state at all, which is one plausible source of exactly this class of
timing sensitivity removed. Sequential remains the documented reliable mode
(below) since a handful of clean runs isn't a guarantee against a
host-contention race that was already understood to be probabilistic, but
there is no live counter-evidence against the REST migration having
resolved it.

- **Not session/CSRF contamination.** Even under the UI fallback driver,
  `SteveUiOps` (`runner/steve.ts`) holds its cookie jar as an instance field
  (a plain `Map`), and `runScenario()` constructs a fresh driver instance per
  call -- each parallel lane already gets its own jar, never shared.
  Confirmed live: three concurrent `admin` logins against a running SteVe
  3.13.0 all stayed valid simultaneously (no single-session-per-user
  eviction). The default REST driver (`SteveApiOps`/`SteveApiDb`) goes
  further: it holds no cookie/session state at all (stateless Basic auth per
  request), so this is not merely "already isolated" but structurally
  incapable of this class of cross-lane contamination.
- **Not cross-CP data contamination.** Every transaction/reservation lookup a
  spec's `assert()` makes (`latestTxPk`, `waitActiveTxPk`,
  `latestReservationPk`, ...) filters by `charge_box_id`/`chargeBoxId` in
  both drivers, so two lanes on different CPs can't read each other's
  transaction/reservation row.
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
  hitting a different fixed wait.
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
directly in `runner/steve.ts`/`runner/steve-api.ts`/`runner/sim.ts`), so
setting one in your shell before running either layer keeps them in sync.

| Variable                                  | Default                                                | Used by              | Purpose                                                                                                |
| ----------------------------------------- | ------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------ |
| `STEVE_DRIVER`                            | `api`                                                  | runner               | `api` (REST, default) or `ui` (manager-UI form POST fallback) -- selects both `SteveOps` and `SteveTx` |
| `STEVE_API_URL`                           | `http://localhost:${STEVE_APP_HOST_PORT}/steve/api/v1` | runner (REST driver) | REST API base URL (no trailing slash)                                                                  |
| `STEVE_API_USER` / `STEVE_API_PASS`       | `STEVE_USER` / `STEVE_PASS`                            | runner (REST driver) | REST Basic-auth creds -- see the `web_user.api_password` seeding note above                            |
| `STEVE_REPO_DIR`                          | `~/git/steve`                                          | `01`/`99`            | Local SteVe checkout                                                                                   |
| `STEVE_REPO_URL`                          | `github.com/steve-community/steve.git`                 | `01`                 | SteVe git remote                                                                                       |
| `STEVE_APP_HOST_PORT` / `..._TLS_PORT`    | `18180` / `18443`                                      | `01`, runner         | Host port remap (avoid conflicts)                                                                      |
| `STEVE_DB_HOST_PORT`                      | `13306`                                                | `01`                 | Host port remap (avoid conflicts)                                                                      |
| `STEVE_URL`                               | `http://localhost:18180/steve/manager`                 | `01`, `02`, runner   | Manager UI base URL (UI driver + login-based provisioning steps)                                       |
| `STEVE_USER` / `STEVE_PASS`               | `admin` / `1234`                                       | `02`, runner         | Manager UI login                                                                                       |
| `STEVE_NETWORK`                           | `steve_default`                                        | `01`, runner         | docker network the sim joins                                                                           |
| `STEVE_DB_CONTAINER`                      | `steve-db-1`                                           | `02`, runner         | Container name for `docker exec` (UI driver + the permanent DB-only fallbacks)                         |
| `STEVE_DB_USER` / `..._PASS` / `..._NAME` | `steve` / `changeme` / `stevedb`                       | `02`, runner         | DB credentials                                                                                         |
| `SIM_IMAGE`                               | `oven/bun:1.3-alpine`                                  | runner               | Simulator container image                                                                              |
| `SIM_WS_URL`                              | `ws://app:8180/steve/websocket/CentralSystemService/`  | runner               | CSMS WebSocket URL (docker-internal)                                                                   |
| `DEFAULT_CP_ID`                           | `CERTCP1`                                              | runner               | `run`'s default `--cp`                                                                                 |

The port defaults deliberately avoid `3306`/`8180` -- common local
collisions (an existing MySQL/MariaDB or an SSH tunnel) on developer
machines; override if `18180`/`18443`/`13306` are also taken.

Credentials (`STEVE_PASS`/`STEVE_API_PASS`/`STEVE_DB_PASS`) are read from env
only and never logged -- every evidence line the runner prints (capability
probe, `steve-api POST ...` op logs) redacts the `Authorization` header and
the values that built it.

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
  DB-driven follow-up) poll instead (`sim.waitForLine`/`waitActiveTxPk`).
- **Shared idTag pool under heavy `--parallel` use.** Several specs use a
  fixed tag (e.g. `CERT-TAG-1`) for CSMS-initiated ops rather than deriving
  a per-CP tag; `max_active_transaction_count=5` gives headroom for the
  default 3-way `--parallel` fan-out, but running many groups in parallel
  simultaneously could contend.
- **`--parallel` lanes are not fully isolated (issue #184 Finding 4).**
  See "Parallel lane isolation" above -- sequential is the reliable
  reporting mode; `--retry-failed-isolated` is a safety net, not a fix.
- **Four narrow REST gaps, all documented and DB/UI-backed** -- reservation
  query, charge-box provisioning, Charging-Profile entity CRUD, and async
  task-result lookup. See "Fallback matrix" above; the capability probe
  re-confirms the first three live every run.
- **SteVe-specific.** Response statuses that are SteVe's own policy rather
  than CP behavior (e.g. TC_064's DataTransfer response status) are asserted
  loosely (a response was received) rather than pinned to a specific status.
- **`cert16-tc052-cancel-reservation-rejected` is pinned to the UI driver**
  regardless of `STEVE_DRIVER`. SteVe's REST `CancelReservation` pre-validates
  `reservationId` against active reservations _before_ dispatching to the CP
  (`400` for a nonexistent id, never reaching the station) -- exactly this
  scenario's point (the CP itself must answer Rejected) is unreachable via
  REST. The manager-UI path has no such pre-check, so this one spec
  constructs its own `SteveUiOps` directly, documented inline in
  `runner/specs/authlist-reservation.ts`.
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
  lib.sh                    # bash environment-layer helpers (config, db, steve_login, steve_api_*)
  01-setup-steve.sh          # clone/refresh SteVe, apply compose edits, seed the REST API password, bring up
  02-provision.sh            # charge boxes, tags (via REST), charging profiles, stale-tx cleanup
  99-teardown.sh              # compose down (+ optional volume wipe)
  runner/                    # TypeScript runner (bun)
    main.ts                   # CLI: run/run-all, groups, --parallel, --retry-failed-isolated, capability probe, summary writer
    capability-probe.ts        # issue #184 Task 4: startup capability detection (this README's "Capability probe" section)
    sim.ts                     # docker-spawned simulator process (JSON-Lines stdin)
    ocpp.ts                     # OCPP-J frame parser + uniqueId correlation
    steve.ts                     # SteveOps/SteveTx interfaces + SteveUiOps/SteveDb (manager-UI/DB, STEVE_DRIVER=ui)
    steve-api.ts                  # SteveApiOps/SteveApiDb (REST, STEVE_DRIVER=api, default)
    assert.ts                      # typed assertion DSL (AssertRecorder)
    spec-types.ts                   # ScenarioSpec/DriveContext/AssertContext shapes
    specs/
      core.ts                      # 15 scenarios
      authlist-reservation.ts       # 13 scenarios
      remotetrigger-smartcharging.ts # 12 scenarios
      firmware.ts                    # 4 scenarios
    __tests__/                 # pure unit tests (bun test; also picked up by
                                # npm run test:bun's "bun.test" filter)
  results/                    # gitignored: per-scenario logs + summary.md
```
