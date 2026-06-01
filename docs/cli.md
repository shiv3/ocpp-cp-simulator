# CLI Mode

Headless charge point simulator for scripting, CI pipelines, and AI/automation integration. Runs on [Bun](https://bun.sh/).

## Prerequisites

- [Bun](https://bun.sh/) runtime

## Quick Start

```bash
# Interactive REPL
bun src/cli/main.ts --ws-url ws://localhost:9000/ocpp --cp-id CP001

# JSON Lines mode (for automation)
bun src/cli/main.ts --ws-url ws://localhost:9000/ocpp --cp-id CP001 --json

# npm script shorthand
npm run cli -- --ws-url ws://localhost:9000/ocpp --cp-id CP001
```

### Installing as the `ocpp-cp-sim` command

The package exposes a `ocpp-cp-sim` bin so it can be invoked from anywhere once installed:

```bash
# Prebuilt release tarball (recommended) — ships the web-console dist/
bun install -g https://github.com/shiv3/ocpp-cp-simulator/releases/latest/download/ocpp-cp-simulator.tgz

# Or pin to a specific CLI release
bun install -g https://github.com/shiv3/ocpp-cp-simulator/releases/download/cli-v0.1.0/ocpp-cp-simulator-0.1.0.tgz

# From a local checkout (dev)
bun link
bun link ocpp-cp-simulator    # in any consumer project

# Then use ocpp-cp-sim anywhere
ocpp-cp-sim --ws-url ws://localhost:9000/ocpp --cp-id CP001
ocpp-cp-sim --daemon --http-port 9700
```

> A plain `bun install -g github:shiv3/ocpp-cp-simulator` is **not** supported: the web-console `dist/` is built at release time (not committed to git), and bun doesn't install devDependencies for global packages so it can't run `vite build` on install. Use the prebuilt tarball URL above.

All flags described below apply to both `ocpp-cp-sim ...` and `bun src/cli/main.ts ...`.

## Operation Modes

### 1. Interactive REPL

Default mode. Connects to a CSMS and provides a `ocpp>` prompt.

```bash
bun src/cli/main.ts --ws-url ws://localhost:9000/ocpp --cp-id CP001
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

Machine-readable mode for automation and AI agent integration. Each line of stdin is a JSON command; each line of stdout is a JSON response or event.

```bash
bun src/cli/main.ts --ws-url ws://localhost:9000/ocpp --cp-id CP001 --json
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

Asynchronous events are emitted as JSON lines without `ok` field:

```json
{"event": "connected", "data": {}, "timestamp": "2025-01-01T00:00:00.000Z"}
{"event": "connector_status", "data": {"connectorId": 1, "status": "Charging", "previousStatus": "Available"}, "timestamp": "..."}
```

#### Available Commands

| Command                   | Params                            | Description                        |
| ------------------------- | --------------------------------- | ---------------------------------- |
| `connect`                 | -                                 | Connect to CSMS                    |
| `disconnect`              | -                                 | Disconnect                         |
| `status`                  | -                                 | Get charge point status            |
| `start_transaction`       | `connector`, `tagId`              | Start transaction                  |
| `stop_transaction`        | `connector`                       | Stop transaction                   |
| `set_meter_value`         | `connector`, `value`              | Set meter value (Wh)               |
| `send_meter_value`        | `connector`                       | Send meter value to CSMS           |
| `heartbeat`               | -                                 | Send heartbeat                     |
| `start_heartbeat`         | `interval`                        | Start periodic heartbeat (seconds) |
| `stop_heartbeat`          | -                                 | Stop periodic heartbeat            |
| `authorize`               | `tagId`                           | Send authorization                 |
| `update_connector_status` | `connector`, `status`             | Update connector status            |
| `list_scenario_templates` | -                                 | List built-in scenario templates   |
| `load_scenario_template`  | `templateId`, `connector`         | Load a scenario template           |
| `load_scenario`           | `connector`, `file` or `scenario` | Load scenario from file or inline  |
| `list_scenarios`          | `connector`                       | List loaded scenarios              |
| `run_scenario`            | `connector`, `scenarioId`         | Run a loaded scenario              |
| `scenario_status`         | `connector`, `scenarioId`         | Get scenario execution status      |
| `stop_scenario`           | `connector`, `scenarioId`         | Stop a running scenario            |
| `stop_all_scenarios`      | `connector`                       | Stop all scenarios on connector    |
| `run_scenario_file`       | `connector`, `file`               | Load and run scenario from file    |
| `run_scenario_template`   | `connector`, `templateId`         | Load and run a template            |

### 3. Daemon / Server Mode

Long-running process that exposes an **HTTP + WebSocket** API over a Unix domain socket and/or TCP port. Replaces the legacy line-delimited JSON protocol. See [docs/server.md](server.md) for the full HTTP API reference.

```bash
# Start daemon (Unix socket only, default /tmp/ocpp-server.sock)
bun src/cli/main.ts --ws-url ws://localhost:9000/ocpp --cp-id CP001 --daemon &

# Start daemon with both Unix socket and TCP
bun src/cli/main.ts --ws-url ws://localhost:9000/ocpp --cp-id CP001 --daemon --http-port 9700 &

# Start foreground HTTP server (no Unix socket by default)
bun src/cli/main.ts --http-port 9700

# Send command to running server (Unix socket by default)
bun src/cli/main.ts --cp-id CP001 --send '{"command": "status"}'

# Send command via TCP HTTP
bun src/cli/main.ts --cp-id CP001 --http-url http://127.0.0.1:9700 --send '{"command": "status"}'

# Subscribe to real-time events (TCP only)
bun src/cli/main.ts --cp-id CP001 --http-url http://127.0.0.1:9700 --events

# Subscribe to all CPs' events
bun src/cli/main.ts --http-url http://127.0.0.1:9700 --events --all

# Shut down the server
bun src/cli/main.ts --stop
```

#### Server Files

| File                    | Description                               |
| ----------------------- | ----------------------------------------- |
| `/tmp/ocpp-server.sock` | Unix domain socket (HTTP/WS, daemon)      |
| `/tmp/ocpp-server.pid`  | PID file for duplicate detection (daemon) |

Use `--unix-socket /custom/path` to change the path. Use `--unix-socket none` to disable Unix socket entirely (TCP-only daemon).

#### Multiple Charge Points in One Process

`--cp-id` becomes optional in server mode. Additional CPs can be added at runtime via `POST /v1/cp`:

```bash
# Start with no initial CP
bun src/cli/main.ts --daemon --http-port 9700 &

# Create CPs dynamically
curl -X POST http://127.0.0.1:9700/v1/cp \
  -H 'content-type: application/json' \
  -d '{"cpId":"CP001","wsUrl":"ws://localhost:9000/ocpp","autoConnect":true}'

curl -X POST http://127.0.0.1:9700/v1/cp \
  -H 'content-type: application/json' \
  -d '{"cpId":"CP002","wsUrl":"ws://localhost:9000/ocpp","autoConnect":true}'
```

#### Startup Scenarios

Run a scenario automatically when bootstrapping a CP at startup. All three
sources can target a single connector, a comma-separated list, or every
connector via `--scenario-connector all`.

```bash
# Built-in template on connector 1
ocpp-cp-sim --daemon --ws-url ws://localhost:9000/ocpp --cp-id CP001 \
  --scenario-template basic-charging --scenario-connector 1

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
`ScenarioDefinition` (the format the browser Scenario Editor exports), then
clones it per connector — rewriting `targetType`, `targetId`, `id`, and
`name` — so each connector runs an independent state machine from the same
file. `--scenario` and `--scenario-template` fan out the same way when
`--scenario-connector` resolves to more than one id.

> **Breaking change (vs. earlier versions):** the legacy line-delimited JSON protocol on `/tmp/ocpp-<cpId>.sock` has been removed. The daemon now speaks HTTP/WebSocket. If you have external clients that wrote raw JSON to the old socket, migrate them to `POST /v1/cp/<cpId>/command` (HTTP can run over the Unix socket as well).

## Events

Events are emitted in all modes (REPL shows formatted text, JSON/daemon emit JSON).

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

| Option                         | Required | Default                 | Description                                                                                                                                                                                                                                                                                             |
| ------------------------------ | -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--cp-id <id>`                 | Yes\*    | -                       | Charge Point ID                                                                                                                                                                                                                                                                                         |
| `--ws-url <url>`               | Yes\*\*  | -                       | WebSocket URL of CSMS                                                                                                                                                                                                                                                                                   |
| `--connectors <n>`             | No       | `1`                     | Number of connectors                                                                                                                                                                                                                                                                                    |
| `--json`                       | No       | -                       | JSON Lines mode                                                                                                                                                                                                                                                                                         |
| `--daemon`                     | No       | -                       | Server daemon (Unix socket ON by default)                                                                                                                                                                                                                                                               |
| `--http-port <port>`           | No       | -                       | Enable HTTP/WebSocket on this TCP port                                                                                                                                                                                                                                                                  |
| `--http-host <addr>`           | No       | `127.0.0.1`             | Bind address for HTTP                                                                                                                                                                                                                                                                                   |
| `--unix-socket <path>`         | No       | `/tmp/ocpp-server.sock` | Unix socket path; `none` to disable                                                                                                                                                                                                                                                                     |
| `--http-url <url>`             | No       | -                       | Client target: TCP HTTP base URL                                                                                                                                                                                                                                                                        |
| `--send <json>`                | No       | -                       | Send command to running server                                                                                                                                                                                                                                                                          |
| `--events`                     | No       | -                       | Subscribe to events (TCP only)                                                                                                                                                                                                                                                                          |
| `--all`                        | No       | -                       | With `--events`, subscribe to all CPs' events                                                                                                                                                                                                                                                           |
| `--stop`                       | No       | -                       | Shut down the running server                                                                                                                                                                                                                                                                            |
| `--basic-auth-user <u>`        | No       | -                       | Basic auth username                                                                                                                                                                                                                                                                                     |
| `--basic-auth-pass <p>`        | No       | -                       | Basic auth password                                                                                                                                                                                                                                                                                     |
| `--vendor <vendor>`            | No       | `CLI-Vendor`            | Charge point vendor                                                                                                                                                                                                                                                                                     |
| `--model <model>`              | No       | `CLI-Model`             | Charge point model                                                                                                                                                                                                                                                                                      |
| `--scenario <file>`            | No       | -                       | Startup scenario JSON file (server mode)                                                                                                                                                                                                                                                                |
| `--scenario-template <id>`     | No       | -                       | Built-in scenario template id (server mode)                                                                                                                                                                                                                                                             |
| `--scenario-template-file <p>` | No       | -                       | Path to a cpId-independent template JSON                                                                                                                                                                                                                                                                |
| `--scenario-connector <list>`  | No       | `1`                     | `all`, single id (`1`), or list (`1,2,3`)                                                                                                                                                                                                                                                               |
| `--state-db <path>`            | No       | _(in-memory)_           | Persist scenarios, ChangeConfiguration overrides, charging profile state, availability flags, pending transaction messages, registered CPs and logs to a SQLite file. See [docs/server.md → State persistence](./server.md#state-persistence). Without this flag the daemon forgets everything at exit. |
| `--log-format <fmt>`           | No       | `plain`                 | `plain` writes the legacy `[ts] [LEVEL] [TYPE] message` lines; `json` writes one JSON Lines object per line (same shape as the `logs` table + browser export + `GET /v1/cp/:cpId/logs`). See [docs/server.md → Log format](./server.md#log-format).                                                     |

\* `--cp-id` is **optional** in server mode (no bootstrap CP). Required for REPL/JSON and for `--send`/`--events` (without `--all`).
\*\* `--ws-url` is required for REPL/JSON, and only when bootstrapping a CP in server mode. CPs created later via HTTP supply their own `wsUrl` in the request body.
