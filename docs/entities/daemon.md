---
title: Daemon (server mode)
type: entity
summary: The long-lived Bun process that hosts many charge points and exposes one Socket.IO control plane, health, optional web-console assets, SOAP callbacks, and the MCP endpoint over a single HTTP port.
sources:
  - src/cli/server/
  - src/cli/main.ts
  - scripts/bench/README.md
related:
  - cli.md
  - web-console.md
  - docker-image.md
  - mcp-endpoint.md
  - ../concepts/control-plane.md
  - ../concepts/access-control.md
  - ../concepts/state-persistence.md
  - ../concepts/log-format.md
  - ../concepts/file-hot-reload.md
  - ../analyses/fleet-load-and-observability-roadmap.md
  - ../sources/bench-readme.md
updated: 2026-09-12
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

| Flag                                | Default                      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--daemon`                          | -                            | Background server. When no `--http-port` is supplied, listens on `127.0.0.1:9700`.                                                                                                                                                                                                                                                                                                                                                                                       |
| `--http-port <port>`                | `9700` with bare `--daemon`  | TCP port for health, Socket.IO, and optional web console assets.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--http-host <addr>`                | `127.0.0.1`                  | TCP bind address. Non-loopback binds require either `--web-console-basic-auth-user/pass` or `--unsafe-remote`.                                                                                                                                                                                                                                                                                                                                                           |
| `--cp-count <n>`                    | `1`                          | Bootstrap N charge points instead of one, sharing every option but the id. Requires `--cp-id` as the id stem, and a server mode (#295).                                                                                                                                                                                                                                                                                                                                  |
| `--cp-id-pattern <tpl>`             | `<cp-id>{n:03}`              | Id template used with `--cp-count`. `{n}` is the index, `{n:03}` zero-pads it. The fleet registers before it dials, then connects 8 at a time.                                                                                                                                                                                                                                                                                                                           |
| `--metrics`                         | off                          | Serve `GET /metrics` (Prometheus text exposition). Off by default; the path 404s without it. See [Metrics](#metrics).                                                                                                                                                                                                                                                                                                                                                    |
| `--metrics-no-auth`                 | off                          | Implies `--metrics` and serves it outside the Basic Auth gate. Trusted networks only; exempts nothing else.                                                                                                                                                                                                                                                                                                                                                              |
| `--watch`                           | off                          | Re-read the idTag and scenario files this daemon loaded when they change on disk, debounced. Off by default; **refused outside a server mode** (`--daemon`, `--http-port`, `--web-console`) rather than accepted and ignored. See [File hot-reload](#file-hot-reload) (#314).                                                                                                                                                                                            |
| `--unsafe-remote`                   | -                            | Allows a non-loopback daemon bind without web-console Basic Auth. Use only on trusted networks or when another boundary handles access.                                                                                                                                                                                                                                                                                                                                  |
| `--web-console [<port>]`            | -                            | Serve the bundled browser UI alongside health and Socket.IO. Without a port, shares `--http-port`; with a port, serves the UI on that listener.                                                                                                                                                                                                                                                                                                                          |
| `--web-console-dist <dir>`          | -                            | Serve the console from this directory instead of searching for a bundled `dist/`. Must contain `index.html`; a path that does not is a startup error, not a fallback. The [desktop app](desktop-app.md#how-the-sidecar-finds-the-web-console) passes its Tauri resource dir here (#319).                                                                                                                                                                                 |
| `--web-console-basic-auth-user <u>` | -                            | Enables inbound Basic Auth for static assets and the Socket.IO handshake. Must be paired with `--web-console-basic-auth-pass`. The configured health path is exempt.                                                                                                                                                                                                                                                                                                     |
| `--web-console-basic-auth-pass <p>` | -                            | Password for the inbound web-console / Socket.IO auth gate.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--cors-origin <origin>`            | loopback: open; remote: same | Restrict browser Origins. Repeat for an allowlist, or pass literal `"*"` to opt into open CORS. See [Access control → CORS](../concepts/access-control.md#cors).                                                                                                                                                                                                                                                                                                         |
| `--trust-forwarded-headers`         | -                            | With same-origin CORS, also accept the public origin reported by `X-Forwarded-Proto` and `X-Forwarded-Host`. Use only behind a trusted reverse proxy.                                                                                                                                                                                                                                                                                                                    |
| `--unix-socket <path\|none>`        | deprecated accepted no-op    | Accepted for launcher compatibility, prints a warning, and is ignored. The control plane is TCP Socket.IO only.                                                                                                                                                                                                                                                                                                                                                          |
| `--state-db <path>`                 | _(in-memory)_                | Persist scenarios, ChangeConfiguration overrides, charging profile state, availability flags, pending transaction messages, registered CPs and logs to a SQLite file (see [State persistence](../concepts/state-persistence.md)).                                                                                                                                                                                                                                        |
| `--log-format <fmt>`                | `plain`                      | `plain` writes the legacy `[ts] [LEVEL] [TYPE] message` lines; `json` writes one JSON Lines object per line for structured-log collectors (see [Log format](../concepts/log-format.md)).                                                                                                                                                                                                                                                                                 |
| `--health-path <path>`              | `/v1/healthz`                | Absolute path for the health-check JSON. The default is the only built-in health endpoint; set a custom path only when a proxy reserves the default.                                                                                                                                                                                                                                                                                                                     |
| `--soap-path <path>`                | `/ocpp/soap`                 | Path prefix of the hosted OCPP-S `ChargePointService` callback endpoint (see [OCPP versions & transports](../concepts/ocpp-versions-and-transports.md)).                                                                                                                                                                                                                                                                                                                 |
| `--soap-tunnel <none\|ngrok>`       | `none`                       | Expose the OCPP-S callback endpoint through an ngrok tunnel and derive the callback URL from its public origin; the tunnel forwards to the API listener (else the console's). The public URL and an exposure warning are logged at startup; a spawned agent is killed on shutdown and its unexpected exit stops the daemon with code 1 (see [OCPP versions & transports → Tunnels](../concepts/ocpp-versions-and-transports.md#exposing-the-callback-through-a-tunnel)). |
| `--ngrok-auth-token <token>`        | -                            | ngrok authtoken for the spawned agent, passed through its environment and never logged.                                                                                                                                                                                                                                                                                                                                                                                  |
| `--ngrok-domain <domain>`           | -                            | Reserved ngrok domain for the spawned agent.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `--ngrok-api-url <url>`             | -                            | Attach to a running agent's local API (Docker sidecar) instead of spawning one.                                                                                                                                                                                                                                                                                                                                                                                          |

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

| Metric                                    | Type      | Labels                | Meaning                                     |
| ----------------------------------------- | --------- | --------------------- | ------------------------------------------- |
| `ocppcp_charge_points`                    | gauge     | `state`               | Registered charge points by current status. |
| `ocppcp_connectors`                       | gauge     | `status`              | Connectors across all charge points.        |
| `ocppcp_transactions_active`              | gauge     | —                     | Connectors currently in a transaction.      |
| `ocppcp_ocpp_messages_total`              | counter   | `action`, `direction` | OCPP messages observed.                     |
| `ocppcp_ocpp_call_errors_total`           | counter   | `action`              | CALLERROR frames.                           |
| `ocppcp_ocpp_call_duration_seconds`       | histogram | `action`              | CALL to CALLRESULT/CALLERROR round trip.    |
| `ocppcp_ocpp_call_timeouts_total`         | counter   | `action`              | CALLs the transport gave up on.             |
| `ocppcp_ocpp_pending_calls_evicted_total` | counter   | —                     | Latency-correlation cache overflows.        |
| `ocppcp_rpc_requests_total`               | counter   | `method`, `outcome`   | Control-plane rpc calls.                    |
| `ocppcp_ws_reconnects_total`              | counter   | —                     | WebSocket reconnect attempts.               |

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

`ocppcp_ocpp_call_timeouts_total` exists because the duration histogram cannot
see an unanswered CALL: a duration is only observed when the CALLRESULT or
CALLERROR arrives, so a CSMS that never answers contributes **no observation at
all** — a saturated CSMS would otherwise report zero slow calls and zero
errors, the opposite of the truth. Exactly one thing increments it: the
**OCPP-1.6J per-CALL watchdog** (`SERIAL_CALL_TIMEOUT_MS`, 30s, in
`src/cp/infrastructure/transport/OCPPMessageHandler.ts`) firing, matched off
the log line it writes. It is therefore a protocol fact — the transport
abandoned this CALL — and **never** a fact about the daemon's own bookkeeping.

Coverage is not symmetric: `OCPPMessageHandlerV201` has no such watchdog, so an
abandoned OCPP 2.x CALL is never counted here at all. "Zero" on 2.x means "not
measured", not "none"; use `ocppcp_ocpp_call_errors_total`, the histogram's
`+Inf` bucket and `ocppcp_ws_reconnects_total` there instead. A CALL the CSMS
answers _after_ the watchdog fired is counted here **and** lands in the
histogram's `+Inf` bucket — those are different facts (given up on / answered
late), and neither is double-counted as the other.

`ocppcp_ocpp_pending_calls_evicted_total` is the separate, unlabelled counter
for the other thing that can happen to an in-flight CALL: the recorder
remembers at most `MAX_PENDING_CALLS` (4096) of them for latency correlation
and drops the oldest past that. That is a **capacity event in the recorder, not
a timeout** — the transport still holds the CALL and the CSMS may answer it a
millisecond later. Until #302 it incremented the timeout counter, which made
that counter report load rather than failure, and did so worst at exactly the
fleet sizes a scale run is trying to characterise, since 4096 concurrent
pending CALLs is a big-fleet condition; it also double-counted any CALL whose
watchdog fired after its eviction. What an eviction actually costs is one
duration sample, so a non-zero value here means the histogram beside it is
incomplete by that many observations — which is the reason to expose it rather
than drop it silently.

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

| File                               | Reached by                                                                                            | What a reload does                                                                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idTagPool.file` on a charge point | `cp.create` / `cp.update` / `cp.create_many`, and a `--state-db` restore of any of them               | Replaces the pool **live** on every charge point that was created from that path. The next session draws the new tags.                                                                    |
| A scenario file                    | `--scenario`, `--scenario-template-file`, and the `load_scenario { file }` / `run_scenario_file` RPCs | Replaces the definition **under the same scenario id**, unless the connector is mid-session _or_ that scenario's own run is in flight — either one holds the reload; see the rules below. |

The rules, in the order they bite:

- **`applied` is a claim about durable state.** With `--state-db` a scenario
  reload is announced only once its write to the `scenarios` table has settled;
  a reload whose write fails is reported **`rejected`**, and the definition
  stays live until the daemon restarts. An idTag pool is persisted **before**
  the live pool is touched, so a charge point whose write fails is left
  untouched, live and stored alike.
- **The duplicate-bytes baseline means "everyone has these".** A watched idTag
  file's cached copy records the bytes every charge point drawing from that path
  currently holds — not the bytes of the last reload that landed somewhere. It
  advances only when they all agree, and is dropped outright when a parse or an
  apply fails.
- **A partly-applied idTag reload drops the baseline and repairs on the next
  event, not by itself.** The apply loop keeps going after one charge point
  throws, so a failed reload means _somewhere between none and all_ of them
  changed. With no baseline the operator's next save — **including a revert to
  the previous bytes** — is judged afresh. Until that save, or a restart, the
  fleet can hold two different pools from one path.
- **Debounced.** The watch waits 200 ms after the last event, then reads once.
  Identical bytes are not a reload and produce no event.
- **A malformed or unloadable file never lands.** The reload path runs the load
  path's own checks — including the hard gate `loadScenario` applies to every
  definition it accepts — **before** a reload is accepted for deferral, so a
  file that lost a required field is `rejected` outright rather than held with
  its bytes recorded as the baseline. The previous good copy stays in place. A
  reload the control plane could not announce is refused the same way: what is
  checked is the resulting `scenario-definitions-changed` snapshot (1 000
  definitions of at most 256 KiB each), so an oversized _sibling_ can refuse a
  small edit, and the rejection names the scenario id at fault.
- **An accepted reload always ends in `applied` or `rejected` — never neither.**
  A hold is released when the session ends, when the scenario's run settles,
  when a `cp.update` rebuild completes — and, as a backstop that depends on none
  of those, on **any connector status transition**.
- **A replaced run still settles its own connector.** The incoming run owns the
  executor slot, the run id and the transcript; the connector-scoped artifacts
  are owed by the run that is **ending**, because nothing else will clear them.
  The scenario position is claimed by acquisition — except where it belongs to a
  run that is still going, which the acquiring run leaves alone. The EV settings
  override is released by the run that **actually applied** it and by no one
  else, so a definition that is installed but has not run releases nothing.
  _Limitation:_ there is one scenario position per connector in memory and one
  `connector_runtime` row on disk, so two concurrent runs on a connector share
  one checkpoint and the last writer wins.
- **A hold is never left waiting on something that is gone.** Removing the
  connector reports the hold **`rejected`**, naming it, and stops watching the
  file; removing the charge point drops the registration and its stored row. A
  session that never ran does not close the gate at all.
- **A reload never mutates a charge point mid-session.** A scenario reload for a
  connector with an open transaction, or for a scenario whose run is in flight,
  is _held_ — not dropped — and installed when that session ends or the run's
  cleanup completes, whether it finished, errored or was stopped by hand. It is
  never installed from inside the call that released it. An idTag pool is exempt
  by construction: it is drawn from once per session.
- **Removing or replacing a scenario drops its watch**, through every path that
  takes a definition away (`remove_scenario`, an inline `load_scenario` under
  the same id, `scenario.definitions.delete`, a `scenario.definitions.replace`
  upload). A scenario the charge point no longer holds is **never re-created**
  by an edit.
- **A scenario keeps the connector it was loaded onto, and the id it was loaded
  under.** An edited `id` in the file is ignored. The target is _re-derived_ on
  every reload behind a startup flag and _pinned_ to what the load installed
  behind `load_scenario { file }` / `run_scenario_file`: a reload replaces a
  definition, it never moves a scenario.
- **At most one startup scenario option.** `--scenario`, `--scenario-template`
  and `--scenario-template-file` each load a definition onto every selected
  connector, so passing two is refused — at parse time, with a message naming
  the flags it cannot reconcile — rather than silently ranked.
- **Blueprints are not watched; the file a blueprint names is.** A blueprint
  lives in the `blueprints` table (#297 declined a watched blueprint file
  deliberately), so a `blueprint.save` edit never reaches a charge point that
  already exists. Its `params.idTagPool.file` is a different matter:
  `cp.create_many { blueprintId }` spreads the blueprint's `params` into the
  same create body a plain `cp.create` uses, so a charge point instantiated
  from a blueprint records that path as its own `idTagFile` and is watched and
  reloaded **live**, exactly like one created by hand. Every path that sets a
  charge point's init block registers the file — `cp.create`, `cp.create_many`
  (with or without a blueprint), `cp.update` and a `--state-db` restore; a pool
  given inline as `idTagPool.tags` has no file and is never reloaded.
- **Watching degrades, it never fails to start.** Where `fs.watch` cannot be
  established the daemon logs one line and carries on unwatched. Degraded is
  never _worse_ than unwatched: a charge point being reconciled is measured
  against the **file on disk**, never against the bytes of the last reload.
- **ConfigMap mounts and symlinks are covered at every hop.** A projected
  volume's `..data` rotation is a rename that re-checks every tracked file in
  that directory, and a symlink is watched at the directory of every hop of its
  chain (capped at 8), not only at its ends — see the table below.

Why each of those is shaped the way it is, what the simpler version of it got
wrong, and what is deliberately still not covered:
[File hot-reload](../concepts/file-hot-reload.md).

### Which layouts `--watch` supports

Assembled here because it was previously spread across the rules above and a
reader deciding whether `--watch` works for their deployment should not have to
reconstruct it.

**Every `Yes` row is pinned by a test that fails if that row's mechanism is
removed** — the rule this table earned the hard way, twice: a row claiming a
layout works is a contract, and one written ahead of its test was found false
within two rounds. Where a row is `No`, the last column says what to do instead.

| Layout                                                                           | Supported | How, or why not                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A plain file, edited in place                                                    | Yes       | Directory watch, filtered by basename.                                                                                                                                                                                                                                  |
| A plain file, saved by write-then-rename (most editors)                          | Yes       | The directory watch survives the rename; a rename naming the temp file re-checks every tracked file in that directory.                                                                                                                                                  |
| A symlink whose **target is edited in place**                                    | Yes       | The target's directory is watched as well.                                                                                                                                                                                                                              |
| A symlink that is **repointed** (Kubernetes projected volume)                    | Yes       | The `..data` rename re-checks every tracked file, and the target is re-resolved on that event.                                                                                                                                                                          |
| A symlink **chain**                                                              | Yes       | Every hop's directory is watched, not just the far end — so a link in the middle being repointed is seen, and so is a target created past the first missing hop. Capped at 8 hops.                                                                                      |
| A symlink whose **target is deleted and recreated**                              | Yes       | The target's directory watch is **kept** while the link is broken — `readlink` still answers when `realpath` does not — so the recreation, which fires only there, is seen.                                                                                             |
| A **broken** symlink whose target's **directory exists**, or a symlink **cycle** | Yes       | Same mechanism, and through the whole chain: every hop up to and including the first one that does not exist has its directory watched, so the file appearing there is seen. Not treated as a degraded filesystem, so it does not consume the one-off degradation line. |
| A broken symlink whose target's **directory does not exist yet**                 | **No**    | There is nothing to open a watch on, so the entry stays unwatched and the directory appearing later fires only in an ancestor nothing is watching. **Instead:** create the directory before starting the daemon — it may stay empty — or restart once it exists.        |
| An **intermediate** link of a chain repointed                                    | Yes       | That is a rename in the directory holding that link, which is watched like every other hop. Unlike an _ancestor_ repoint, no directory is replaced, so no watch has to be reopened.                                                                                     |
| A file under a symlinked ancestor that **stays put**                             | Yes       | Nothing extra needed — `fs.watch` resolves the directory it is given.                                                                                                                                                                                                   |
| A file under an ancestor symlink that is **repointed** (`current` → `v2`)        | **No**    | The event fires in the ancestor's _parent_, and the directory watch is bound to the old directory's inode — this is the replaced-directory limitation below. **Instead:** point the flag at the stable path inside the release directory, or restart after the swap.    |
| A file on a filesystem where `fs.watch` does not work                            | No        | One log line, then the daemon carries on unwatched. See the degradation rule above. **Instead:** reload through the control plane (`load_scenario`, `cp.update`).                                                                                                       |
| The **watched directory itself** replaced (deleted and recreated)                | No        | `fs.watch` binds to an inode; the watcher stays open and delivers nothing. Not distinguishable from a quiet file without polling. **Instead:** restart the daemon after replacing it.                                                                                   |
| A **`subPath`** ConfigMap mount                                                  | No        | Kubernetes does not propagate updates into a `subPath` at all — there is nothing to watch. **Instead:** mount the whole volume, where the projected-volume rotation above works.                                                                                        |

- **Known limitation: a watch lives as long as the directory it was opened on.**
  `fs.watch` binds to an inode. If the _directory_ holding a watched file is
  itself replaced — deleted and recreated, or a bind-mount swapped underneath —
  the watcher stays open, reports no error, and delivers nothing. It is the one
  remaining shape in which watching looks healthy and is not, and it cannot be
  distinguished from a quiet file without polling. Two deployments meet it: a
  `subPath` ConfigMap mount, where Kubernetes does not propagate updates at all
  and there is nothing to watch in the first place, and a re-created mount. Mount
  the whole volume rather than a `subPath` and the projected-volume rotation
  above works.

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
reload to stderr with a `[watch]` prefix. Every string in that event is clamped to the
envelope's own bound as the event is built, not only checked by the schema: a
field that fails validation takes the whole push with it and the failure is
merely logged, so an unbounded value turns a correct rejection into silence. A
file-loaded definition's `id` is whatever the file says, and one over 64 KiB
quoted into a rejection message did exactly that. A scenario **id** is bounded at the point a
definition is loaded — by the same constant the event field uses — because a
definition read from a file passes through none of the object schemas that bound
an id arriving over RPC, and an id past that length loaded fine and then made
every event naming it unsendable. A rejected reload reports
**which file** failed and never what was in it — the runtime's own parser message
quotes the offending bytes, and the control plane is not a place to echo an
operator's file. See
[Access control → Event scopes are not an authorization boundary](../concepts/access-control.md#event-scopes-are-not-an-authorization-boundary).

How a watched file's origin survives a daemon restart — the persisted
`id_tag_file` / `watched_scenario_files` rows, the two-pass restore and the
startup-flag ordering — is on
[File hot-reload → What survives a restart](../concepts/file-hot-reload.md#what-survives-a-restart).

## Limits & Roadmap

- Current: one Socket.IO connection per client, `rpc` ack for commands, `event`
  push for CP and registry updates, and TCP-only daemon control.
- Removed: REST control endpoints, native WebSocket event streams, and the
  Unix-domain socket control listener.
- Future: bearer token auth or mTLS can be added at the HTTP/socket boundary
  without changing CP command method names.
- Shipped: bulk CP creation, multiple supervision URLs, CP blueprints, the
  metrics endpoint, an idTag pool, seeded background traffic, `--watch` file
  hot-reload (#295–#300, #314) and the scale benchmark below (#302) — the
  _tooling_ for a measured ceiling; no number has been produced yet. Planned:
  a charging-curve EV model. See
  [Fleet, load and observability roadmap](../analyses/fleet-load-and-observability-roadmap.md)
  for the full sequencing.

### Measured scale ceiling

There is **no hard cap on how many charge points one daemon can hold** — every
CP runs on the single Bun event loop, so the real limit is wherever per-CP
scheduling and OCPP call handling start visibly slowing every CP down, not a
number the code enforces (`cp.create_many`'s own `CP_CREATE_MANY_MAX` of 200
is a per-_call_ batch limit, not a fleet-size limit — see
[Control plane → `cp.create_many`](../concepts/control-plane.md#cpcreate_many--the-batch-fields)).

[`scripts/bench/fleet-bench.ts`](../../scripts/bench/README.md) measures where
that starts happening: it grows a fleet against a real CSMS via
`cp.create_many`, drives heartbeats (and, optionally, a start/stop transaction
cycle — the two axes the issue asked for) at a configurable rate, and reads
this page's [`/metrics`](#metrics) endpoint before and after each step to
report N vs. p50/p95 OCPP CALL round-trip latency, plus abandoned calls
(`ocppcp_ocpp_call_timeouts_total`), CALLERRORs and reconnects as sharper knee
signals than latency alone. See the script's README for the exact method
(settle, warm up for one CALL watchdog plus the stagger ramp, then delta
between two cumulative scrapes, with linear bucket interpolation for the
quantiles) and its limitations. `--ocpp-version` selects what the fleet
speaks (`OCPP-1.6J` by default, or `OCPP-2.0.1` / `OCPP-2.1`); on 2.x the
timeout column reads `n/a` rather than `0`, since only the 1.6J handler has the
per-CALL watchdog that feeds it (see [Metrics](#metrics)). It refuses to run against a daemon that
already holds charge points, because `/metrics` has no `cpId` label and their
traffic would land in the same histogram as the bench fleet's. `--allow-existing`
waives that refusal — but only up to 1000 pre-existing charge points, above
which the preflight refuses by name: the bench's `events.subscribe` ack carries
the daemon's whole registry through the control plane's `ARRAY_1000` cap
whatever scope it asks for, so the subscription the run depends on cannot be
established at all. Every row of an `--allow-existing` run is marked `est` in
its `conn.src` column: with no `cpId` label the connected count can only be a
daemon-wide gauge minus a preflight baseline, and a bystander's churn moves that
in either direction undetectably. The latency numbers are unaffected — what
cannot be attributed is the fleet size they are reported against. Its
`--heartbeat-interval` is a **contract**: the run drives heartbeats at that
cadence for its whole length, including across reconnects, by reapplying
`start_heartbeat` after every accepted boot — `onBootNotificationAccepted`
otherwise reinstalls the CSMS's `BootNotification.conf` interval, and reconnects
are exactly what start happening near the knee. See
[Source: bench README](../sources/bench-readme.md) for what that does and does
not cover, including what the reapplication itself costs the measurement (one
control-plane RPC per accepted boot, paced inside the socket pool's existing
ceiling). The contract is audited per row in the `hb.load` column, which reads
`set` only when all three of its preconditions hold — the initial arm
succeeded, every reapplication succeeded, and the event socket driving them is
still up — and `drift` for anything it cannot establish. **Whether that moves the knee is a stated limitation, not pending
work**: the collapse to one RPC per boot is measured, the residual's bound is
argued from the pool's 640 RPC/s ceiling, and settling it needs a sweep against
a real CSMS at fleet size run with and without the reapplication — the same
missing ingredient as the number this section is waiting on. Every result file
already carries the counters that would settle it. The
same README also states the teardown ceiling an operator meets on Ctrl-C:
about ten and a half minutes worst case on OCPP 1.6, and only against a daemon
that is answering but has not finished creating.

**No number is recorded here yet.** Producing one requires a real CSMS and a
stated machine, neither of which exists in this repository's CI or review
sandboxes — running the benchmark is a manual step. When it is run, record
here:

- the **machine** (CPU model/cores, RAM, `bun --version`, this daemon's own
  version — the script prints all four),
- the **CSMS** used and whether it ran locally or remotely (a remote CSMS's
  own latency dominates before the daemon's does — a different, also
  worth-recording, knee),
- the **N vs. p50/p95 table** for both the idle and active axes, and
- the **knee** — the N where latency visibly diverges from baseline, or where
  timeouts/errors/reconnects first go non-zero.

Once a number exists, it gates whether [5b, a worker
model](../analyses/fleet-load-and-observability-roadmap.md#5b-worker-model-conditional)
is worth building at all — building it before this number exists would be
speculative.
