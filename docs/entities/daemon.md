---
title: Daemon (server mode)
type: entity
summary: The long-lived Bun process that hosts many charge points and exposes one Socket.IO control plane, health, optional web-console assets, SOAP callbacks, and the MCP endpoint over a single HTTP port.
sources:
  - src/cli/server/
  - src/cli/main.ts
related:
  - cli.md
  - web-console.md
  - docker-image.md
  - mcp-endpoint.md
  - ../concepts/control-plane.md
  - ../concepts/access-control.md
  - ../concepts/state-persistence.md
  - ../concepts/log-format.md
  - ../analyses/fleet-load-and-observability-roadmap.md
updated: 2026-09-05
---

# Daemon (server mode)

The simulator can run as a long-lived Bun process. A single daemon can host
**many charge points** concurrently and exposes one Socket.IO control plane for
the browser UI, the bundled CLI client, and external agents. The wire contract
of that control plane is documented in [Control plane](../concepts/control-plane.md);
this page is about the process itself.

HTTP is only the carrier:

- `GET /v1/healthz` returns `{ "ok": true, "version": "…" }` and is unauthenticated.
- `GET/POST /socket.io/` are the Socket.IO / Engine.IO transport paths.
- Static assets are served only when `--web-console` is enabled.
- All former REST control endpoints and the Unix-domain socket listener are
  removed (see [REST → Socket.IO migration](../analyses/rest-to-socketio-migration.md)).

> All examples below use the installed `ocpp-cp-sim` command. From a source
> checkout (no install), `bun src/cli/main.ts …` is interchangeable everywhere.

## Starting the Server

```bash
# Background daemon on TCP loopback (default http://127.0.0.1:9700)
ocpp-cp-sim --daemon &

# Background daemon on a custom TCP port
ocpp-cp-sim --daemon --http-port 9701 &

# Foreground Socket.IO server
ocpp-cp-sim --http-port 9700

# Daemon + bundled browser UI on the same origin
ocpp-cp-sim --daemon --web-console

# Bootstrap a CP at startup
ocpp-cp-sim --daemon \
  --cp-id CP001 --ws-url ws://localhost:9000/ocpp &

# Bind beyond loopback only with Basic Auth or an explicit unsafe override
ocpp-cp-sim --daemon --http-host 0.0.0.0 \
  --web-console-basic-auth-user admin \
  --web-console-basic-auth-pass secret
```

| Flag                                | Default                      | Description                                                                                                                                                                                                                                                                              |
| ----------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--daemon`                          | -                            | Background server. When no `--http-port` is supplied, listens on `127.0.0.1:9700`.                                                                                                                                                                                                       |
| `--http-port <port>`                | `9700` with bare `--daemon`  | TCP port for health, Socket.IO, and optional web console assets.                                                                                                                                                                                                                         |
| `--http-host <addr>`                | `127.0.0.1`                  | TCP bind address. Non-loopback binds require either `--web-console-basic-auth-user/pass` or `--unsafe-remote`.                                                                                                                                                                           |
| `--cp-count <n>`                    | `1`                          | Bootstrap N charge points instead of one, sharing every option but the id. Requires `--cp-id` as the id stem, and a server mode (#295).                                                                                                                                                  |
| `--cp-id-pattern <tpl>`             | `<cp-id>{n:03}`              | Id template used with `--cp-count`. `{n}` is the index, `{n:03}` zero-pads it. The fleet registers before it dials, then connects 8 at a time.                                                                                                                                           |
| `--metrics`                         | off                          | Serve `GET /metrics` (Prometheus text exposition). Off by default; the path 404s without it. See [Metrics](#metrics).                                                                                                                                                                    |
| `--metrics-no-auth`                 | off                          | Implies `--metrics` and serves it outside the Basic Auth gate. Trusted networks only; exempts nothing else.                                                                                                                                                                              |
| `--watch`                           | off                          | Re-read the idTag and scenario files this daemon loaded when they change on disk, debounced. Off by default; **refused outside a server mode** (`--daemon`, `--http-port`, `--web-console`) rather than accepted and ignored. See [File hot-reload](#file-hot-reload) (#314).            |
| `--unsafe-remote`                   | -                            | Allows a non-loopback daemon bind without web-console Basic Auth. Use only on trusted networks or when another boundary handles access.                                                                                                                                                  |
| `--web-console [<port>]`            | -                            | Serve the bundled browser UI alongside health and Socket.IO. Without a port, shares `--http-port`; with a port, serves the UI on that listener.                                                                                                                                          |
| `--web-console-dist <dir>`          | -                            | Serve the console from this directory instead of searching for a bundled `dist/`. Must contain `index.html`; a path that does not is a startup error, not a fallback. The [desktop app](desktop-app.md#how-the-sidecar-finds-the-web-console) passes its Tauri resource dir here (#319). |
| `--web-console-basic-auth-user <u>` | -                            | Enables inbound Basic Auth for static assets and the Socket.IO handshake. Must be paired with `--web-console-basic-auth-pass`. The configured health path is exempt.                                                                                                                     |
| `--web-console-basic-auth-pass <p>` | -                            | Password for the inbound web-console / Socket.IO auth gate.                                                                                                                                                                                                                              |
| `--cors-origin <origin>`            | loopback: open; remote: same | Restrict browser Origins. Repeat for an allowlist, or pass literal `"*"` to opt into open CORS. See [Access control → CORS](../concepts/access-control.md#cors).                                                                                                                         |
| `--trust-forwarded-headers`         | -                            | With same-origin CORS, also accept the public origin reported by `X-Forwarded-Proto` and `X-Forwarded-Host`. Use only behind a trusted reverse proxy.                                                                                                                                    |
| `--unix-socket <path\|none>`        | deprecated accepted no-op    | Accepted for launcher compatibility, prints a warning, and is ignored. The control plane is TCP Socket.IO only.                                                                                                                                                                          |
| `--state-db <path>`                 | _(in-memory)_                | Persist scenarios, ChangeConfiguration overrides, charging profile state, availability flags, pending transaction messages, registered CPs and logs to a SQLite file (see [State persistence](../concepts/state-persistence.md)).                                                        |
| `--log-format <fmt>`                | `plain`                      | `plain` writes the legacy `[ts] [LEVEL] [TYPE] message` lines; `json` writes one JSON Lines object per line for structured-log collectors (see [Log format](../concepts/log-format.md)).                                                                                                 |
| `--health-path <path>`              | `/v1/healthz`                | Absolute path for the health-check JSON. The default is the only built-in health endpoint; set a custom path only when a proxy reserves the default.                                                                                                                                     |
| `--soap-path <path>`                | `/ocpp/soap`                 | Path prefix of the hosted OCPP-S `ChargePointService` callback endpoint (see [OCPP versions & transports](../concepts/ocpp-versions-and-transports.md)).                                                                                                                                 |

The full flag list, including the CP-bootstrap and startup-scenario flags, is
in [CLI → CLI Options](cli.md#cli-options).

## HTTP Surfaces

| Method | Path                                  | Auth                                          | Returns / purpose                                                                                                     |
| ------ | ------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/healthz`                         | Exempt                                        | `{ "ok": true, "version": "…" }`; used for browser Local/Remote detection, readiness checks, and Docker healthchecks. |
| GET    | `/socket.io/`                         | Socket.IO handshake auth if enabled           | Engine.IO polling / upgrade transport. Not a REST control endpoint.                                                   |
| POST   | `/socket.io/`                         | Socket.IO handshake auth if enabled           | Engine.IO polling transport. Not a REST control endpoint.                                                             |
| POST   | `<soapPath>/:cpId/ChargePointService` | HTTP Basic Auth if enabled or trusted network | OCPP SOAP (1.2 / 1.5 / 1.6S) CSMS-to-CP callback endpoint. Default `soapPath` is `/ocpp/soap`.                        |
| POST   | `/mcp`                                | HTTP Basic Auth if enabled                    | MCP Streamable HTTP endpoint (tools-only, stateless JSON-RPC). See [MCP endpoint](mcp-endpoint.md).                   |
| GET    | `/metrics`                            | HTTP Basic Auth if enabled (see below)        | Prometheus text exposition, when `--metrics` is passed. 404 otherwise. See [Metrics](#metrics).                       |
| GET    | static asset URL                      | HTTP Basic Auth if enabled                    | Web console assets when `--web-console` is enabled. Unknown page paths fall back to `index.html`.                     |

Every other `/v1/*` path returns `404`.

The OCPP SOAP callback endpoint (1.2 / 1.5 / 1.6S) relies on the same HTTP
Basic-auth gate as the web console, or on a trusted network boundary when that
gate is disabled. OCPP-S has no per-message authentication field, so the
simulator does not add a non-standard shared secret to SOAP payloads.

## Health

```
GET /v1/healthz
→ { "ok": true, "version": "0.7.6" }
```

`ok` is what readiness probes assert on. `version` is the running build, so you
can confirm which image a deployment is actually serving without an
authenticated round-trip. It reads `APP_VERSION` if set, otherwise the release's
stamped `package.json`, and reports `0.0.0-dev` for an unstamped build — never a
bare `0.0.0` that could be mistaken for a release. The same value appears as
`scenario_report.simulatorVersion` and MCP `serverInfo.version`.

The path is configurable via `--health-path <path>` (default `/v1/healthz`).
Change it when a reverse proxy in front of the daemon reserves the default path
— for example Google Front End in front of Cloud Run returning 404 directly on
certain reserved paths before the request hits the container.

The browser UI's Remote-mode auto-detect probe targets the path inlined at UI
build time via `VITE_HEALTH_PATH` (same default). The UI build value and daemon
`--health-path` must match (see [Local vs Remote mode](../concepts/local-vs-remote-mode.md)
and [Docker image → Custom health-check path](docker-image.md#custom-health-check-path)).

## Metrics

`--metrics` serves `GET /metrics` as Prometheus text exposition (`text/plain;
version=0.0.4`). It is **opt-in**: without the flag the path answers `404`
explicitly — reserved rather than left to fall through to the web console's
SPA fallback, which would otherwise answer `200` with `index.html` and let a
scraper read HTML as a successful scrape. Setting `--health-path /metrics`
alongside `--metrics` is refused at startup, since the health route matches
first and would leave the metrics endpoint unreachable.

| Metric                              | Type      | Labels                | Meaning                                     |
| ----------------------------------- | --------- | --------------------- | ------------------------------------------- |
| `ocppcp_charge_points`              | gauge     | `state`               | Registered charge points by current status. |
| `ocppcp_connectors`                 | gauge     | `status`              | Connectors across all charge points.        |
| `ocppcp_transactions_active`        | gauge     | —                     | Connectors currently in a transaction.      |
| `ocppcp_ocpp_messages_total`        | counter   | `action`, `direction` | OCPP messages observed.                     |
| `ocppcp_ocpp_call_errors_total`     | counter   | `action`              | CALLERROR frames.                           |
| `ocppcp_ocpp_call_duration_seconds` | histogram | `action`              | CALL to CALLRESULT/CALLERROR round trip.    |
| `ocppcp_rpc_requests_total`         | counter   | `method`, `outcome`   | Control-plane rpc calls.                    |
| `ocppcp_ws_reconnects_total`        | counter   | —                     | WebSocket reconnect attempts.               |

**No `cpId` label, deliberately.** It is unbounded by construction once a
daemon holds a fleet, and a Prometheus server pays for every series it has ever
seen. Per-charge-point detail stays in `cp.list` and the event stream.

**`/metrics` is behind the Basic Auth gate by default**, unlike
[`/v1/healthz`](#health). The health probe is exempt because container probes
need it unprompted and it says almost nothing; `/metrics` exposes fleet size
and traffic shape. `--metrics-no-auth` (which implies `--metrics`) serves it
outside the gate for a trusted network — and exempts nothing else.

Gauges are read from the live registry at scrape time rather than tracked
incrementally: a charge point's state changes through many paths (RPC,
scenario, CSMS command, reconnect), and a counter that had to be decremented on
every one of them would drift. `ocppcp_transactions_active` counts connectors
with a transaction start time rather than a transaction id — the numeric id is
`0` until the CSMS answers `StartTransaction` on 1.6 and is never set at all on
2.x.

Message counters come from the same log-stream seam `--trace-output` uses, so
they cover OCPP-J and SOAP alike. `ocppcp_ocpp_call_duration_seconds` is
**OCPP-J only**: a SOAP log line carries no message id, so there is nothing to
correlate a response back to its request with.

`--metrics` must be passed at startup. Charge points restored from
`--state-db` subscribe as they are constructed, so a recorder created later
would leave every persisted charge point visible in the gauges and silent in
every counter.

## Controlling a Running Daemon

Three clients speak the control plane:

- the [web console](web-console.md) in Remote mode,
- the bundled [CLI client modes](cli.md#4-client-modes---send----events----stop)
  (`--send`, `--events`, `--stop`, `analyze --from-daemon`),
- any external Socket.IO client, MCP client ([MCP endpoint](mcp-endpoint.md))
  or the [Java/Testcontainers harness](../sources/testcontainers-java-readme.md).

Authenticating those clients to a daemon started with
`--web-console-basic-auth-*` is described in
[Access control → Authenticating to a protected daemon](../concepts/access-control.md#authenticating-to-a-protected-daemon).

## Security posture

The default bind address is `127.0.0.1`. Exposing the daemon beyond loopback
requires either `--web-console-basic-auth-user/pass` or `--unsafe-remote`, and
should be paired with a tight `--cors-origin` allowlist when browsers can reach
the daemon. The full rules — bind gate, Basic Auth, CORS modes, reverse
proxies — are in [Access control](../concepts/access-control.md).

## Docker

A `Dockerfile` and `docker-compose.yml` ship at the repo root, and a multi-arch
image is published on every push to `main` / version tag at
`ghcr.io/shiv3/ocpp-cp-simulator`. The image is the daemon with
`--http-host 0.0.0.0 --unsafe-remote --web-console` pinned in its entrypoint —
see [Docker image](docker-image.md).

## File hot-reload

`--watch` (#314) makes the daemon re-read the files it loaded when they change,
so editing a file by hand does not mean deleting and recreating a charge point.
It is **off by default**: a daemon that silently re-reads files under the
operator is surprising, and the agent-driven workflows this project is built
around go through the [control plane](../concepts/control-plane.md), where there
is nothing on disk to re-read. `--watch` serves the human editing a file.

The watcher lives in the daemon, so `--watch` **is refused outside a server
mode** (`--daemon`, `--http-port`, `--web-console`) rather than parsed and then
ignored — the same rule `--cp-count` follows (#295). It is also **refused
alongside a client mode** (`--send`, `--stop`, `--events`), even with a server
flag present: those return through the client path before any server starts,
and `--http-port` in their company names the daemon to talk to rather than a
port to listen on, so `--events --http-port 9000 --watch` would otherwise pass a
server-flag-only check and still be ignored.

What is watched — and only these, because these are the only paths the daemon
reads and then keeps a copy of:

| File                               | Reached by                                                                                            | What a reload does                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `idTagPool.file` on a charge point | `cp.create` / `cp.update` / `cp.create_many`, and a `--state-db` restore of any of them               | Replaces the pool **live** on every charge point that was created from that path. The next session draws the new tags. |
| A scenario file                    | `--scenario`, `--scenario-template-file`, and the `load_scenario { file }` / `run_scenario_file` RPCs | Replaces the definition **under the same scenario id**, unless the connector is mid-session — see the rule below.      |

The rules, in the order they bite:

- **Debounced.** Editors save in bursts — write a temp file, rename it over the
  target, touch the mtime — so an undebounced watch fires two or three times per
  save and can read a truncated intermediate file. The watch waits 200 ms after
  the last event, then reads once. Identical bytes are not a reload and produce
  no event.
- **A malformed file never lands, and `rejected` is true of everything.** The
  reload path applies exactly the checks the load path applies, and an idTag
  pool is written to `--state-db` **before** the live pool is touched — so a
  write that fails leaves the daemon exactly as it was, and the event, the
  running daemon and the stored state cannot disagree. (Persist-first rather
  than mutate-then-roll-back: a rollback would expose a window in which a
  concurrent draw presents a tag that is not durable.) A file that fails them is
  logged, reported as `rejected`, and the previous good copy stays in place — a half-saved file
  never leaves a charge point with half a configuration. A reload the control
  plane could not announce is refused the same way and for the same reason:
  applying it would leave every subscriber on the previous graph with nothing to
  say so. What is checked is the **resulting `scenario-definitions-changed`
  snapshot**, not the edited file — that envelope carries every definition on the
  connector, capped at 1 000 entries of at most 256 KiB serialized each, so an
  oversized _sibling_ scenario, or a connector already holding more scenarios
  than fit, refuses the edit even when the edited file is small. The rejection
  names the scenario id at fault.
- **A reload never mutates a charge point mid-session.** A scenario reload for a
  connector with an open transaction, or for a scenario whose run is in flight,
  is _held_ — not dropped — and installed when that session ends. An in-flight
  transaction therefore always runs to completion on the values it started with.
  A held reload that is refused when it finally drains — a sibling scenario grew
  past the envelope cap while the session was open, say — clears its baseline
  with it, so saving those same bytes again is judged afresh rather than
  dismissed as unchanged. `lastText` names the bytes the daemon took
  responsibility for; a rejection never advances it and a failed drain clears
  it.
  A held definition is applied when the transaction stops **or when the run's
  cleanup completes**, whichever released the gate — whether the run reached the
  end of its graph, errored, or was stopped by hand with `stop_scenario`. The
  A held definition is never installed from inside the call that released it —
  not from a teardown whose own gate has already opened, and not from a registry
  mutation. Both drain triggers defer to a later microtask, so the enclosing
  synchronous work always finishes first. "The gate is clear" is not a
  sufficient condition, because installing a definition can auto-start a run
  that snapshots connector state the gate says nothing about. There are exactly
  two triggers: the settled hook, which fires where a gate actually opens, and
  the registry sync, which fires on any change to a charge point's init options
  because a `cp.update` rebuild takes the old service's lifecycle handlers with
  it and nothing else would retry. The registry ping itself stays synchronous —
  its subscriber must see the registry as the mutation left it, and the file
  watches it establishes must not be delayed — so only the drain at the end of
  it is deferred.
  The daemon waits for the blocking state to actually clear, never for the
  lifecycle event that announces it: every such event on the control plane is
  published from inside the code that is ending the thing, while the state it
  announces is still set — `scenario_completed` with the run's executor still
  registered, `transaction_stopped` and `Finishing` several statements before
  the transaction is cleared. A held reload is therefore released from the three
  points where a gate genuinely opens (a run's cleanup, a connector's
  transaction being dropped, and `reset_scenario`), which is why it lands even
  with `set_auto_reset_to_available` off, where no later `Available` status
  would arrive to retry on. A `cp.update` that rebuilds the charge point
  releases it too: the rebuild ends the session, and the held definition is
  applied to the replacement once its scenarios are back.
  An idTag pool is exempt by construction: it is drawn from once per session, so
  the transaction under way keeps the tag it presented at StartTransaction and
  only the next draw sees the new list.
- **Removing or replacing a scenario drops its watch.** Every path that takes a
  definition away drops it, and they are enumerated in one place in the code so
  a new one is noticed: `remove_scenario` (runtime and stored definition);
  a `load_scenario` that installs an inline definition under the same id;
  `scenario.definitions.delete`, which removes only the stored row and leaves
  the runtime scenario loaded — so without this the next edit would reload and
  persist exactly what was deleted; and a `scenario.definitions.replace`
  upload, which makes the console the source of truth for that connector's
  whole set. `scenario.definitions.save` is an upsert and removes nothing;
  `cp.delete` and `state.reset` are handled at the registry and schema level
  because they are about a charge point rather than one scenario. Without that the file would stay
  authoritative and the next edit would re-create a scenario the operator
  deleted, or overwrite the definition they had just uploaded. The reload path
  checks as well: a scenario the charge point no longer holds is **never
  re-created** by an edit, whichever path removed it.
- **A scenario keeps the connector it was loaded onto, and the id it was loaded
  under.** An edited `targetType` / `targetId` is re-applied to the connector the
  scenario is registered for, on every reload — a startup `--scenario` fanned out
  across connectors keeps its independent copies, and a single-connector one
  repointed by hand is rewritten back rather than left waiting on a connector it
  is not attached to. If the edited file's own `id`
  changed, it is ignored. Honouring it would load a _second_ scenario and leave
  the first one in place under the old definition.
- **Blueprints are not watched, and do not need to be.** A blueprint is stored
  through `blueprint.save` and lives in the `blueprints` table, not in a file
  (#297 declined a watched blueprint file deliberately, so the control plane
  stays the single source of truth). The file a blueprint can _reference_ — its
  `params.idTagPool.file` — is re-read at every `cp.create_many` instantiation,
  which is why editing it affects charge points created from the blueprint
  **afterwards** and never retroactively: charge points instantiated from a
  blueprint are independent copies, not live views of it.
- **Watching degrades, it never fails to start.** `fs.watch` is unreliable on
  network mounts and some container filesystems. When it cannot be established
  the daemon logs one line saying watching is unavailable and carries on
  unwatched, rather than refusing to start over a convenience.

Every reload pushes a `file-reload` event on the control plane carrying
`target`, `path`, `cpId`, `connectorId`, `scenarioId` and an `outcome` of
`applied`, `deferred` or `rejected` — see
[Control plane → Event push and rooms](../concepts/control-plane.md#event-push-and-rooms).
A **scenario** reload additionally pushes the ordinary
`scenario-definitions-changed` update for that connector, because the console's
scenario editor subscribes to the `scenario-definitions` scope and would
otherwise keep showing the graph the daemon had stopped executing. Those
definitions are the connector's live runtime set, not a read-back of the
scenario repository — a daemon without `--state-db` has no repository content,
and the persist behind a reload is a background write. The daemon also logs each
reload to stderr with a `[watch]` prefix. A rejected reload reports **which
file** failed and never what was in it — the runtime's own parser message
quotes the offending bytes, and the control plane is not a place to echo an
operator's file. See
[Access control → Event scopes are not an authorization boundary](../concepts/access-control.md#event-scopes-are-not-an-authorization-boundary).

Under `--state-db` the `idTagPool.file` path is persisted alongside the resolved
tags (`charge_points.id_tag_file`, schema v11), so a daemon restarted with
`--watch` watches the same files again instead of coming back holding a frozen
snapshot of a file it believes it is watching. The path is **resolved to an
absolute path when the charge point is created** and stored that way, so a
daemon restarted from a different working directory still watches the file the
operator meant. See [State persistence](../concepts/state-persistence.md).

A **scenario** loaded over the control plane persists its source path the same
way (`watched_scenario_files`, schema v12), so a restarted `--watch` daemon
re-establishes that watch and reconciles an edit made while it was down. The
startup flags are the deliberate exception: `--scenario` and
`--scenario-template-file` are **not** written down, because the per-connector
rewrite that a fan-out depends on lives in a callback no row can carry, and the
bootstrap that owns it runs again on every boot. Persisting them would restore a
second, rewrite-less watch per connector alongside the fresh instances, under
the previous run's scenario ids. A startup registration also **deletes** any row
already stored under the key it takes over: `--scenario` keeps the file's own id
when the file already targets its connector, so it can collide with an earlier
control-plane load of that id, and the abandoned row would otherwise be restored
at the next start and applied before the bootstrap registered the configured
scenario. The rows are simulator-owned state, so
`cp.delete` cascades to them and `state.reset` truncates them, with or without
`--watch`.

Both watched kinds establish the watch **before** reading the copy they compare
against, so an edit landing between a file being loaded and its watch starting
is still seen — otherwise the cached text would already be the pre-edit copy and
the reconciliation would compare the old file with the state it produced, find
them equal, and leave the charge point stale.

A file edited **while the daemon was stopped** is reconciled at startup rather
than merely watched from then on: the restore brings back the tags as of the
last time the daemon saw the file, so the daemon compares the file against what
each restored charge point actually holds and applies it if they differ. The
comparison is made **once per charge point**, not once per file — several charge
points can share one pool, and the restore re-creates them one at a time. Without
that step the current bytes would be recorded as already-seen, and the
operator's next save of that same content would be dismissed as a duplicate —
the pool would stay stale until the file happened to change again.

## Limits & Roadmap

- Current: one Socket.IO connection per client, `rpc` ack for commands, `event`
  push for CP and registry updates, and TCP-only daemon control.
- Removed: REST control endpoints, native WebSocket event streams, and the
  Unix-domain socket control listener.
- Future: bearer token auth or mTLS can be added at the HTTP/socket boundary
  without changing CP command method names.
- Shipped: bulk CP creation, multiple supervision URLs, CP blueprints, the
  metrics endpoint, an idTag pool, seeded background traffic and `--watch` file
  hot-reload (#295–#300, #314).
  Planned: a charging-curve EV model and a measured per-process ceiling. See
  [Fleet, load and observability roadmap](../analyses/fleet-load-and-observability-roadmap.md)
  for the full sequencing.
