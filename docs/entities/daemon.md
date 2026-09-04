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
updated: 2026-09-04
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

| Flag                                | Default                      | Description                                                                                                                                                                                                                       |
| ----------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--daemon`                          | -                            | Background server. When no `--http-port` is supplied, listens on `127.0.0.1:9700`.                                                                                                                                                |
| `--http-port <port>`                | `9700` with bare `--daemon`  | TCP port for health, Socket.IO, and optional web console assets.                                                                                                                                                                  |
| `--http-host <addr>`                | `127.0.0.1`                  | TCP bind address. Non-loopback binds require either `--web-console-basic-auth-user/pass` or `--unsafe-remote`.                                                                                                                    |
| `--cp-count <n>`                    | `1`                          | Bootstrap N charge points instead of one, sharing every option but the id. Requires `--cp-id` as the id stem, and a server mode (#295).                                                                                           |
| `--cp-id-pattern <tpl>`             | `<cp-id>{n:03}`              | Id template used with `--cp-count`. `{n}` is the index, `{n:03}` zero-pads it. The fleet registers before it dials, then connects 8 at a time.                                                                                    |
| `--metrics`                         | off                          | Serve `GET /metrics` (Prometheus text exposition). Off by default; the path 404s without it. See [Metrics](#metrics).                                                                                                             |
| `--metrics-no-auth`                 | off                          | Implies `--metrics` and serves it outside the Basic Auth gate. Trusted networks only; exempts nothing else.                                                                                                                       |
| `--unsafe-remote`                   | -                            | Allows a non-loopback daemon bind without web-console Basic Auth. Use only on trusted networks or when another boundary handles access.                                                                                           |
| `--web-console [<port>]`            | -                            | Serve the bundled browser UI alongside health and Socket.IO. Without a port, shares `--http-port`; with a port, serves the UI on that listener.                                                                                   |
| `--web-console-basic-auth-user <u>` | -                            | Enables inbound Basic Auth for static assets and the Socket.IO handshake. Must be paired with `--web-console-basic-auth-pass`. The configured health path is exempt.                                                              |
| `--web-console-basic-auth-pass <p>` | -                            | Password for the inbound web-console / Socket.IO auth gate.                                                                                                                                                                       |
| `--cors-origin <origin>`            | loopback: open; remote: same | Restrict browser Origins. Repeat for an allowlist, or pass literal `"*"` to opt into open CORS. See [Access control → CORS](../concepts/access-control.md#cors).                                                                  |
| `--trust-forwarded-headers`         | -                            | With same-origin CORS, also accept the public origin reported by `X-Forwarded-Proto` and `X-Forwarded-Host`. Use only behind a trusted reverse proxy.                                                                             |
| `--unix-socket <path\|none>`        | deprecated accepted no-op    | Accepted for launcher compatibility, prints a warning, and is ignored. The control plane is TCP Socket.IO only.                                                                                                                   |
| `--state-db <path>`                 | _(in-memory)_                | Persist scenarios, ChangeConfiguration overrides, charging profile state, availability flags, pending transaction messages, registered CPs and logs to a SQLite file (see [State persistence](../concepts/state-persistence.md)). |
| `--log-format <fmt>`                | `plain`                      | `plain` writes the legacy `[ts] [LEVEL] [TYPE] message` lines; `json` writes one JSON Lines object per line for structured-log collectors (see [Log format](../concepts/log-format.md)).                                          |
| `--health-path <path>`              | `/v1/healthz`                | Absolute path for the health-check JSON. The default is the only built-in health endpoint; set a custom path only when a proxy reserves the default.                                                                              |
| `--soap-path <path>`                | `/ocpp/soap`                 | Path prefix of the hosted OCPP-S `ChargePointService` callback endpoint (see [OCPP versions & transports](../concepts/ocpp-versions-and-transports.md)).                                                                          |

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

## Limits & Roadmap

- Current: one Socket.IO connection per client, `rpc` ack for commands, `event`
  push for CP and registry updates, and TCP-only daemon control.
- Removed: REST control endpoints, native WebSocket event streams, and the
  Unix-domain socket control listener.
- Future: bearer token auth or mTLS can be added at the HTTP/socket boundary
  without changing CP command method names.
- Planned: fleet-scale creation, a metrics endpoint, seeded background traffic
  and a measured per-process ceiling are sequenced in
  [Fleet, load and observability roadmap](../analyses/fleet-load-and-observability-roadmap.md).
