# Server Mode (HTTP + WebSocket)

The simulator can run as a long-lived process exposing an HTTP/WebSocket API. A single process can host **many charge points** concurrently. Requires the [Bun](https://bun.sh/) runtime.

The same HTTP/WS handlers are exposed over both a TCP port and a Unix domain socket, so local tools can use the Unix socket for lower-overhead IPC while remote clients use TCP.

> All examples below show `bun src/cli/main.ts` for clarity when working from a checkout. If you've installed the package (`bun link` or `bun install -g`), `cp-sim` is interchangeable everywhere.

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

| Flag                         | Default                   | Description                                           |
| ---------------------------- | ------------------------- | ----------------------------------------------------- |
| `--daemon`                   | -                         | Background server. Unix socket enabled by default.    |
| `--http-port <port>`         | -                         | TCP port for HTTP/WebSocket.                          |
| `--http-host <addr>`         | `127.0.0.1`               | TCP bind address. Use `0.0.0.0` to expose externally. |
| `--unix-socket <path\|none>` | `/tmp/ocpp-server.sock`\* | Unix socket path. `none` disables Unix socket.        |

\* Default applies only with `--daemon`. Without `--daemon`, the Unix socket is **off** unless `--unix-socket <path>` is given explicitly.

## HTTP API

All responses are JSON. Command responses follow the same `{ ok, data?, error? }` shape used by the JSON Lines mode.

### Health

```
GET /healthz
→ { "ok": true, "cps": 2 }
```

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

## Security

This release ships **without authentication**. Run it behind a reverse proxy (nginx, Caddy, Cloudflare Tunnel, …) or keep it on a loopback / Unix socket if exposed beyond your machine. The default bind address is `127.0.0.1`.

A middleware hook is reserved at the top of the `fetch` handler in `src/cli/server/httpServer.ts` for adding bearer tokens / mTLS later without changing route logic.

## Limits & Roadmap

- Phase 1 (current): per-CP REST + WS. Single global event stream.
- Future: bearer token auth, WebSocket-over-Unix-socket client, inbound WS commands, `POST /v1/cp` body accepting startup scenarios, browser UI integration via CORS.
