# Server Mode (HTTP + WebSocket)

The simulator can run as a long-lived process exposing an HTTP/WebSocket API. A single process can host **many charge points** concurrently. Requires the [Bun](https://bun.sh/) runtime.

The same HTTP/WS handlers are exposed over both a TCP port and a Unix domain socket, so local tools can use the Unix socket for lower-overhead IPC while remote clients use TCP.

> All examples below show `bun src/cli/main.ts` for clarity when working from a checkout. If you've installed the package (`bun link` or `bun install -g`), `ocpp-cp-sim` is interchangeable everywhere.

## Starting the Server

```bash
# Background daemon, Unix socket only (default /tmp/ocpp-server.sock)
bun src/cli/main.ts --daemon &

# Background daemon, Unix + TCP
bun src/cli/main.ts --daemon --http-port 9700 &

# Foreground HTTP server (no Unix socket by default)
bun src/cli/main.ts --http-port 9700

# Foreground HTTP + custom Unix socket
bun src/cli/main.ts --http-port 9700 --unix-socket /var/run/ocpp.sock

# TCP-only daemon
bun src/cli/main.ts --daemon --unix-socket none --http-port 9700 &

# Bootstrap a CP at startup
bun src/cli/main.ts --daemon --http-port 9700 \
  --cp-id CP001 --ws-url ws://localhost:9000/ocpp &
```

| Flag                         | Default                   | Description                                                                                                                                                                                                         |
| ---------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--daemon`                   | -                         | Background server. Unix socket enabled by default.                                                                                                                                                                  |
| `--http-port <port>`         | -                         | TCP port for HTTP/WebSocket.                                                                                                                                                                                        |
| `--http-host <addr>`         | `127.0.0.1`               | TCP bind address. Use `0.0.0.0` to expose externally.                                                                                                                                                               |
| `--unix-socket <path\|none>` | `/tmp/ocpp-server.sock`\* | Unix socket path. `none` disables Unix socket.                                                                                                                                                                      |
| `--state-db <path>`          | _(in-memory)_             | Persist scenarios, ChangeConfiguration overrides, charging profile state, availability flags, pending transaction messages, registered CPs and logs to a SQLite file (see [State persistence](#state-persistence)). |
| `--log-format <fmt>`         | `plain`                   | `plain` writes the legacy `[ts] [LEVEL] [TYPE] message` lines; `json` writes one JSON Lines object per line for structured-log collectors (see [Log format](#log-format)).                                          |

\* Default applies only with `--daemon`. Without `--daemon`, the Unix socket is **off** unless `--unix-socket <path>` is given explicitly.

## State persistence

The daemon keeps everything in memory by default. Pass `--state-db <path>` to write to a SQLite file instead — useful for survive-restart use cases (long-running CSMS integration tests, simulated EVs that should keep their `MeterValueSampleInterval` override or their `Inoperative` flag across reboots).

```bash
# Persist to a file in the current directory
ocpp-cp-sim --daemon --http-port 9700 \
            --cp-id CP001 --ws-url ws://localhost:9000/ocpp \
            --state-db ./state.db

# Inspect the DB
sqlite3 ./state.db ".tables"
# charge_point_state  charging_profiles   connector_settings  kv
# charge_points       configuration       logs                pending_messages
# scenarios           schema_meta

# In-memory (default)
ocpp-cp-sim --daemon ...
```

### Tables

| Table                | Holds                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_meta`        | Single row stamping the schema version. Used by future migrations.                                                                                      |
| `scenarios`          | Scenario definitions (per CP/connector). Browser saves go through here.                                                                                 |
| `connector_settings` | `auto_meter`, `availability` and `soc_meter_sync` per `(cp_id, connector_id)`. `connector_id=0` represents the CP main controller.                      |
| `charging_profiles`  | One row per active `SetChargingProfile.req`, keyed by `(cp_id, connector_id, charging_profile_id)`.                                                     |
| `configuration`      | Per-CP overrides written by `ChangeConfiguration.req` (§5.3). The OCPP defaults are computed at boot; only operator/CSMS-set values land here.          |
| `pending_messages`   | Transaction-related CALLs queued while offline (§4.7 / §4.8 errata 3.18). Retried with backoff on reconnect.                                            |
| `logs`               | Persisted log entries — every OCPP message, scenario step, state transition. Batched writes (50 entries / 500 ms) and trimmed to 10 k rows per CP.      |
| `charge_points`      | Daemon-side CP registry. Re-created on restart by `CPRegistry.restoreFromDatabase` and **auto-connected**, so the CSMS sees BootNotification fly again. |
| `charge_point_state` | Per-CP runtime flags (currently `desired_connected`). Browser local mode writes this on Connect/Disconnect so a reload restores the WebSocket.          |
| `kv`                 | App-level prefs (global config, SoC↔Meter sync, etc.).                                                                                                 |

### Reset

The browser ships a **Reset all simulator data** button (Settings page) that wipes every table while leaving the schema intact. The daemon endpoint is:

```bash
curl -X POST http://127.0.0.1:9700/v1/state/reset
```

Both paths also drop every in-memory CP first so live WebSockets don't keep writing to the (about-to-be-empty) DB.

### Browser

Browser mode uses the same schema, backed by sql.js + IndexedDB. Each browser profile keeps one DB blob under the `ocpp-cp-simulator` IndexedDB database; clearing site data wipes simulator state. sql.js is only loaded when the page determines it's in Local mode (via a `/v1/healthz` probe at the page origin — path configurable, see [Health endpoint](#health)) — Remote mode skips the WASM download entirely.

## Log format

By default the daemon writes human-readable log lines:

```
[2026-06-01T11:18:38.409Z] [INFO] [OCPP] Boot notification accepted
[2026-06-01T11:18:38.409Z] [INFO] [WebSocket] Sent: [2,"…","StatusNotification",{"connectorId":0,"errorCode":"NoError","status":"Available"}]
```

Pass `--log-format json` to switch to JSON Lines — one object per line, including the `[server] xxx` setup chatter:

```json
{"timestamp":"2026-06-01T11:18:38.373Z","level":"INFO","type":"Server","message":"Listening on http://127.0.0.1:9700 (API)"}
{"timestamp":"2026-06-01T11:18:38.409Z","level":"INFO","type":"OCPP","message":"Boot notification accepted","cpId":"CP001"}
{"timestamp":"2026-06-01T11:18:38.409Z","level":"INFO","type":"WebSocket","message":"Sent: [2,…]","cpId":"CP001"}
```

The shape (`timestamp` / `level` / `type` / `message` / optional `cpId`) is identical to:

- the rows persisted in the `logs` table,
- the JSON Lines file produced by the browser's "Download" button in the log viewer,
- the response of `GET /v1/cp/:cpId/logs` (see below).

So you can pipe daemon stdout into the same `jq` pipeline that consumes a downloaded log file.

### Endpoints

| Method | Path                      | Returns                                                                                                                 |
| ------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/cp/:cpId/logs`       | All persisted log rows for the CP, oldest-first. Falls back to the in-memory Logger buffer when `--state-db` isn't set. |
| POST   | `/v1/cp/:cpId/logs/clear` | Delete the persisted log rows for the CP.                                                                               |
| POST   | `/v1/state/reset`         | Truncate every simulator-owned table, then disconnect/forget every in-memory CP. Schema is preserved.                   |

## Docker

A `Dockerfile` and `docker-compose.yml` ship at the repo root, and a multi-arch image is published on every push to `main` / version tag at `ghcr.io/shiv3/ocpp-cp-simulator`. See [docs/docker.md](./docker.md) for the full reference (volumes, environment variables, compose recipes, structured-log piping). Quick path:

```sh
docker run --rm -p 9700:9700 -v "$PWD/.state:/data" \
  ghcr.io/shiv3/ocpp-cp-simulator:latest \
  --cp-id CP001 --ws-url wss://example.invalid/chargepoint/
```

The image is Bun-based and ships **both** the daemon and the React browser UI — Vite builds `dist/` in a build stage and the daemon serves it from the same HTTP port as the API (SPA-aware: unknown paths fall back to `index.html`).

```bash
# Build
docker build -t ocpp-cp-sim .

# Run, exposing HTTP on host port 9700, talking to a CSMS at wss://example/chargepoint/
docker run --rm -p 9700:9700 ocpp-cp-sim \
  --cp-id cp1 --connectors 2 \
  --ws-url wss://example/chargepoint/

# Run with a scenario template mounted in read-only
docker run --rm -p 9700:9700 \
  -v "$PWD/docs/examples/scenarios:/scenarios:ro" \
  ocpp-cp-sim --cp-id cp1 --ws-url wss://example/chargepoint/ \
    --scenario-template-file /scenarios/demo-charging.json \
    --scenario-connector all
```

Or via Docker Compose — edit `command:` in `docker-compose.yml` for your CSMS / cpId, then:

```bash
docker compose up --build
```

Notes:

- The ENTRYPOINT pins `--http-host 0.0.0.0 --unix-socket none --web-console $HTTP_PORT`. `--web-console` starts the HTTP server on the given port and serves the bundled UI from the same origin (resolved from the `dist/` shipped next to the CLI).
- After `docker run …` open `http://localhost:9700/` to use the browser UI. It talks to the daemon on the same origin, so CORS / dev-server routing is a non-issue.
- The image's `HEALTHCHECK` hits `$HEALTH_PATH` (default `/v1/healthz`), so `docker ps` shows `healthy` / `unhealthy` once the daemon is up.
- Override the bound port by setting the `HTTP_PORT` env var (e.g. `-e HTTP_PORT=8080`). The published host port via `-p` is independent.

## HTTP API

All responses are JSON. Command responses follow the same `{ ok, data?, error? }` shape used by the JSON Lines mode.

### Health

```
GET /v1/healthz
→ { "ok": true, "cps": 2 }
```

The path is configurable via `--health-path <path>` (default `/v1/healthz`). Change it when a reverse proxy in front of the daemon reserves the default path — e.g. Google Front End in front of Cloud Run will return 404 directly on certain reserved paths before the request hits the container. The browser UI's Remote-mode auto-detect and the `RemoteChargePointService.ping` poll both target the path that was inlined at UI build time via the `VITE_HEALTH_PATH` env var (same default); the two values must match for the UI's "Remote" green-dot status to light up.

### Charge Point Registry

```
GET /v1/cp
→ [ { "cpId": "CP001", "status": "Available", "connectors": 1 }, ... ]

POST /v1/cp
   { "cpId": "CP001",
     "wsUrl": "ws://localhost:9000/ocpp",
     "connectors": 1,            // optional, default 1
     "vendor": "Acme",           // optional
     "model": "X1",              // optional
     "basicAuth": {              // optional
       "username": "user",
       "password": "pass"
     },
     "autoConnect": true         // optional, default false
   }
→ { "ok": true, "data": { "cpId": "CP001" } }

GET /v1/cp/:cpId
→ { "id": "CP001", "status": "Available", "error": "", "connectors": [...] }

DELETE /v1/cp/:cpId
→ { "ok": true }
```

### Commands

```
POST /v1/cp/:cpId/command
   { "id": "req-1",
     "command": "start_transaction",
     "params": { "connector": 1, "tagId": "TAG001" } }
→ { "id": "req-1", "ok": true }
```

The body is the same `JsonCommand` accepted by JSON Lines mode. See [docs/cli.md](cli.md) for the full command list (`status`, `connect`, `start_transaction`, `stop_transaction`, `set_meter_value`, `send_meter_value`, `heartbeat`, `start_heartbeat`, `stop_heartbeat`, `authorize`, `update_connector_status`, scenario commands, ...).

### Shutdown

```
POST /v1/shutdown
→ { "ok": true }
```

Cleans up all CPs, closes WebSocket subscribers, stops listeners, and exits the process.

## WebSocket Events

```
WS /v1/cp/:cpId/events    – events from a specific CP
WS /v1/events             – events from all CPs
```

Per-CP payload (same shape as the legacy line-delimited stream):

```json
{
  "event": "transaction_started",
  "data": { "connectorId": 1, "transactionId": 1234, "tagId": "TAG001" },
  "timestamp": "2026-05-25T10:00:00.000Z"
}
```

Global stream payload (adds `cpId`):

```json
{
  "cpId": "CP001",
  "event": "transaction_started",
  "data": { "connectorId": 1, "transactionId": 1234, "tagId": "TAG001" },
  "timestamp": "2026-05-25T10:00:00.000Z"
}
```

Inbound messages are ignored in this version (push-only). For events, only TCP is supported — there is no WebSocket-over-Unix-socket client today.

## End-to-End Example (curl + wscat)

```bash
# Start the server (foreground)
bun src/cli/main.ts --http-port 9700

# In another shell, register a CP and connect it
curl -X POST http://127.0.0.1:9700/v1/cp \
  -H 'content-type: application/json' \
  -d '{"cpId":"CP001","wsUrl":"ws://localhost:9000/ocpp","autoConnect":true}'

# Watch events
wscat -c ws://127.0.0.1:9700/v1/cp/CP001/events

# Drive a transaction
curl -X POST http://127.0.0.1:9700/v1/cp/CP001/command \
  -H 'content-type: application/json' \
  -d '{"command":"start_transaction","params":{"connector":1,"tagId":"TAG001"}}'

curl -X POST http://127.0.0.1:9700/v1/cp/CP001/command \
  -H 'content-type: application/json' \
  -d '{"command":"set_meter_value","params":{"connector":1,"value":1000}}'

curl -X POST http://127.0.0.1:9700/v1/cp/CP001/command \
  -H 'content-type: application/json' \
  -d '{"command":"stop_transaction","params":{"connector":1}}'

# Shut down
curl -X POST http://127.0.0.1:9700/v1/shutdown
```

## HTTP over Unix Socket

When `--daemon` is used (or `--unix-socket /path` explicitly), the same HTTP API is served over an `AF_UNIX` listener. Anything that can speak HTTP over a Unix socket works:

```bash
curl --unix-socket /tmp/ocpp-server.sock http://localhost/v1/cp
```

The bundled CLI client uses Node's `http.request({ socketPath, ... })` under the hood. `--send` and `--stop` prefer the Unix socket; `--events` always uses TCP.

## CORS

The CORS policy depends on the bind address and any `--cors-origin` flags:

| Bind                          | `--cors-origin` flag       | Effective policy                                                                                                                                                         |
| ----------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Loopback (`127.0.0.1`, etc.)  | _(none)_                   | **`any`** — `*` echoed back. Safe because nothing off-host can reach loopback anyway.                                                                                    |
| Non-loopback (`0.0.0.0`, LAN) | _(none)_                   | **`same-origin`** — only requests whose `Origin` matches the request `Host` are allowed (plus non-browser callers with no `Origin` header). A warning is logged at boot. |
| Any                           | `--cors-origin <url>` (×N) | **`allowlist`** — only the listed origins are echoed back.                                                                                                               |
| Any                           | `--cors-origin "*"`        | **`any`** — explicit opt-in to open CORS.                                                                                                                                |

Same-origin is the safe default when binding to `0.0.0.0` because **the control API is unauthenticated** — combined with `*` any web page in the operator's browser could call `/v1/cp/:cpId/command` or even `/v1/shutdown`. For browser UIs hosted on a different origin, allowlist them:

```sh
ocpp-cp-sim --daemon --http-port 9700 \
  --cors-origin http://localhost:5173 \
  --cors-origin https://ocpp-ui.example.com
```

Or opt back into open CORS deliberately (LAN test rigs, scripted integration tests):

```sh
ocpp-cp-sim --daemon --http-port 9700 --http-host 0.0.0.0 --cors-origin "*"
```

Non-browser callers (curl, the bundled CLI, server-to-server) don't send an `Origin` header and are always allowed regardless of policy — the policy only restricts cross-site browser access.

### Behind a reverse proxy (Traefik, nginx, Caddy, …)

This is the **#1 gotcha** when serving the web console (`--web-console`) behind a proxy at a public HTTPS URL. The Vite `index.html` references its bundle with `crossorigin`, so the browser sends an `Origin` header even for the page's own assets:

```
GET https://app.example.com/assets/index-*.js   403 (Forbidden)
GET https://app.example.com/assets/index-*.css  403 (Forbidden)
```

The daemon serves those assets fine internally (`200`), but with the `same-origin` default it only knows its **internal** bind address (`0.0.0.0:9700`), not the public URL the proxy exposes — so the browser's `Origin: https://app.example.com` doesn't match and it returns `403`. The symptom (blank page, `403` only on `/assets/*`, behind an auth proxy) is easy to misattribute to the proxy or SSO.

Two ways to fix it:

```sh
# 1. Name the public origin explicitly (works with any proxy):
ocpp-cp-sim --daemon --http-port 9700 --web-console \
  --cors-origin https://app.example.com

# 2. Let the daemon derive the public origin from the proxy's
#    X-Forwarded-Proto / X-Forwarded-Host headers:
ocpp-cp-sim --daemon --http-port 9700 --web-console \
  --trust-forwarded-headers
```

| Bind                          | Flag                        | Effective policy                                                                                                           |
| ----------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Non-loopback (`0.0.0.0`, LAN) | `--trust-forwarded-headers` | **`same-origin` + forwarded** — also accepts `Origin` equal to `${X-Forwarded-Proto}://${X-Forwarded-Host}` (first value). |

> **Security:** only pass `--trust-forwarded-headers` when a **trusted** proxy sets those headers and the daemon is **not** reachable directly. If a client can hit the daemon without going through the proxy, it can spoof `X-Forwarded-Host` to forge an allowed origin. `--cors-origin` has no such caveat — prefer it when the public URL is fixed.

Everything stays behind your auth proxy either way: the session cookie rides the same-origin `crossorigin` asset requests, so forward-auth (e.g. Authelia) allows them — no need to exempt `/assets` from auth.

A worked **nginx + Authelia** example lives at [`docs/examples/compose-reverse-proxy-sso.yml`](examples/compose-reverse-proxy-sso.yml) (with its [`nginx-reverse-proxy-sso.conf`](examples/nginx-reverse-proxy-sso.conf)).

## Security

This release ships **without authentication**. Run it behind a reverse proxy (nginx, Caddy, Cloudflare Tunnel, …) or keep it on a loopback / Unix socket if exposed beyond your machine. The default bind address is `127.0.0.1`.

When exposing the TCP port to a browser, also pair `--cors-origin` with a tight origin allowlist (see above) so a random page in another tab cannot drive the simulator.

A middleware hook is reserved at the top of the `fetch` handler in `src/cli/server/httpServer.ts` for adding bearer tokens / mTLS later without changing route logic.

## Limits & Roadmap

- Phase 1 (current): per-CP REST + WS. Single global event stream.
- Future: bearer token auth, WebSocket-over-Unix-socket client, inbound WS commands, `POST /v1/cp` body accepting startup scenarios, browser UI integration via CORS.
