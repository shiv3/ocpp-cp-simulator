# Server Mode (Socket.IO Control Plane)

The simulator can run as a long-lived Bun process. A single daemon can host
**many charge points** concurrently and exposes one Socket.IO control plane for
the browser UI, the bundled CLI client, and external agents.

HTTP is now only the carrier:

- `GET /v1/healthz` returns `{ "ok": true }` and is unauthenticated.
- `GET/POST /socket.io/` are the Socket.IO / Engine.IO transport paths.
- Static assets are served only when `--web-console` is enabled.
- All former REST control endpoints and the Unix-domain socket listener are
  removed.

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

| Flag                                | Default                      | Description                                                                                                                                                                                                         |
| ----------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--daemon`                          | -                            | Background server. When no `--http-port` is supplied, listens on `127.0.0.1:9700`.                                                                                                                                  |
| `--http-port <port>`                | `9700` with bare `--daemon`  | TCP port for health, Socket.IO, and optional web console assets.                                                                                                                                                    |
| `--http-host <addr>`                | `127.0.0.1`                  | TCP bind address. Non-loopback binds require either `--web-console-basic-auth-user/pass` or `--unsafe-remote`.                                                                                                      |
| `--unsafe-remote`                   | -                            | Allows a non-loopback daemon bind without web-console Basic Auth. Use only on trusted networks or when another boundary handles access.                                                                             |
| `--web-console [<port>]`            | -                            | Serve the bundled browser UI alongside health and Socket.IO. Without a port, shares `--http-port`; with a port, serves the UI on that listener.                                                                     |
| `--web-console-basic-auth-user <u>` | -                            | Enables inbound Basic Auth for static assets and the Socket.IO handshake. Must be paired with `--web-console-basic-auth-pass`. The configured health path is exempt.                                                |
| `--web-console-basic-auth-pass <p>` | -                            | Password for the inbound web-console / Socket.IO auth gate.                                                                                                                                                         |
| `--cors-origin <origin>`            | loopback: open; remote: same | Restrict browser Origins. Repeat for an allowlist, or pass literal `"*"` to opt into open CORS.                                                                                                                     |
| `--trust-forwarded-headers`         | -                            | With same-origin CORS, also accept the public origin reported by `X-Forwarded-Proto` and `X-Forwarded-Host`. Use only behind a trusted reverse proxy.                                                               |
| `--unix-socket <path\|none>`        | deprecated accepted no-op    | Accepted for launcher compatibility, prints a warning, and is ignored. The control plane is TCP Socket.IO only.                                                                                                     |
| `--state-db <path>`                 | _(in-memory)_                | Persist scenarios, ChangeConfiguration overrides, charging profile state, availability flags, pending transaction messages, registered CPs and logs to a SQLite file (see [State persistence](#state-persistence)). |
| `--log-format <fmt>`                | `plain`                      | `plain` writes the legacy `[ts] [LEVEL] [TYPE] message` lines; `json` writes one JSON Lines object per line for structured-log collectors (see [Log format](#log-format)).                                          |
| `--health-path <path>`              | `/v1/healthz`                | Absolute path for the health-check JSON. The default is the only built-in health endpoint; set a custom path only when a proxy reserves the default.                                                                |

## HTTP Surfaces

| Method | Path                                  | Auth                                          | Returns / purpose                                                                                     |
| ------ | ------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| GET    | `/v1/healthz`                         | Exempt                                        | `{ "ok": true }`; used for browser Local/Remote detection, readiness checks, and Docker healthchecks. |
| GET    | `/socket.io/`                         | Socket.IO handshake auth if enabled           | Engine.IO polling / upgrade transport. Not a REST control endpoint.                                   |
| POST   | `/socket.io/`                         | Socket.IO handshake auth if enabled           | Engine.IO polling transport. Not a REST control endpoint.                                             |
| POST   | `<soapPath>/:cpId/ChargePointService` | HTTP Basic Auth if enabled or trusted network | OCPP 1.5 SOAP CSMS-to-CP callback endpoint. Default `soapPath` is `/ocpp/soap`.                       |
| GET    | static asset URL                      | HTTP Basic Auth if enabled                    | Web console assets when `--web-console` is enabled. Unknown page paths fall back to `index.html`.     |

Every other `/v1/*` path returns `404`.

The OCPP 1.5 SOAP callback endpoint relies on the same HTTP Basic-auth gate as
the web console, or on a trusted network boundary when that gate is disabled.
OCPP-S has no per-message authentication field, so the simulator does not add a
non-standard shared secret to SOAP payloads.

## Socket.IO RPC

Clients connect to the daemon's HTTP origin with Socket.IO path
`/socket.io/`. All request/response control calls use the `rpc` event:

```js
socket.emit("rpc", { cpId, method, params }, (ack) => {
  // ack is { ok: true, result } or
  //        { ok: false, error: { code, message } }
});
```

`cpId` is required for CP commands and omitted for daemon-level methods. CP
command method names are the JSON-mode command IDs verbatim; the server routes
them through the same command handler used by `--json`.

Error codes are closed over:
`not_found`, `invalid_params`, `internal`, `unauthorized`, `timeout`, and
`disconnected`.

The protocol schemas live in `src/protocol/` and are validated with `zod`.
Runtime packages for this control plane are `socket.io`,
`@socket.io/bun-engine`, `socket.io-client`, and `zod`.

### CP command methods

| Method                            | Params                                                                 | Notes                                                    |
| --------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| `connect`                         | `{}`                                                                   | Connect to the CSMS.                                     |
| `disconnect`                      | `{}`                                                                   | Disconnect from the CSMS.                                |
| `status`                          | `{}`                                                                   | Returns the redacted CP status snapshot.                 |
| `heartbeat`                       | `{}`                                                                   | Send one Heartbeat.                                      |
| `start_heartbeat`                 | `{ "interval": number }`                                               | Start periodic Heartbeat in seconds.                     |
| `stop_heartbeat`                  | `{}`                                                                   | Stop periodic Heartbeat.                                 |
| `start_transaction`               | `{ "connector": number, "tagId": string }`                             | `connector` must be `>= 1`.                              |
| `stop_transaction`                | `{ "connector": number }`                                              | `connector` must be `>= 1`.                              |
| `authorize`                       | `{ "tagId": string }`                                                  | Send Authorize.                                          |
| `diagnostics_status_notification` | `{ "status": string }`                                                 | Send DiagnosticsStatusNotification.                      |
| `firmware_status_notification`    | `{ "status": string }`                                                 | Send FirmwareStatusNotification.                         |
| `update_connector_status`         | `{ "connector": number, "status": string }`                            | Only this connector-taking method accepts connector `0`. |
| `set_meter_value`                 | `{ "connector": number, "value": number }`                             | `value` is Wh and must be a non-negative integer.        |
| `send_meter_value`                | `{ "connector": number }`                                              | Send current meter value to the CSMS.                    |
| `remove_connector`                | `{ "connector": number }`                                              | Remove a connector from the simulated CP.                |
| `set_ev_settings`                 | `{ "connector": number, "settings": object }`                          | Store EV settings for a connector.                       |
| `get_ev_settings`                 | `{ "connector": number }`                                              | Return EV settings for a connector.                      |
| `set_auto_meter_config`           | `{ "connector": number, "config": object }`                            | Configure automatic meter values.                        |
| `get_auto_meter_config`           | `{ "connector": number }`                                              | Return automatic meter-value config.                     |
| `set_auto_reset_to_available`     | `{ "connector": number, "enabled": boolean }`                          | Toggle auto-reset to Available.                          |
| `set_mode`                        | `{ "connector": number, "mode": string }`                              | Set connector mode.                                      |
| `set_soc`                         | `{ "connector": number, "soc": number \| null }`                       | Set or clear SoC.                                        |
| `set_soc_meter_sync`              | `{ "connector": number, "enabled": boolean }`                          | Toggle SoC-to-meter synchronization.                     |
| `get_charging_profiles`           | `{ "connector": number }`                                              | Return active charging profiles.                         |
| `get_state_history`               | `{ "options"?: object }`                                               | Return state history for the CP.                         |
| `list_scenario_templates`         | `{}`                                                                   | List built-in scenario templates.                        |
| `load_scenario_template`          | `{ "connector": number, "templateId": string, "evSettings"?: object }` | Load a built-in template.                                |
| `load_scenario`                   | `{ "connector": number, "file"?: string, "scenario"?: object }`        | Load a scenario from a file path or inline definition.   |
| `list_scenarios`                  | `{ "connector": number }`                                              | List loaded scenarios.                                   |
| `run_scenario`                    | `{ "connector": number, "scenarioId": string }`                        | Run a loaded scenario.                                   |
| `run_scenario_file`               | `{ "connector": number, "file": string }`                              | Load and run a scenario file.                            |
| `run_scenario_template`           | `{ "connector": number, "templateId": string, "evSettings"?: object }` | Load and run a built-in template.                        |
| `scenario_status`                 | `{ "connector": number, "scenarioId": string }`                        | Return scenario execution status.                        |
| `get_scenario`                    | `{ "connector": number, "scenarioId": string }`                        | Return a loaded scenario definition.                     |
| `stop_scenario`                   | `{ "connector": number, "scenarioId": string }`                        | Stop one scenario.                                       |
| `step_scenario`                   | `{ "connector": number, "scenarioId": string, "force"?: boolean }`     | Step a scenario.                                         |
| `stop_all_scenarios`              | `{ "connector": number }`                                              | Stop every scenario on a connector.                      |
| `remove_scenario`                 | `{ "connector": number, "scenarioId": string }`                        | Remove a loaded scenario.                                |

### Daemon methods

| Method               | Params                                                                                                                                                                                                | Result / purpose                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `cp.list`            | `{}`                                                                                                                                                                                                  | Array of redacted CP registry items.                                                  |
| `cp.create`          | `{ "cpId": string, "wsUrl": string, "connectors"?: number, "vendor"?: string, "model"?: string, "ocppVersion"?: string, "basicAuth"?: object, "bootNotification"?: object, "autoConnect"?: boolean }` | Create a CP; `autoConnect: true` connects it after creation.                          |
| `cp.update`          | Same as `cp.create`                                                                                                                                                                                   | Replace an existing CP config; `autoConnect: true` reconnects it after update.        |
| `cp.delete`          | `{ "cpId": string }`                                                                                                                                                                                  | Remove a CP from the registry.                                                        |
| `logs.get`           | `{ "cpId": string, "limit"?: number }`                                                                                                                                                                | Return persisted logs, or the in-memory log buffer when no state DB is configured.    |
| `logs.clear`         | `{ "cpId": string }`                                                                                                                                                                                  | Delete persisted logs for the CP.                                                     |
| `state.reset`        | `{}`                                                                                                                                                                                                  | Drop in-memory CPs and clear simulator-owned state DB tables while preserving schema. |
| `server.shutdown`    | `{}`                                                                                                                                                                                                  | Request daemon shutdown.                                                              |
| `events.subscribe`   | `{ "scope": "*" \| "registry" \| "<cpId>" }`                                                                                                                                                          | Join event rooms and return an atomic snapshot.                                       |
| `events.unsubscribe` | `{ "scope": "*" \| "registry" \| "<cpId>" }`                                                                                                                                                          | Leave an event room.                                                                  |

## Event Push and Rooms

Server-to-client push uses one Socket.IO event:

```js
socket.on("event", (envelope) => {
  // envelope.kind is "cp" or "registry"
});
```

CP event envelope:

```json
{
  "kind": "cp",
  "cpId": "CP001",
  "evt": {
    "event": "transaction_started",
    "data": { "connectorId": 1, "transactionId": 1234, "tagId": "TAG001" },
    "timestamp": "2026-05-25T10:00:00.000Z"
  }
}
```

Registry event envelope:

```json
{
  "kind": "registry",
  "change": "added",
  "cp": {
    "cpId": "CP001",
    "status": "Available",
    "wsUrl": "ws://localhost:9000/ocpp",
    "connectors": 1,
    "vendor": "Server-Vendor",
    "model": "Server-Model",
    "basicAuth": null,
    "bootNotification": null
  }
}
```

Subscribe with `events.subscribe`:

```js
const ack = await socket.timeout(30_000).emitWithAck("rpc", {
  method: "events.subscribe",
  params: { scope: "CP001" },
});
```

Scopes:

| Scope        | Push events received                                        | Subscribe result snapshot                                                                  |
| ------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `"*"`        | CP events for every CP and all registry changes             | `snapshot.cps` for the registry and `snapshot.perCp` for every CP.                         |
| `"registry"` | Registry `added`, `removed`, `updated`, and `reset` changes | `snapshot.cps` for the registry and `snapshot.perCp` for every CP.                         |
| `"<cpId>"`   | CP events for that CP                                       | `snapshot.cps` still includes registry entries; `snapshot.perCp` includes the selected CP. |

The subscribe ack is atomic: the room join and snapshot capture happen together,
so clients can apply the snapshot before processing subsequent `event` pushes.

## End-to-End Example (socket.io-client)

```js
// agent.mjs
import { io } from "socket.io-client";

const socket = io("http://127.0.0.1:9700", { path: "/socket.io/" });
const rpc = (request) => socket.timeout(30_000).emitWithAck("rpc", request);

socket.on("event", (envelope) => console.log(JSON.stringify(envelope)));

await new Promise((resolve, reject) => {
  socket.once("connect", resolve);
  socket.once("connect_error", reject);
});

console.log(await rpc({ method: "cp.list", params: {} }));

await rpc({
  method: "cp.create",
  params: {
    cpId: "CP001",
    wsUrl: "ws://localhost:9000/ocpp",
    autoConnect: true,
  },
});

await rpc({ method: "events.subscribe", params: { scope: "CP001" } });

await rpc({
  cpId: "CP001",
  method: "start_transaction",
  params: { connector: 1, tagId: "TAG001" },
});

await rpc({
  cpId: "CP001",
  method: "set_meter_value",
  params: { connector: 1, value: 1000 },
});

await rpc({
  cpId: "CP001",
  method: "stop_transaction",
  params: { connector: 1 },
});

await rpc({ method: "server.shutdown", params: {} });
socket.disconnect();
```

## Controlling a Running Daemon from the CLI

A daemon does not have to be driven by a raw Socket.IO client or the web
console. The same `ocpp-cp-sim` binary doubles as a TCP Socket.IO client for a
server someone else started:

```bash
# Send an OCPP command to a CP managed by the daemon
ocpp-cp-sim --http-url http://127.0.0.1:9700 \
  --cp-id CP001 --send '{"command":"status"}'

# Stream that CP's events
ocpp-cp-sim --http-url http://127.0.0.1:9700 --cp-id CP001 --events

# Stream all CP and registry events
ocpp-cp-sim --http-url http://127.0.0.1:9700 --events --all

# Shut the daemon down
ocpp-cp-sim --http-url http://127.0.0.1:9700 --stop
```

Client modes default to `http://127.0.0.1:9700`, so `--http-url` is optional for
a bare local daemon.

### Authenticating to a Protected Daemon

When the daemon is started with `--web-console-basic-auth-user/pass`, static
assets stay HTTP Basic-Auth-gated and Socket.IO clients must send the same
credentials in `socket.handshake.auth`.

The bundled CLI sends that handshake auth when you pass
`--http-basic-auth-user` / `--http-basic-auth-pass`:

```bash
# Daemon side: require Basic Auth for web console assets and Socket.IO
ocpp-cp-sim --daemon --http-port 9700 \
  --web-console-basic-auth-user admin --web-console-basic-auth-pass secret

# Client side: authenticate to it
ocpp-cp-sim --http-url http://127.0.0.1:9700 \
  --cp-id CP001 --send '{"command":"status"}' \
  --http-basic-auth-user admin --http-basic-auth-pass secret
```

External Socket.IO clients should pass:

```js
io("http://127.0.0.1:9700", {
  path: "/socket.io/",
  auth: { username: "admin", password: "secret" },
});
```

The CSMS-facing `--basic-auth-user/pass` flags are unrelated; those authenticate
the simulated CP's outgoing WebSocket to the CSMS.

## State Persistence

The daemon keeps everything in memory by default. Pass `--state-db <path>` to
write to a SQLite file instead — useful for survive-restart use cases
(long-running CSMS integration tests, simulated EVs that should keep their
`MeterValueSampleInterval` override or their `Inoperative` flag across reboots).

```bash
# Persist to a file in the current directory
ocpp-cp-sim --daemon \
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
| `kv`                 | App-level prefs (global config, SoC↔Meter sync, etc.).                                                                                                  |

### Reset

The browser ships a **Reset all simulator data** button (Settings page) that
calls the daemon's `state.reset` RPC in Remote mode. External clients can do the
same:

```js
await rpc({ method: "state.reset", params: {} });
```

Both paths also drop every in-memory CP first so live WebSockets do not keep
writing to the about-to-be-empty DB.

### Browser

Browser mode uses the same schema, backed by sql.js + IndexedDB. Each browser
profile keeps one DB blob under the `ocpp-cp-simulator` IndexedDB database;
clearing site data wipes simulator state. sql.js is only loaded when the page
determines it is in Local mode via a `/v1/healthz` probe at the page origin
(path configurable, see [Health](#health)) — Remote mode skips the WASM
download entirely and uses the daemon's Socket.IO control plane.

## Log Format

By default the daemon writes human-readable log lines:

```
[2026-06-01T11:18:38.409Z] [INFO] [OCPP] Boot notification accepted
[2026-06-01T11:18:38.409Z] [INFO] [WebSocket] Sent: [2,"…","StatusNotification",{"connectorId":0,"errorCode":"NoError","status":"Available"}]
```

Pass `--log-format json` to switch to JSON Lines — one object per line,
including the `[server] xxx` setup chatter:

```json
{"timestamp":"2026-06-01T11:18:38.373Z","level":"INFO","type":"Server","message":"Listening on http://127.0.0.1:9700 (socket.io)"}
{"timestamp":"2026-06-01T11:18:38.409Z","level":"INFO","type":"OCPP","message":"Boot notification accepted","cpId":"CP001"}
{"timestamp":"2026-06-01T11:18:38.409Z","level":"INFO","type":"WebSocket","message":"Sent: [2,…]","cpId":"CP001"}
```

The shape (`timestamp` / `level` / `type` / `message` / optional `cpId`) is
identical to:

- the rows persisted in the `logs` table,
- the JSON Lines file produced by the browser's "Download" button in the log
  viewer,
- the result of the `logs.get` RPC method.

So you can pipe daemon stderr into the same `jq` pipeline that consumes a
downloaded log file.

### Related RPC methods

| Method        | Params                                 | Returns / purpose                                                                                                    |
| ------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `logs.get`    | `{ "cpId": string, "limit"?: number }` | Persisted log rows for the CP, oldest-first. Falls back to the in-memory Logger buffer when `--state-db` is not set. |
| `logs.clear`  | `{ "cpId": string }`                   | Delete the persisted log rows for the CP.                                                                            |
| `state.reset` | `{}`                                   | Truncate every simulator-owned table, then disconnect/forget every in-memory CP. Schema is preserved.                |

## Docker

A `Dockerfile` and `docker-compose.yml` ship at the repo root, and a multi-arch
image is published on every push to `main` / version tag at
`ghcr.io/shiv3/ocpp-cp-simulator`. See [docs/docker.md](./docker.md) for the
full reference (volumes, environment variables, compose recipes, structured-log
piping). Quick path:

```sh
docker run --rm -p 9700:9700 -v "$PWD/.state:/data" \
  ghcr.io/shiv3/ocpp-cp-simulator:latest \
  --cp-id CP001 --ws-url wss://example.invalid/chargepoint/
```

The image is Bun-based and ships **both** the daemon and the React browser UI.
Vite builds `dist/` in a build stage and the daemon serves it from the same HTTP
port as health and Socket.IO (SPA-aware: unknown paths fall back to
`index.html`).

Notes:

- The ENTRYPOINT pins `--http-host 0.0.0.0 --unsafe-remote --web-console
$HTTP_PORT`. The unsafe override is explicit because Docker intentionally
  exposes the daemon beyond loopback; access is controlled by Docker port
  mapping, CORS, Basic Auth, and any surrounding network policy.
- After `docker run …` open `http://localhost:9700/` to use the browser UI. It
  talks to the daemon over Socket.IO on the same origin, so CORS / dev-server
  routing is a non-issue.
- The image's `HEALTHCHECK` hits `$HEALTH_PATH` (default `/v1/healthz`), so
  `docker ps` shows `healthy` / `unhealthy` once the daemon is up.
- Override the bound port by setting the `HTTP_PORT` env var (for example
  `-e HTTP_PORT=8080`). The published host port via `-p` is independent.

## Health

```
GET /v1/healthz
→ { "ok": true }
```

The path is configurable via `--health-path <path>` (default `/v1/healthz`).
Change it when a reverse proxy in front of the daemon reserves the default path
— for example Google Front End in front of Cloud Run returning 404 directly on
certain reserved paths before the request hits the container.

The browser UI's Remote-mode auto-detect probe targets the path inlined at UI
build time via `VITE_HEALTH_PATH` (same default). The UI build value and daemon
`--health-path` must match.

## CORS

The CORS policy depends on the bind address and any `--cors-origin` flags:

| Bind                          | `--cors-origin` flag       | Effective policy                                                                                                                                                         |
| ----------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Loopback (`127.0.0.1`, etc.)  | _(none)_                   | **`any`** — `*` echoed back. Safe because nothing off-host can reach loopback anyway.                                                                                    |
| Non-loopback (`0.0.0.0`, LAN) | _(none)_                   | **`same-origin`** — only requests whose `Origin` matches the request `Host` are allowed (plus non-browser callers with no `Origin` header). A warning is logged at boot. |
| Any                           | `--cors-origin <url>` (×N) | **`allowlist`** — only the listed origins are echoed back.                                                                                                               |
| Any                           | `--cors-origin "*"`        | **`any`** — explicit opt-in to open CORS.                                                                                                                                |

Binding a daemon to a non-loopback host without
`--web-console-basic-auth-user/pass` also requires `--unsafe-remote`; otherwise
startup fails before CORS comes into play.

For browser UIs hosted on a different origin, allowlist them:

```sh
ocpp-cp-sim --daemon --http-port 9700 \
  --cors-origin http://localhost:5173 \
  --cors-origin https://ocpp-ui.example.com
```

Or opt back into open CORS deliberately (LAN test rigs, scripted integration
tests):

```sh
ocpp-cp-sim --daemon --http-port 9700 --http-host 0.0.0.0 \
  --unsafe-remote --cors-origin "*"
```

Non-browser callers (the bundled CLI, server-to-server Socket.IO clients) do
not send an `Origin` header and are always allowed regardless of policy. The
policy only restricts cross-site browser access.

### Behind a Reverse Proxy (Traefik, nginx, Caddy, …)

This is the most common gotcha when serving the web console (`--web-console`)
behind a proxy at a public HTTPS URL. The Vite `index.html` references its
bundle with `crossorigin`, so the browser sends an `Origin` header even for the
page's own assets:

```
GET https://app.example.com/assets/index-*.js   403 (Forbidden)
GET https://app.example.com/assets/index-*.css  403 (Forbidden)
```

The daemon serves those assets fine internally (`200`), but with the
`same-origin` default it only knows its internal bind address
(`0.0.0.0:9700`), not the public URL the proxy exposes. The browser's
`Origin: https://app.example.com` does not match, so the daemon returns `403`.

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

> **Security:** only pass `--trust-forwarded-headers` when a **trusted** proxy
> sets those headers and the daemon is **not** reachable directly. If a client
> can hit the daemon without going through the proxy, it can spoof
> `X-Forwarded-Host` to forge an allowed origin. `--cors-origin` has no such
> caveat — prefer it when the public URL is fixed.

A worked **nginx + Authelia** example lives at
[`docs/examples/compose-reverse-proxy-sso.yml`](examples/compose-reverse-proxy-sso.yml)
(with its
[`nginx-reverse-proxy-sso.conf`](examples/nginx-reverse-proxy-sso.conf)).

## Security

The default bind address is `127.0.0.1`. Exposing the daemon beyond loopback
requires one of:

- `--web-console-basic-auth-user/pass`, which gates static assets and the
  Socket.IO handshake while leaving health unauthenticated,
- `--unsafe-remote`, for trusted networks or deployments protected by another
  boundary.

Pair remote exposure with a tight `--cors-origin` allowlist when browsers can
reach the daemon. CORS is not authentication; it only limits which browser
origins can make cross-site requests.

## Limits & Roadmap

- Current: one Socket.IO connection per client, `rpc` ack for commands, `event`
  push for CP and registry updates, and TCP-only daemon control.
- Removed: REST control endpoints, native WebSocket event streams, and the
  Unix-domain socket control listener.
- Future: bearer token auth or mTLS can be added at the HTTP/socket boundary
  without changing CP command method names.
