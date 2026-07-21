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
`ScenarioDefinition` (the format the browser Scenario Editor exports — see
[docs/scenario-format.md](scenario-format.md) for the field reference and
published [JSON Schema](../schema/scenario.schema.json)), then clones it per
connector — rewriting `targetType`, `targetId`, `id`, and `name` — so each
connector runs an independent state machine from the same file. `--scenario`
and `--scenario-template` fan out the same way when `--scenario-connector`
resolves to more than one id. Both `--scenario` and `--scenario-template-file`
validate the file against that schema at load time and warn (never reject)
on a mismatch.

> **Breaking change (vs. earlier versions):** REST control endpoints, native
> WebSocket event streams, and the Unix-domain control socket have been
> removed. External clients should migrate to the Socket.IO `rpc` event and
> `event` push envelopes. See [docs/migration.md](migration.md).

## analyze

```bash
ocpp-cp-sim analyze <trace.jsonl> [--output <file>] [--format html|markdown]
ocpp-cp-sim analyze --from-daemon --cp-id <id> [--http-url <url>]
                     [--http-basic-auth-user <u> --http-basic-auth-pass <p>]
                     [--output <file>] [--format html|markdown]
```

Runs [OCPP DebugKit](https://github.com/ocpp-debugkit/toolkit)'s
failure-pattern detection over a v1.1 trace
([docs/trace-format.md](./trace-format.md)) and writes a report. Unlike every
mode above, `analyze` never bootstraps a charge point or starts a server. In
its default form it only reads the given file and writes a report; with
`--from-daemon` it instead makes the same kind of short-lived client
connection as `--send`/`--stop`/`--events` to pull the trace from a running
daemon, then closes it — see
[Reading from a running daemon](#reading-from-a-running-daemon---from-daemon)
below.

```bash
# Markdown to stdout (default)
ocpp-cp-sim analyze trace.jsonl

# Self-contained HTML report written to a file
ocpp-cp-sim analyze trace.jsonl --output report.html

# Force a format regardless of the --output extension
ocpp-cp-sim analyze trace.jsonl --output report.txt --format html

# From a running daemon's stored logs, no trace file needed
ocpp-cp-sim analyze --from-daemon --cp-id CP001 --output report.html
```

### Reading from a running daemon (`--from-daemon`)

A trace file only exists if the daemon was started with `--trace-output`.
An operator running a long-lived daemon — in Kubernetes, say — usually
wasn't, and restarting it just to get one loses whatever session is in
flight and starts the trace from empty. `--from-daemon` avoids both: the
daemon already persists every log line it produces and exposes them per
charge point over the `logs.get` RPC
([server.md → Related RPC methods](./server.md#related-rpc-methods)), and
that log line shape (`{timestamp, level, type, message, cpId}`) is exactly
what [`logEntryToTrace.ts`](../src/trace/logEntryToTrace.ts) already adapts
into trace records for `--log-format json` and the browser log-viewer
download (see
[trace-format.md → Producing records](./trace-format.md#producing-records)).
`--from-daemon` is that same adapter run against the live log store, not a
second trace format, and it requires no daemon restart.

- `--cp-id <id>` is required: `logs.get` is scoped to one charge point, the
  same way `--send`/`--events` are scoped by `--cp-id`. `analyze` rejects
  `--from-daemon` with no `--cp-id`, and rejects `--cp-id` /
  `--http-url` / `--http-basic-auth-*` without `--from-daemon` — a daemon
  and a trace file are two different trace sources, and silently preferring
  one over the other would hide which of them a report actually describes,
  so a positional trace file combined with `--from-daemon` is also rejected.
- `--http-url <url>` targets the daemon, same as the other client modes
  (default `http://127.0.0.1:9700`).
- `--http-basic-auth-user <u>` / `--http-basic-auth-pass <p>` authenticate
  against a daemon started with `--web-console-basic-auth-*`, exactly like
  the top-level `--http-basic-auth-*` flags for `--send`/`--stop`/`--events`
  do; the two must be given together, since a half-specified credential is a
  misconfiguration, not a request for anonymous access.
- `analyze --from-daemon` only sees what the log store still holds: with no
  `--state-db`, that's the daemon's bounded in-memory Logger buffer, which
  is lost on restart; with `--state-db`, it's the persisted `logs` table,
  which can itself be trimmed by the `logs.clear` RPC or `state.reset`
  ([server.md → Related RPC methods](./server.md#related-rpc-methods)). A
  session whose log lines have aged out or were cleared is invisible to
  `analyze --from-daemon` the same way it would be to any other consumer of
  `logs.get` — a fresh `--trace-output` file remains the only source
  guaranteed to have everything captured since the process last
  (re)started.
- If the daemon has no stored OCPP wire log lines for that charge point at
  all — e.g. its logs are only scenario/diagnostic chatter, which
  `logEntryToTrace.ts` maps to nothing — `analyze` exits 1 instead of
  producing an empty report:

  ```
  Error: the daemon has no stored OCPP wire logs for charge point CP001 (nothing to analyze)
  ```

  A connection or auth failure while fetching the logs (daemon unreachable,
  wrong `--http-basic-auth-*`, unknown `--cp-id`) is also reported and exits
  1, prefixed `Error: cannot read logs from daemon: `.

### Formats

| Value               | When it's used                                         | Output                                                               |
| ------------------- | ------------------------------------------------------ | -------------------------------------------------------------------- |
| `--format markdown` | Default, unless `--output` ends in `.html`             | Markdown text                                                        |
| `--format html`     | Default when `--output` ends in `.html`; can be forced | A single self-contained HTML file (inline CSS, no external requests) |

### Multi charge-point traces

The DebugKit toolkit's analysis pipeline has no concept of `chargePointId` —
it was built around a single-station 1.6J model. Handing it a trace that
mixes several charge points as-is would silently flatten them into one
station, and two charge points that happen to reuse the same OCPP
`messageId` (routine, since messageIds are only unique per connection) could
have their CALLs/CALLRESULTs cross-correlate, hiding a real failure on one of
them.

`analyze` compensates by splitting the trace by `chargePointId` **before**
handing anything to the toolkit, and analyzing each charge point
independently:

- A trace with exactly one charge point (or only unattributed records)
  produces one report. With `--output <file>`, it is written to exactly that
  path.
- A trace with multiple charge points produces one report per charge point.
  With `--output out.html`, each is written as `out.<chargePointId>.html`
  (the charge point id is inserted before the extension and sanitized for
  the filesystem: anything outside `[A-Za-z0-9._-]` becomes `_`). Records
  with no `chargePointId` at all are grouped together and reported as charge
  point `(no chargePointId)`. If two charge point ids sanitize to the same
  filename (e.g. `CP/A` and `CP_A`), the later one in the trace gets a
  numeric suffix instead of overwriting the first (`out.CP_A.html`,
  `out.CP_A.2.html`, ...), and a note identifying the original charge point
  id and the path used is printed to stderr.
- With no `--output`: by default (no `--format`), all reports are printed to
  stdout as Markdown, each under its own `# Charge point <id>` heading. With
  an explicit `--format html`, each report is instead a self-contained HTML
  document, and since an HTML document has no sensible place for that
  heading, reports are separated by an `<!-- Charge point <id> -->` comment
  marker instead (still one valid concatenated stream to redirect to a
  file). An explicit `--format` always wins over the `--output` extension
  (see [Formats](#formats) above) — this applies with or without
  `--output`.

### Excluded records

The toolkit only understands OCPP 1.6J. Records transported over SOAP
(`transport: "soap"`) and records with a non-1.6 `ocppVersion` (e.g.
`2.0.1`, `2.1`) are excluded before analysis rather than being silently
misread as 1.6J frames — analyzing them would produce meaningless results.
Records with no `ocppVersion` at all are kept (treated as 1.6J, matching the
trace format's own default). Non-zero exclusion counts are printed to
stderr, e.g.:

```
excluded: 2 soap record(s), 1 non-1.6 record(s), 0 unparseable line(s)
```

A line that fails to parse as JSON, or parses to something other than a JSON
object, is counted as an unparseable line and skipped — it never aborts the
run.

### Disclaimer

Failure-pattern detection is not a conformance checker: it recognizes a
fixed catalog of known failure shapes, not the OCPP specification itself.
Every `analyze` run — regardless of format or outcome — prints this sentence
to stderr, appends it as a trailing paragraph to every Markdown report, and
injects it as a `<p>` immediately before `</body>` in every HTML report:

> Failure-pattern detection is not OCPP compliance certification: "no known
> failure detected" does not mean "OCPP compliant".

### Timeline is transaction-focused

The toolkit's session timeline is built around transactions
(`StartTransaction`/`StopTransaction`/`MeterValues`). Events outside a
transaction — `StatusNotification`, some bare `CALLRESULT`s — are folded
into a catch-all "no session" bucket rather than shown against the
transaction they happened alongside. This is the toolkit's own model, not
something `analyze` works around; read the report's timeline as
transaction-focused, not as a complete blow-by-blow of every wire message
(the Event Appendix at the end of each report still lists every event).

### Dependency

`analyze` requires `@ocpp-debugkit/toolkit`, pinned to an exact version
(currently `0.4.0`, no `^` range) in `package.json` — this is a third-party
analysis engine whose detection rules can change behavior between versions,
so upgrades are a deliberate, coordinated change (re-verify the test matrix
in `src/cli/analyze/__tests__/`), not an automatic dependency bump. The
toolkit's `/core` and `/reporter` entry points are loaded via dynamic
`import()` only inside the `analyze` code path, so every other CLI mode is
unaffected if the dependency is ever missing.

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
