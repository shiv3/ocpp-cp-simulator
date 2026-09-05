---
title: CLI (`ocpp-cp-sim`)
type: entity
summary: The headless Bun binary — interactive REPL, JSON Lines mode, daemon launcher, and Socket.IO client modes — plus the full flag reference.
sources:
  - src/cli/main.ts
  - src/cli/types.ts
  - package.json (`bin`, `files`)
  - scripts/verify-cli-tarball.sh
  - scripts/verify-install-urls.sh
  - scripts/roll-cli-latest.sh
  - .github/workflows/cli-release.yml
  - "issue #320"
  - "issue #321"
related:
  - daemon.md
  - analyze.md
  - docker-image.md
  - ../concepts/control-plane.md
  - ../concepts/scenario-format.md
  - ../concepts/trace-format.md
updated: 2026-09-05
---

# CLI (`ocpp-cp-sim`)

Headless charge point simulator for scripting, CI pipelines, and
AI/automation integration. Runs on [Bun](https://bun.sh/). The same binary
is also the launcher for the [daemon](daemon.md) and a thin Socket.IO client
for a daemon someone else started.

## Prerequisites

- [Bun](https://bun.sh/) runtime

## Quick Start

```bash
# Interactive REPL
ocpp-cp-sim --ws-url ws://localhost:9000/ocpp --cp-id CP001

# JSON Lines mode (for automation)
ocpp-cp-sim --ws-url ws://localhost:9000/ocpp --cp-id CP001 --json

# Daemon on the default TCP loopback port (http://127.0.0.1:9700)
ocpp-cp-sim --daemon

# npm script shorthand from a checkout
npm run cli -- --ws-url ws://localhost:9000/ocpp --cp-id CP001
```

### Installing as the `ocpp-cp-sim` command

The package exposes a `ocpp-cp-sim` bin so it can be invoked from anywhere once
installed:

```bash
# Prebuilt release tarball (recommended) — ships the web-console dist/
bun install -g https://github.com/shiv3/ocpp-cp-simulator/releases/download/cli-v0.3.1/ocpp-cp-simulator-0.3.1.tgz

# From a local checkout (dev)
bun link
bun link ocpp-cp-simulator    # in any consumer project

# Then use ocpp-cp-sim anywhere
ocpp-cp-sim --ws-url ws://localhost:9000/ocpp --cp-id CP001
ocpp-cp-sim --daemon
```

> A plain `bun install -g github:shiv3/ocpp-cp-simulator` is **not**
> supported: the web-console `dist/` is built at release time (not committed to
> git), and bun does not install devDependencies for global packages so it
> cannot run `vite build` on install. Use the prebuilt tarball URL above.
> Release tarballs are produced by the `Release CLI` workflow on `cli-v*` tags.

### Why `cli-latest` and not `releases/latest`

GitHub's own `releases/latest/download/…` is **not usable in this repository**
and must not be reintroduced (#321). The repo has two independent tag trains —
`v*` for the [desktop app](desktop-app.md) and `cli-v*` for the CLI — and
`releases/latest` resolves across both. Whenever the newest release is a
desktop one, which is the case for roughly half of any release cycle, the URL
redirects to a release that carries no `.tgz` and the install command fails
with a 404. That is the steady state, not a transient.

The replacement is **`cli-latest`**, a rolling pre-release that
`scripts/roll-cli-latest.sh` moves onto every CLI release from
`cli-release.yml`, re-uploading the stable-named `ocpp-cp-simulator.tgz`:

```
https://github.com/shiv3/ocpp-cp-simulator/releases/download/cli-latest/ocpp-cp-simulator.tgz
```

It is scoped to the CLI train, so it stays correct without anyone remembering
to bump a version number, and it is kept a pre-release precisely so it can
never itself become the repository's "Latest" release, which the desktop train
owns.

**Rollout status.** That release does not exist yet — the workflow creates it
on the next `cli-v*` push — so this page and [`README.md`](../../README.md)
advertise the pinned `cli-v0.3.1` URL, which resolves today. Documenting a URL
before it exists would reproduce the very defect #321 is about: a quick-start
command that 404s. The CLI release that first creates the pointer is the one
that swaps the pinned URLs for it. A maintainer with release rights can close
the gap sooner by cutting a `cli-v*` release; nothing in the repository can do
it, and no tag or release was created by the change that introduced the
pointer.

**The contract.** `cli-latest` always serves the highest published
`cli-vX.Y.Z` release, and never a lower one, whatever order the pointer jobs
run in or fail in. Three carve-outs, stated rather than left to be discovered:

- A CLI release tagged with a SemVer prerelease or build-metadata suffix
  (`cli-v1.0.0-rc.1`) is not eligible to own the pointer and is ignored when
  picking the highest. Install those by their pinned URL.
- If the highest release is later _deleted_, the pointer follows the new
  highest downwards, with a `::warning::` — an unpublished release cannot be
  the thing the pointer serves. It never moves down on the strength of a
  release _listing_ alone; see
  [The marker is load-bearing, narrowly](#the-marker-is-load-bearing-narrowly).
- Replacing the asset is not atomic — GitHub has no atomic asset swap — so
  there is a window, bounded by two metadata calls rather than by a 2 MB
  upload, in which the URL can 404. It is recovered from rather than exited
  from; only a recovery that is exhausted — or that cannot establish what state
  the release is in — leaves it 404ing, and it says so loudly and says how to
  restore it.

**How it holds.** Every pointer run asks which is the highest published
`cli-v*` release and rolls to _that_, not to the version that triggered it. The
obvious alternative — each run moves the pointer to its own version, refusing
if a marker in the pointer's body names something newer — fails two ways, and
both shipped before this design:

- **Queue order is not version order.** GitHub keeps exactly one pending job
  per `concurrency:` group and replaces it with the most recently _queued_ one,
  and queue order here is release-job completion order. With 1.1 running, 1.3
  pending and a slow rerun of 1.2 arriving, 1.2's job evicts 1.3's, 1.2
  advances the pointer from 1.1, and the already-published 1.3 is never served.
- **An unverified marker is not a trustworthy authority.** Uploading the asset
  and writing the marker are two API calls. If the upload lands and the write
  does not, the URL immediately serves the new asset while the body still names
  the old version — and a later, older run passed its comparison against that
  stale marker and rolled the served bytes backwards. While the marker was
  trusted _unverified_, reversing the two calls only swapped which direction
  was wrong; it is the point lookup added later, described
  [below](#the-marker-is-load-bearing-narrowly), that makes one order safe. The
  code writes the marker first, and
  ["If this dies here…"](#if-this-dies-here-what-does-the-install-url-serve)
  says why.

Converging on the highest published release removes both, because it removes
the two things that were being trusted. Queue order stops mattering: whichever
job survives reaches the same state. A cancelled job costs nothing, because the
next one to run reaches that same state. A stale or hand-edited marker cannot
_by itself_ authorise anything — it is a **record** of what is served, and the
one decision it participates in is gated on a point lookup that verifies it
(see [the next section](#the-marker-is-load-bearing-narrowly)). It is
deliberately not used to short-circuit the upload, because that would put it
back on the trusted path.

#### The marker is load-bearing, narrowly

Converging on "the highest published release" is only as good as the listing it
is computed from, and `gh release list` is eventually consistent. Waiting until
the listing shows the _triggering_ tag closes "the listing has not caught up
with me". It does not close "the listing has not caught up with someone
**newer**": an older rerun can see a listing that looks complete, omits a
higher release, and would then overwrite the pointer downwards — recreating the
rollback this design exists to prevent.

In that one situation the marker is the only evidence the newer release exists,
so it _is_ consulted — as a lower bound on what has already been served, never
as authority to move. Whenever it names something higher than the listing did,
the run does a point lookup of that single release (a direct `GET` of one tag,
not a paginated list) and: **published** → the listing was stale, converge _up_
to it; **confirmed 404** → deleted, converge down with a warning; **draft** →
not published, converge down with a warning; **any other error** → fail closed
and leave the pointer alone. A hand-edited or corrupt marker therefore cannot
move the pointer anywhere — it can only trigger a lookup whose answer decides.

#### "If this dies here, what does the install URL serve?"

Asked of every mutating call, because the reviews of this script have found
partial-failure bugs rather than logic bugs:

| Step                          | URL then serves         | What the next run may conclude                                             |
| ----------------------------- | ----------------------- | -------------------------------------------------------------------------- |
| download the target's asset   | previous release        | nothing changed                                                            |
| write the notes (the marker)  | previous release        | marker over-claims: its lookup finds the release published, converges _up_ |
| upload `<asset>.incoming`     | previous release        | as above — the pending swap is completed by whichever run comes next       |
| delete the live asset         | **the only 404 window** | as above                                                                   |
| rename `.incoming` into place | new release             | consistent                                                                 |
| move the git tag              | new release             | consistent                                                                 |

The second column is the half this table used to cover. The third is where two
rounds of findings actually lived: a state is only safe if the **next** run
cannot draw a wrong conclusion from what it finds.

There is a third class of failure besides "it failed" and "it failed partway":
**"it may have succeeded and we cannot tell"**. A retry loop cannot distinguish
a lost request from a lost response, so an exhausted retry does not mean the
mutation was not applied. The rule is therefore that after an exhausted retry
of a mutation the state is **queried, never assumed**. Assuming a rename had
failed is what let the destructive `--clobber` fallback run against the asset
that same rename had already put in place — turning a cosmetic retry failure
into a dead install URL. Where each exhausted retry lands:

| Exhausted call            | What happens                                                                      |
| ------------------------- | --------------------------------------------------------------------------------- |
| write the notes (marker)  | Fail. Safe either way — if it did apply, the marker over-claims, which self-heals |
| upload `<asset>.incoming` | Fail. Safe either way — an orphan serves nothing and the next run clobbers it     |
| delete the live asset     | Query. Present → stop; absent → continue; unknown → stop                          |
| rename `.incoming`        | Query. Present → it worked; absent → fall back; unknown → **never** fall back     |
| fallback re-upload        | Query, so a lost response is not reported as a dead URL                           |
| create the pointer        | Query, same reason                                                                |
| move the git tag          | Query, to keep the warning honest. Cosmetic either way                            |

That is why the marker is written **first**, and why failing to write it is
fatal rather than a warning. Writing it last looked right in isolation — the
bytes are correct and the URL works, so why fail? — but it leaves a successful
swap whose marker still names the older version, and a later run on a stale
listing then sees nothing higher to verify and replaces the newer bytes with an
older tarball. Once the marker became a lower bound, the two directions of
staleness stopped being symmetric:

| Marker relative to the bytes | Consequence                                                              |
| ---------------------------- | ------------------------------------------------------------------------ |
| **over**-claims (ahead)      | Self-healing: the next run verifies the claim, converges up, finishes it |
| **under**-claims (behind)    | Permits a rollback — the failure this whole design exists to prevent     |

Writing it first also costs nothing when it fails: at that moment nothing else
has been touched, so the run can simply exit non-zero with the URL still
serving the previous release.

Lookups on that path preserve their status: "the asset is absent" and "the
asset could not be looked up" are different answers, and only the first may
allow the destructive fallback to proceed. Collapsing them is the fail-open
class this script closes everywhere else, and it caused the exact outcome the
fallback exists to prevent — a failed query read as absence lets `--clobber`
run against a live, working asset.

`gh release upload --clobber` is deliberately **not** used for the live asset.
Its own help says "If the upload fails, the original assets will be lost": it
deletes first and uploads second, so a transient failure would leave the URL
`README.md` advertises 404ing indefinitely. The new bytes go up under a
temporary name first, so the destructive step never runs until the replacement
is already on the server; then delete and rename, both fast metadata calls,
both retried, with a recovery that re-uploads under the live name — but only
once a query has _confirmed_ the live asset is absent. Only if that recovery is
also exhausted, or the state cannot be established, does the run exit with the
URL dead, and then it says so and says how to restore it.

The git tag is moved to the commit behind the _target_ release, not to the
checkout's `HEAD` — an older run that converged upward is checked out at its
own older tag, and tagging that would make the tag disagree with the asset. It
is moved through the refs API, so the checkout's fetch depth does not matter,
and failing to move it is a warning rather than an error: the tag is cosmetic
and the URL is already correct by then.

| Situation                                                            | What happens                                                                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A higher `cli-v*` release exists than the one that triggered the run | `::notice::`, pointer goes to the higher one                                                                      |
| Release listing cannot be read                                       | **Release fails.** The highest release is unknown, so the pointer is left alone                                   |
| Listing is stale and omits the triggering release                    | Retried; then the triggering version is used as a floor, since its publish job demonstrably finished              |
| Listing is stale and omits a release the marker records as higher    | Point lookup decides: published -> converge up; 404 or draft -> converge down, warned; other error -> fail closed |
| Target release has no (or an empty) `ocpp-cp-simulator.tgz`          | **Release fails** rather than pointing at a release that cannot be served                                         |
| Pointer lookup returns a confirmed **404**                           | Pointer is created                                                                                                |
| Pointer lookup fails any **other** way (401, 403, 5xx, DNS)          | **Release fails.** "Absent" must never be inferred from a transient error                                         |
| Pointer's marker is missing or unparseable                           | `::warning::`, marker overwritten — in this state it carries no information                                       |
| Pointer's marker names a version **higher** than the target          | Point lookup of that release decides (row above); it is never simply overwritten                                  |
| A mutation exhausts its retries                                      | The state is **queried**, never assumed — a lost response is not a failed request                                 |
| Version given is a prerelease or has build metadata                  | **Release fails** with an error naming the reason                                                                 |

Versions are compared numerically field by field, never with `sort -V`, which
is not SemVer-aware: it orders `1.0.0-rc.1` _after_ `1.0.0`. The asset is taken
from the target release itself, so the bytes the pointer serves are provably
the bytes that release published. The **marker is written first**, then the
asset is swapped, then the tag moves — that order is the safety invariant, not
an implementation detail, and the reasoning is in
["If this dies here…"](#if-this-dies-here-what-does-the-install-url-serve).
Do not reverse it.

**Only the pointer move is serialised.** `cli-release.yml` is two jobs: the
publish job, which creates the per-tag `cli-v*` release, and `roll-pointer`.
The `concurrency:` group is on `roll-pointer` alone. It must not be on the
workflow or on the publish job: GitHub cancels the _pending_ run when a newer
one enters a group, and `cancel-in-progress: false` protects only the run
already executing — so a workflow-level group would cancel a queued CLI release
outright and it would never publish its own `cli-v*` assets, which are the
release. The group on `roll-pointer` exists only to stop two `--clobber`
uploads interleaving; it is not what makes the pointer correct, and it must not
be, because it is that group's own eviction behaviour that the convergence
above is written to survive. `verify-install-urls.sh` asserts this placement so
the group cannot migrate back up.

CI runs `scripts/verify-install-urls.sh` on every pull request. It **fetches**
every install command this page and `README.md` advertise and fails if one does
not return 200 — an earlier version of the guard only checked that the places
restating the command agreed with each other, which is no guard at all, since
several places agreeing on a broken URL is precisely the state #321 describes.
It also refuses any `releases/latest/download` install command, and asserts
that `cli-release.yml` still advertises the rolling URL and still moves it
through the roll script. Prose that merely names a URL (such as the block
above) is exempt: it is not an instruction a reader will paste.

### What the package ships

`package.json`'s `files` field is a list of **directories**, not individual
files:

| Entry          | Why it must ship                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| `src/cli`      | `main.ts` (the `bin`), the daemon server, the client modes, `analyze`, `export-k6`                    |
| `src/cp`       | The charge point domain, transports and message handlers                                              |
| `src/data`     | SQLite repositories — `main.ts` imports `../data/sqlite/…` before it parses a single argument         |
| `src/ocpp`     | Generated OCPP types and validators reached from the CP's message handlers                            |
| `src/protocol` | The Socket.IO [control-plane](../concepts/control-plane.md) zod schemas                               |
| `src/scenario` | Advisory [scenario](../concepts/scenario-format.md) schema validation                                 |
| `src/trace`    | The [trace](../concepts/trace-format.md) analysis disclaimer, on `analyze`'s module graph             |
| `src/utils`    | Scenario templates, blueprints and URL helpers (the whole subtree — `blueprints/` is imported too)    |
| `schema`       | `scenario.schema.json`, imported by the validator above                                               |
| `vendor`       | The [vendored OCA JSON schemas](../sources/vendored-ocpp-schemas.md) the validators import at runtime |
| `dist`         | The Vite-built web console served by `--web-console`; built by `prepack`, never committed             |

Every one of these is load-bearing: removing any single entry makes the
installed `ocpp-cp-sim` fail on its first import, before `--help` prints. This
is the same set the [Docker image](docker-image.md)'s `COPY` list carries, and
the two are meant to stay in step.

Between 2026-07-01 and this page's `updated:` date the list named
`src/utils/scenarioTemplates.ts` and `src/utils/scenarios` individually and
omitted `src/data`, `src/ocpp`, `src/trace` and `vendor` entirely, so the
tarball the release workflow produced could not start at all (#320). Nothing
caught it because the only checks on the tarball were `tar -tf | grep`s for
three filenames that happened to be present — a listing check cannot see a
path nobody thought to name. `scripts/verify-cli-tarball.sh` replaces them: it
installs the tarball into a throwaway global prefix and then boots it —
`--help`, a `bun build --compile` over the installed tree (which resolves the
whole import graph, type-only imports included), the daemon answering
`GET /v1/healthz` with a charge point bootstrapped, and, when `dist/` is
present, the web console serving its shell. It runs on every pull request
(`ci.yml`) as well as at release time, so packaging breaks on the PR that
breaks it.

All flags described below apply whether you run the installed `ocpp-cp-sim`
command or, from a source checkout, `bun src/cli/main.ts …`.

## Operation Modes

### 1. Interactive REPL

Default mode. Connects to a CSMS and provides a `ocpp>` prompt.

```bash
ocpp-cp-sim --ws-url ws://localhost:9000/ocpp --cp-id CP001
```

```
OCPP CP Simulator CLI - CP001 (1 connector(s))
Target: ws://localhost:9000/ocpp
Type "help" for available commands.

ocpp> connect
Connecting...
[EVENT] connected to CSMS
Connected.
ocpp> start 1 TAG001
Transaction start requested on connector 1
ocpp> status
ChargePoint: CP001  Status: ...
  Connector 1: Charging (Operative)  Meter: 0 Wh  TX#12345
```

#### REPL Commands

| Command                                 | Description                              |
| --------------------------------------- | ---------------------------------------- |
| `connect`                               | Connect to CSMS (sends BootNotification) |
| `disconnect`                            | Disconnect from CSMS                     |
| `status`                                | Show charge point and connector status   |
| `start <connector> <tagId>`             | Start a transaction                      |
| `stop <connector>`                      | Stop a transaction                       |
| `meter <connector> <value>`             | Set meter value (Wh)                     |
| `send-meter <connector>`                | Send current meter value to CSMS         |
| `heartbeat`                             | Send a single heartbeat                  |
| `heartbeat start <seconds>`             | Start periodic heartbeat                 |
| `heartbeat stop`                        | Stop periodic heartbeat                  |
| `authorize <tagId>`                     | Send authorization request               |
| `connector-status <connector> <status>` | Update connector status                  |
| `help`                                  | Show help                                |
| `exit`                                  | Exit                                     |

### 2. JSON Lines Mode

Machine-readable mode for automation and AI agent integration. Each line of
stdin is a JSON command; each line of stdout is a JSON response or event.

```bash
ocpp-cp-sim --ws-url ws://localhost:9000/ocpp --cp-id CP001 --json
```

#### Request Format

```json
{"id": "req-1", "command": "connect"}
{"id": "req-2", "command": "start_transaction", "params": {"connector": 1, "tagId": "TAG001"}}
{"id": "req-3", "command": "status"}
```

#### Response Format

```json
{"id": "req-1", "ok": true}
{"id": "req-2", "ok": true}
{"id": "req-3", "ok": true, "data": {"id": "CP001", "status": "Available", "error": "", "connectors": [...]}}
```

Error responses:

```json
{ "id": "req-x", "ok": false, "error": "error description" }
```

#### Event Format

Asynchronous events are emitted as JSON lines without an `ok` field:

```json
{"event": "connected", "data": {}, "timestamp": "2025-01-01T00:00:00.000Z"}
{"event": "connector_status", "data": {"connectorId": 1, "status": "Charging", "previousStatus": "Available"}, "timestamp": "..."}
```

#### Available JSON Commands

The JSON-mode `command` IDs are **exactly** the CP-scoped Socket.IO RPC method
names of the daemon — `connect`, `status`, `start_transaction`,
`run_scenario`, … — and take the same `params`. The single canonical table
(params, constraints, notes) lives in
[Control plane → CP command methods](../concepts/control-plane.md#cp-command-methods);
the server routes both surfaces through the same command handler.

### 3. Daemon / Server Mode

Long-running process that exposes health, optional static web-console assets,
and a Socket.IO control plane on TCP. See [Daemon](daemon.md) for the process
itself and [Control plane](../concepts/control-plane.md) for the full RPC
reference.

```bash
# Start daemon on the default TCP target: http://127.0.0.1:9700
ocpp-cp-sim --daemon &

# Start daemon with an initial CP and default TCP control plane
ocpp-cp-sim --ws-url ws://localhost:9000/ocpp --cp-id CP001 --daemon &

# Start foreground server on a custom TCP port
ocpp-cp-sim --http-port 9701

# Daemon + bundled browser UI
ocpp-cp-sim --daemon --web-console
```

#### Server Files

| File                   | Description                               |
| ---------------------- | ----------------------------------------- |
| `/tmp/ocpp-server.pid` | PID file for duplicate detection (daemon) |

There is no Unix-domain socket listener. `--unix-socket <path|none>` is still
accepted for launcher compatibility, prints a deprecation warning, and is
ignored (see [REST → Socket.IO migration](../analyses/rest-to-socketio-migration.md)).

**Network Simulation** — configuration is applied at runtime via the daemon's
Socket.IO RPC methods or MCP tools; there are no `--network-sim-*` startup
flags. See [Network simulation](../concepts/network-simulation.md).

#### Multiple Charge Points in One Process

`--cp-id` becomes optional in server mode. A whole fleet can be bootstrapped
from the flags:

```bash
# CP001 .. CP020, all pointed at the same CSMS
ocpp-cp-sim --http-port 5172 --cp-id CP --cp-count 20 \
            --ws-url wss://csms.example.com/ocpp/
```

`--cp-id-pattern` overrides the generated ids (`--cp-id-pattern "site-a-{n:04}"`).
A startup scenario, if given, is loaded onto every charge point in the fleet.

The whole fleet is registered before anything dials the CSMS, so `cp.list`
answers immediately even against an unreachable one; connecting then proceeds
8 charge points at a time. For SOAP, `--soap-public-base-url` is re-derived per
generated id, while an explicit `--soap-callback-url` must carry the same `{n}`
placeholder — one callback address cannot route a fleet.

Additional CPs can also be added at runtime with the browser UI, the
`cp.create` Socket.IO RPC method, or `cp.create_many` for a batch:

```js
await rpc({
  method: "cp.create",
  params: {
    cpId: "CP001",
    wsUrl: "ws://localhost:9000/ocpp",
    connectors: 1,
    autoConnect: true,
  },
});
```

#### Startup Scenarios

Run a scenario automatically when bootstrapping a CP at startup. All three
sources can target a single connector, a comma-separated list, or every
connector via `--scenario-connector all`.

```bash
# Built-in template on connector 1
ocpp-cp-sim --daemon --ws-url ws://localhost:9000/ocpp --cp-id CP001 \
  --scenario-template full-charging-cycle --scenario-connector 1

# Concrete scenario JSON file (cpId/connectorId baked in)
ocpp-cp-sim --daemon --ws-url ws://localhost:9000/ocpp --cp-id CP001 \
  --scenario /path/to/scenario.json --scenario-connector 1

# cpId-independent template JSON applied to every connector
ocpp-cp-sim --daemon --ws-url ws://localhost:9000/ocpp --cp-id CP001 --connectors 5 \
  --scenario-template-file /path/to/template.json \
  --scenario-connector all

# Or pick specific connectors
ocpp-cp-sim --daemon ... --scenario-template-file /path/to/template.json \
  --scenario-connector 1,3,5
```

`--scenario-template-file` reads a JSON file shaped like a
`ScenarioDefinition` (the format the browser Scenario Editor exports — see
[Scenario format](../concepts/scenario-format.md) for the field reference and
the published [JSON Schema](../../schema/scenario.schema.json)), then clones it
per connector — rewriting `targetType`, `targetId`, `id`, and `name` — so each
connector runs an independent state machine from the same file. `--scenario`
and `--scenario-template` fan out the same way when `--scenario-connector`
resolves to more than one id. Both `--scenario` and `--scenario-template-file`
validate the file against that schema at load time and warn (never reject)
on a mismatch. Built-in template ids are listed in
[Scenario templates](scenario-templates.md).

### 4. Client Modes (`--send` / `--events` / `--stop`)

The same binary doubles as a TCP Socket.IO client for a running daemon. Client
modes default to `http://127.0.0.1:9700`, so `--http-url` is optional for a
bare local daemon.

```bash
# Send command to a running local daemon (default target is 127.0.0.1:9700)
ocpp-cp-sim --cp-id CP001 --send '{"command":"status"}'

# Send command via an explicit TCP URL
ocpp-cp-sim --cp-id CP001 --http-url http://127.0.0.1:9701 \
  --send '{"command":"status"}'

# Subscribe to real-time events for one CP
ocpp-cp-sim --cp-id CP001 --events

# Subscribe to all CP and registry events
ocpp-cp-sim --events --all

# Talk to a daemon protected by --web-console-basic-auth-*
ocpp-cp-sim --cp-id CP001 --http-url http://127.0.0.1:9700 \
  --send '{"command":"status"}' \
  --http-basic-auth-user admin --http-basic-auth-pass secret

# Shut down the server
ocpp-cp-sim --stop
```

`--send` is for CP-scoped JSON commands and requires `--cp-id`. Daemon-level
methods such as `cp.create`, `logs.get`, and `state.reset` are available over
the Socket.IO RPC contract documented in
[Control plane → Daemon methods](../concepts/control-plane.md#daemon-methods)
and through the browser UI. How the client authenticates to a protected
daemon is covered in [Access control](../concepts/access-control.md#authenticating-to-a-protected-daemon).

## Subcommands

### analyze

`ocpp-cp-sim analyze <trace.jsonl>` runs OCPP DebugKit's failure-pattern
detection over a [trace file](../concepts/trace-format.md) or a running
daemon's stored logs and writes a Markdown / HTML report. It has its own page:
[analyze](analyze.md).

### export-k6

Export a scenario JSON as a runnable [k6](https://k6.io) load-test bundle:

```shell
ocpp-cp-sim export-k6 --scenario charge.json -o loadtest/
```

The bundle contains a `scenario.k6.ts` entry, a self-contained TypeScript
OCPP runtime (`ocpp-runtime/`), the scenario, and a README with the full
environment-variable reference (`PROFILE=spike|steady|soak`, `VUS`,
`CP_IDS_FILE`, mTLS notes). Requires k6 >= v1.6.0 (the bundle uses the
stable `k6/websockets` module, not the deprecated
`k6/experimental/websockets`). Phase 1 supports OCPP 1.6J.

```shell
CSMS_URL=wss://csms.example.com/ocpp k6 run loadtest/scenario.k6.ts
```

## Events

Events are emitted in all modes:

- REPL shows formatted text.
- JSON Lines mode emits JSON event lines.
- Daemon mode emits Socket.IO `event` envelopes with `kind: "cp"` or
  `kind: "registry"` (see [Control plane → Event push and rooms](../concepts/control-plane.md#event-push-and-rooms)).

| Event                   | Data Fields                               | Description                  |
| ----------------------- | ----------------------------------------- | ---------------------------- |
| `connected`             | -                                         | Connected to CSMS            |
| `disconnected`          | `code`, `reason`                          | Disconnected from CSMS       |
| `status_change`         | `status`                                  | Charge point status changed  |
| `error`                 | `error`                                   | Error occurred               |
| `connector_status`      | `connectorId`, `status`, `previousStatus` | Connector status changed     |
| `transaction_started`   | `connectorId`, `transactionId`, `tagId`   | Transaction started          |
| `transaction_stopped`   | `connectorId`, `transactionId`            | Transaction stopped          |
| `meter_value`           | `connectorId`, `meterValue`               | Meter value updated          |
| `scenario_started`      | `connectorId`, `scenarioId`               | Scenario execution started   |
| `scenario_completed`    | `connectorId`, `scenarioId`               | Scenario execution completed |
| `scenario_error`        | `connectorId`, `scenarioId`, `error`      | Scenario execution failed    |
| `scenario_node_execute` | `connectorId`, `scenarioId`, `nodeId`     | Scenario node executed       |

## CLI Options

| Option                              | Required | Default                                 | Description                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------- | -------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--cp-id <id>`                      | Yes\*    | -                                       | Charge Point ID                                                                                                                                                                                                                                                                                                                                |
| `--ws-url <url>`                    | Yes\*\*  | -                                       | WebSocket URL of CSMS (or the SOAP `CentralSystemService` URL for SOAP versions, see [OCPP versions & transports](../concepts/ocpp-versions-and-transports.md))                                                                                                                                                                                |
| `--connectors <n>`                  | No       | `1`                                     | Number of connectors                                                                                                                                                                                                                                                                                                                           |
| `--cp-count <n>`                    | No       | `1`                                     | Server mode: bootstrap N charge points instead of one, sharing every option but the id (#295)                                                                                                                                                                                                                                                  |
| `--cp-id-pattern <tpl>`             | No       | `<cp-id>{n:03}`                         | Id template used with `--cp-count`. `{n}` is the index, `{n:03}` zero-pads it                                                                                                                                                                                                                                                                  |
| `--ocpp-version <ver>`              | No       | `OCPP-1.6J`                             | `OCPP-1.6J`, `OCPP-2.0.1`, `OCPP-2.1`, or the SOAP versions `OCPP-1.2`, `OCPP-1.5`, `OCPP-1.6S`, for a directly started or bootstrapped CP                                                                                                                                                                                                     |
| `--soap-callback-url <url>`         | No       | -                                       | SOAP versions: full callback URL the CSMS reaches the CP on (used verbatim)                                                                                                                                                                                                                                                                    |
| `--soap-public-base-url <url>`      | No       | -                                       | SOAP versions: public base the callback URL is derived from (`<base><soap-path>/<cp-id>/ChargePointService`)                                                                                                                                                                                                                                   |
| `--soap-path <path>`                | No       | `/ocpp/soap`                            | Path prefix of the daemon-hosted SOAP `ChargePointService` endpoint                                                                                                                                                                                                                                                                            |
| `--json`                            | No       | -                                       | JSON Lines mode                                                                                                                                                                                                                                                                                                                                |
| `--daemon`                          | No       | -                                       | Server daemon. With no `--http-port`, listens on `http://127.0.0.1:9700`.                                                                                                                                                                                                                                                                      |
| `--http-port <port>`                | No       | `9700` with bare `--daemon`             | Enable the TCP health / Socket.IO server on this port                                                                                                                                                                                                                                                                                          |
| `--http-host <addr>`                | No       | `127.0.0.1`                             | Bind address for HTTP. Non-loopback binds require web-console Basic Auth or `--unsafe-remote`.                                                                                                                                                                                                                                                 |
| `--unsafe-remote`                   | No       | -                                       | Allow a non-loopback daemon bind without `--web-console-basic-auth-user/pass`. Use only on trusted networks.                                                                                                                                                                                                                                   |
| `--unix-socket <path\|none>`        | No       | deprecated no-op                        | Accepted for launcher compatibility, prints one warning, and is ignored.                                                                                                                                                                                                                                                                       |
| `--web-console [<port>]`            | No       | -                                       | Serve the bundled browser UI alongside Socket.IO. Without a port, shares `--http-port`; with a port, serves on that listener. Needs a directory with `index.html`: `<repo>/dist` after `bun run build`, the `dist/` a release package ships, a `dist/` beside the binary, or `--web-console-dist`. On failure it names every path it searched. |
| `--web-console-dist <dir>`          | No       | -                                       | Serve the console from this directory instead of searching. Must contain `index.html`; a wrong path is an error, never a silent fallback. The [desktop app](desktop-app.md#how-the-sidecar-finds-the-web-console) passes its Tauri resource dir here (#319).                                                                                   |
| `--web-console-basic-auth-user <u>` | No       | -                                       | Basic Auth user for incoming static assets and Socket.IO handshake auth. Pair with `--web-console-basic-auth-pass`. The configured health path is exempt.                                                                                                                                                                                      |
| `--web-console-basic-auth-pass <p>` | No       | -                                       | Basic Auth password for incoming static assets and Socket.IO handshake auth. Pair with `--web-console-basic-auth-user`.                                                                                                                                                                                                                        |
| `--http-url <url>`                  | No       | `http://127.0.0.1:9700` in client modes | Client target: TCP HTTP base URL for Socket.IO                                                                                                                                                                                                                                                                                                 |
| `--send <json>`                     | No       | -                                       | Send a CP-scoped JSON command to a running server                                                                                                                                                                                                                                                                                              |
| `--events`                          | No       | -                                       | Subscribe to daemon events over Socket.IO                                                                                                                                                                                                                                                                                                      |
| `--all`                             | No       | -                                       | With `--events`, subscribe to all CP and registry events                                                                                                                                                                                                                                                                                       |
| `--stop`                            | No       | -                                       | Shut down the running server with `server.shutdown`                                                                                                                                                                                                                                                                                            |
| `--http-basic-auth-user <u>`        | No       | -                                       | Basic Auth user the client modes (`--send`/`--stop`/`--events`) send as Socket.IO handshake auth to a daemon protected by `--web-console-basic-auth-*`                                                                                                                                                                                         |
| `--http-basic-auth-pass <p>`        | No       | -                                       | Basic Auth password for the client modes (pair with `--http-basic-auth-user`)                                                                                                                                                                                                                                                                  |
| `--basic-auth-user <u>`             | No       | -                                       | Basic auth username for outgoing CP → CSMS WebSocket                                                                                                                                                                                                                                                                                           |
| `--basic-auth-pass <p>`             | No       | -                                       | Basic auth password for outgoing CP → CSMS WebSocket                                                                                                                                                                                                                                                                                           |
| `--header KEY:VALUE`                | No       | -                                       | Extra header for the outgoing CP → CSMS WebSocket upgrade. Repeatable.                                                                                                                                                                                                                                                                         |
| `--ws-subprotocol <value>`          | No       | -                                       | Extra subprotocol for the outgoing CP → CSMS WebSocket upgrade. Repeatable.                                                                                                                                                                                                                                                                    |
| `--security-profile <0\|1\|2\|3>`   | No       | `0`                                     | OCPP 1.6 security profile enforcement for the CP → CSMS transport. See [Security profiles](../concepts/security-profiles.md).                                                                                                                                                                                                                  |
| `--authorization-key <hex>`         | No       | -                                       | `AuthorizationKey` used as the Basic Auth password for profiles 1 and 2                                                                                                                                                                                                                                                                        |
| `--tls-ca <path>`                   | No       | -                                       | PEM CA bundle used to verify the CSMS server certificate                                                                                                                                                                                                                                                                                       |
| `--tls-cert <path>`                 | No       | -                                       | PEM client certificate for profile 3 mutual TLS                                                                                                                                                                                                                                                                                                |
| `--tls-key <path>`                  | No       | -                                       | PEM client private key for profile 3 mutual TLS; must be mode `0600`                                                                                                                                                                                                                                                                           |
| `--cpo-name <name>`                 | No       | -                                       | CPO name used when generating certificate signing requests                                                                                                                                                                                                                                                                                     |
| `--insecure-tls-key-perms`          | No       | -                                       | Allow a `--tls-key` file readable by group/other (local testing only)                                                                                                                                                                                                                                                                          |
| `--vendor <vendor>`                 | No       | `CLI-Vendor`                            | Charge point vendor                                                                                                                                                                                                                                                                                                                            |
| `--model <model>`                   | No       | `CLI-Model`                             | Charge point model                                                                                                                                                                                                                                                                                                                             |
| `--scenario <file>`                 | No       | -                                       | Startup scenario JSON file (server mode)                                                                                                                                                                                                                                                                                                       |
| `--scenario-template <id>`          | No       | -                                       | Built-in scenario template id (server mode) — see [Scenario templates](scenario-templates.md)                                                                                                                                                                                                                                                  |
| `--scenario-template-file <p>`      | No       | -                                       | Path to a cpId-independent template JSON                                                                                                                                                                                                                                                                                                       |
| `--scenario-connector <list>`       | No       | `1`                                     | `all`, single id (`1`), or list (`1,2,3`)                                                                                                                                                                                                                                                                                                      |
| `--state-db <path>`                 | No       | _(in-memory)_                           | Persist scenarios, ChangeConfiguration overrides, charging profile state, availability flags, pending transaction messages, registered CPs and logs to a SQLite file. See [State persistence](../concepts/state-persistence.md).                                                                                                               |
| `--log-format <fmt>`                | No       | `plain`                                 | `plain` writes the legacy `[ts] [LEVEL] [TYPE] message` lines; `json` writes one JSON Lines object per line (same shape as the `logs` table + browser export + `logs.get` RPC). See [Log format](../concepts/log-format.md).                                                                                                                   |
| `--trace-output <path>`             | No       | -                                       | Append each OCPP-J (WebSocket) wire message as a JSONL trace record ([Trace format](../concepts/trace-format.md)) in REPL, JSON, and daemon modes; SOAP transport is not captured yet.                                                                                                                                                         |
| `--health-path <path>`              | No       | `/v1/healthz`                           | Absolute path for the unauthenticated health-check JSON. The browser UI build must use matching `VITE_HEALTH_PATH` when this changes.                                                                                                                                                                                                          |
| `--metrics`                         | No       | off                                     | Server mode: serve `GET /metrics` (Prometheus text exposition). See [Daemon → Metrics](daemon.md#metrics)                                                                                                                                                                                                                                      |
| `--metrics-no-auth`                 | No       | off                                     | Implies `--metrics` and serves it outside the Basic Auth gate. Trusted networks only                                                                                                                                                                                                                                                           |
| `--cors-origin <origin>`            | No       | loopback: open; remote: same-origin     | Restrict browser Origins. Repeatable. Pass literal `"*"` to opt into open CORS. See [Access control](../concepts/access-control.md).                                                                                                                                                                                                           |
| `--trust-forwarded-headers`         | No       | -                                       | With same-origin CORS, also accept the public origin reported by `X-Forwarded-Proto` / `X-Forwarded-Host`. Use only behind a trusted reverse proxy.                                                                                                                                                                                            |

\* `--cp-id` is **optional** in server mode (no bootstrap CP). Required for
REPL/JSON and for `--send`/`--events` without `--all`.

\*\* `--ws-url` is required for REPL/JSON, and only when bootstrapping a CP in
server mode. CPs created later via Socket.IO `cp.create` supply their own
`wsUrl` in the RPC params.
