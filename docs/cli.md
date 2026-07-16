# CLI Mode

Headless charge point simulator for scripting, CI pipelines, and
AI/automation integration. Runs on [Bun](https://bun.sh/).

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
bun install -g https://github.com/shiv3/ocpp-cp-simulator/releases/latest/download/ocpp-cp-simulator.tgz

# Or pin to a specific CLI release
bun install -g https://github.com/shiv3/ocpp-cp-simulator/releases/download/cli-v0.1.0/ocpp-cp-simulator-0.1.0.tgz

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

These command IDs are also the CP-scoped Socket.IO RPC method names in daemon
mode.

| Command                           | Params                                         | Description                        |
| --------------------------------- | ---------------------------------------------- | ---------------------------------- |
| `connect`                         | -                                              | Connect to CSMS                    |
| `disconnect`                      | -                                              | Disconnect                         |
| `status`                          | -                                              | Get charge point status            |
| `heartbeat`                       | -                                              | Send heartbeat                     |
| `start_heartbeat`                 | `interval`                                     | Start periodic heartbeat (seconds) |
| `stop_heartbeat`                  | -                                              | Stop periodic heartbeat            |
| `start_transaction`               | `connector`, `tagId`                           | Start transaction                  |
| `stop_transaction`                | `connector`                                    | Stop transaction                   |
| `authorize`                       | `tagId`                                        | Send authorization                 |
| `diagnostics_status_notification` | `status`                                       | Send diagnostics status            |
| `firmware_status_notification`    | `status`                                       | Send firmware status               |
| `update_connector_status`         | `connector`, `status`                          | Update connector status            |
| `set_meter_value`                 | `connector`, `value`                           | Set meter value (Wh)               |
| `send_meter_value`                | `connector`                                    | Send meter value to CSMS           |
| `remove_connector`                | `connector`                                    | Remove a connector                 |
| `set_ev_settings`                 | `connector`, `settings`                        | Set EV settings                    |
| `get_ev_settings`                 | `connector`                                    | Get EV settings                    |
| `set_auto_meter_config`           | `connector`, `config`                          | Configure automatic meter values   |
| `get_auto_meter_config`           | `connector`                                    | Get automatic meter config         |
| `set_auto_reset_to_available`     | `connector`, `enabled`                         | Toggle auto-reset to Available     |
| `set_mode`                        | `connector`, `mode`                            | Set connector mode                 |
| `set_soc`                         | `connector`, `soc`                             | Set or clear SoC                   |
| `set_soc_meter_sync`              | `connector`, `enabled`                         | Toggle SoC-meter sync              |
| `get_charging_profiles`           | `connector`                                    | Get active charging profiles       |
| `get_state_history`               | `options` (optional)                           | Get state history                  |
| `list_scenario_templates`         | -                                              | List built-in scenario templates   |
| `load_scenario_template`          | `templateId`, `connector`, `evSettings` (opt.) | Load a scenario template           |
| `load_scenario`                   | `connector`, `file` or `scenario`              | Load scenario from file or inline  |
| `list_scenarios`                  | `connector`                                    | List loaded scenarios              |
| `run_scenario`                    | `connector`, `scenarioId`                      | Run a loaded scenario              |
| `run_scenario_file`               | `connector`, `file`                            | Load and run scenario from file    |
| `run_scenario_template`           | `connector`, `templateId`, `evSettings` (opt.) | Load and run a template            |
| `scenario_status`                 | `connector`, `scenarioId`                      | Get scenario execution status      |
| `get_scenario`                    | `connector`, `scenarioId`                      | Get a loaded scenario              |
| `stop_scenario`                   | `connector`, `scenarioId`                      | Stop a running scenario            |
| `step_scenario`                   | `connector`, `scenarioId`, `force` (optional)  | Step a scenario                    |
| `stop_all_scenarios`              | `connector`                                    | Stop all scenarios on connector    |
| `remove_scenario`                 | `connector`, `scenarioId`                      | Remove a loaded scenario           |

### 3. Daemon / Server Mode

Long-running process that exposes health, optional static web-console assets,
and a Socket.IO control plane on TCP. See [docs/server.md](server.md) for the
full Socket.IO API reference.

```bash
# Start daemon on the default TCP target: http://127.0.0.1:9700
ocpp-cp-sim --daemon &

# Start daemon with an initial CP and default TCP control plane
ocpp-cp-sim --ws-url ws://localhost:9000/ocpp --cp-id CP001 --daemon &

# Start foreground server on a custom TCP port
ocpp-cp-sim --http-port 9701

# Daemon + bundled browser UI
ocpp-cp-sim --daemon --web-console

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
the Socket.IO RPC contract documented in [server.md](server.md#daemon-methods)
and through the browser UI.

#### Server Files

| File                   | Description                               |
| ---------------------- | ----------------------------------------- |
| `/tmp/ocpp-server.pid` | PID file for duplicate detection (daemon) |

There is no Unix-domain socket listener. `--unix-socket <path|none>` is still
accepted for launcher compatibility, prints a deprecation warning, and is
ignored.

#### Multiple Charge Points in One Process

`--cp-id` becomes optional in server mode. Additional CPs can be added at
runtime with the browser UI or the `cp.create` Socket.IO RPC method:

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

> **Breaking change (vs. earlier versions):** REST control endpoints, native
> WebSocket event streams, and the Unix-domain control socket have been
> removed. External clients should migrate to the Socket.IO `rpc` event and
> `event` push envelopes. See [docs/migration.md](migration.md).

## Events

Events are emitted in all modes:

- REPL shows formatted text.
- JSON Lines mode emits JSON event lines.
- Daemon mode emits Socket.IO `event` envelopes with `kind: "cp"` or
  `kind: "registry"`.

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

| Option                                             | Required | Default                                 | Description                                                                                                                                                                                                                               |
| -------------------------------------------------- | -------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--cp-id <id>`                                     | Yes\*    | -                                       | Charge Point ID                                                                                                                                                                                                                           |
| `--ws-url <url>`                                   | Yes\*\*  | -                                       | WebSocket URL of CSMS                                                                                                                                                                                                                     |
| `--connectors <n>`                                 | No       | `1`                                     | Number of connectors                                                                                                                                                                                                                      |
| `--ocpp-version <OCPP-1.6J\|OCPP-2.0.1\|OCPP-2.1>` | No       | `OCPP-1.6J`                             | OCPP version for a directly started or bootstrapped CP                                                                                                                                                                                    |
| `--json`                                           | No       | -                                       | JSON Lines mode                                                                                                                                                                                                                           |
| `--daemon`                                         | No       | -                                       | Server daemon. With no `--http-port`, listens on `http://127.0.0.1:9700`.                                                                                                                                                                 |
| `--http-port <port>`                               | No       | `9700` with bare `--daemon`             | Enable the TCP health / Socket.IO server on this port                                                                                                                                                                                     |
| `--http-host <addr>`                               | No       | `127.0.0.1`                             | Bind address for HTTP. Non-loopback binds require web-console Basic Auth or `--unsafe-remote`.                                                                                                                                            |
| `--unsafe-remote`                                  | No       | -                                       | Allow a non-loopback daemon bind without `--web-console-basic-auth-user/pass`. Use only on trusted networks.                                                                                                                              |
| `--unix-socket <path\|none>`                       | No       | deprecated no-op                        | Accepted for launcher compatibility, prints one warning, and is ignored.                                                                                                                                                                  |
| `--web-console [<port>]`                           | No       | -                                       | Serve the bundled browser UI alongside Socket.IO. Without a port, shares `--http-port`; with a port, serves on that listener. Requires built `dist/` or a release package that ships it.                                                  |
| `--web-console-basic-auth-user <u>`                | No       | -                                       | Basic Auth user for incoming static assets and Socket.IO handshake auth. Pair with `--web-console-basic-auth-pass`. The configured health path is exempt.                                                                                 |
| `--web-console-basic-auth-pass <p>`                | No       | -                                       | Basic Auth password for incoming static assets and Socket.IO handshake auth. Pair with `--web-console-basic-auth-user`.                                                                                                                   |
| `--http-url <url>`                                 | No       | `http://127.0.0.1:9700` in client modes | Client target: TCP HTTP base URL for Socket.IO                                                                                                                                                                                            |
| `--send <json>`                                    | No       | -                                       | Send a CP-scoped JSON command to a running server                                                                                                                                                                                         |
| `--events`                                         | No       | -                                       | Subscribe to daemon events over Socket.IO                                                                                                                                                                                                 |
| `--all`                                            | No       | -                                       | With `--events`, subscribe to all CP and registry events                                                                                                                                                                                  |
| `--stop`                                           | No       | -                                       | Shut down the running server with `server.shutdown`                                                                                                                                                                                       |
| `--http-basic-auth-user <u>`                       | No       | -                                       | Basic Auth user the client modes (`--send`/`--stop`/`--events`) send as Socket.IO handshake auth to a daemon protected by `--web-console-basic-auth-*`                                                                                    |
| `--http-basic-auth-pass <p>`                       | No       | -                                       | Basic Auth password for the client modes (pair with `--http-basic-auth-user`)                                                                                                                                                             |
| `--basic-auth-user <u>`                            | No       | -                                       | Basic auth username for outgoing CP → CSMS WebSocket                                                                                                                                                                                      |
| `--basic-auth-pass <p>`                            | No       | -                                       | Basic auth password for outgoing CP → CSMS WebSocket                                                                                                                                                                                      |
| `--header KEY:VALUE`                               | No       | -                                       | Extra header for the outgoing CP → CSMS WebSocket upgrade. Repeatable.                                                                                                                                                                    |
| `--ws-subprotocol <value>`                         | No       | -                                       | Extra subprotocol for the outgoing CP → CSMS WebSocket upgrade. Repeatable.                                                                                                                                                               |
| `--vendor <vendor>`                                | No       | `CLI-Vendor`                            | Charge point vendor                                                                                                                                                                                                                       |
| `--model <model>`                                  | No       | `CLI-Model`                             | Charge point model                                                                                                                                                                                                                        |
| `--scenario <file>`                                | No       | -                                       | Startup scenario JSON file (server mode)                                                                                                                                                                                                  |
| `--scenario-template <id>`                         | No       | -                                       | Built-in scenario template id (server mode)                                                                                                                                                                                               |
| `--scenario-template-file <p>`                     | No       | -                                       | Path to a cpId-independent template JSON                                                                                                                                                                                                  |
| `--scenario-connector <list>`                      | No       | `1`                                     | `all`, single id (`1`), or list (`1,2,3`)                                                                                                                                                                                                 |
| `--state-db <path>`                                | No       | _(in-memory)_                           | Persist scenarios, ChangeConfiguration overrides, charging profile state, availability flags, pending transaction messages, registered CPs and logs to a SQLite file. See [server.md → State persistence](./server.md#state-persistence). |
| `--log-format <fmt>`                               | No       | `plain`                                 | `plain` writes the legacy `[ts] [LEVEL] [TYPE] message` lines; `json` writes one JSON Lines object per line (same shape as the `logs` table + browser export + `logs.get` RPC). See [server.md → Log format](./server.md#log-format).     |
| `--trace-output <path>`                            | No       | -                                       | Append each OCPP-J (WebSocket) wire message as a JSONL trace record ([docs/trace-format.md](./trace-format.md)) in REPL, JSON, and daemon modes; SOAP transport is not captured yet.                                                      |
| `--health-path <path>`                             | No       | `/v1/healthz`                           | Absolute path for the unauthenticated health-check JSON. The browser UI build must use matching `VITE_HEALTH_PATH` when this changes.                                                                                                     |
| `--cors-origin <origin>`                           | No       | loopback: open; remote: same-origin     | Restrict browser Origins. Repeatable. Pass literal `"*"` to opt into open CORS.                                                                                                                                                           |
| `--trust-forwarded-headers`                        | No       | -                                       | With same-origin CORS, also accept the public origin reported by `X-Forwarded-Proto` / `X-Forwarded-Host`. Use only behind a trusted reverse proxy.                                                                                       |

\* `--cp-id` is **optional** in server mode (no bootstrap CP). Required for
REPL/JSON and for `--send`/`--events` without `--all`.

\*\* `--ws-url` is required for REPL/JSON, and only when bootstrapping a CP in
server mode. CPs created later via Socket.IO `cp.create` supply their own
`wsUrl` in the RPC params.
