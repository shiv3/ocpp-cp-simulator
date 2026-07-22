# Features

Everything the simulator can do, with links to the page that documents it. Modes: **B** = browser local mode, **C** = CLI (REPL / JSON-lines), **D** = daemon / server mode. Docker and the Tauri desktop app run the daemon, so **D** covers them.

## Interfaces

| Feature                    | Description                                                     | Modes | Docs                                       |
| -------------------------- | --------------------------------------------------------------- | ----- | ------------------------------------------ |
| Classic web console (`/`)  | Default browser console, also served at `/v2`                   | B, D  | [guides/browser.md](guides/browser.md)     |
| Redesigned console (`/v3`) | Fleet view, per-CP detail, scenario library, global message log | B, D  | [guides/browser.md](guides/browser.md)     |
| Legacy v1 UI (`/v1`)       | Original single-page UI (maintenance only)                      | B, D  | [guides/legacy-v1.md](guides/legacy-v1.md) |
| Tauri desktop app          | Bundles the daemon as a sidecar; macOS / Windows / Linux builds | D     | [guides/browser.md](guides/browser.md)     |
| Interactive REPL           | Terminal prompt with per-CP commands                            | C     | [reference/cli.md](reference/cli.md)       |
| JSON Lines mode (`--json`) | One request/response/event JSON object per line for automation  | C     | [reference/cli.md](reference/cli.md)       |
| Daemon / server mode       | Long-running Socket.IO control plane, multi-CP per process      | D     | [reference/server.md](reference/server.md) |
| Docker image               | Prebuilt daemon + web console on GHCR                           | D     | [guides/docker.md](guides/docker.md)       |

## OCPP versions

| Version    | Transport            | Modes               | Notes                                                                                                     |
| ---------- | -------------------- | ------------------- | --------------------------------------------------------------------------------------------------------- |
| OCPP 1.6J  | WebSocket (JSON)     | B, C, D             | Flagship version; full message set incl. TriggerMessage, charging profiles, local auth list, reservations |
| OCPP 2.0.1 | WebSocket (JSON)     | B, C, D             | Core charging flows, e2e-tested against a real CSMS                                                       |
| OCPP 2.1   | WebSocket (JSON)     | B, C, D             | Same surface as 2.0.1                                                                                     |
| OCPP 1.6S  | SOAP / WS-Addressing | B (send-only), C, D | Full 1.6 message set over SOAP; browser cannot host the callback endpoint                                 |
| OCPP 1.5   | SOAP / WS-Addressing | B (send-only), C, D | See [guides/soap.md](guides/soap.md)                                                                      |
| OCPP 1.2   | SOAP / WS-Addressing | B (send-only), C, D | Narrower surface: no DataTransfer, GetConfiguration, LocalAuthList, or Reservation; 4-value status set    |

Select with `--ocpp-version <OCPP-1.2|OCPP-1.5|OCPP-1.6J|OCPP-1.6S|OCPP-2.0.1|OCPP-2.1>` (CLI) or per charge point in the browser UI.

## OCPP feature areas

| Feature                | Description                                                                                                                                               | Modes   | Docs                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------- |
| Boot / heartbeat       | BootNotification gate, manual + periodic Heartbeat (`heartbeat`, `start_heartbeat`, `stop_heartbeat`)                                                     | B, C, D | [reference/cli.md](reference/cli.md#available-json-commands)            |
| Transactions           | `start_transaction` / `stop_transaction` with auth flow, stop reasons, pending-message queueing                                                           | B, C, D | [reference/cli.md](reference/cli.md#available-json-commands)            |
| Meter values           | Manual + automatic meter values (`set_meter_value`, `send_meter_value`, auto-meter config, charging curves, EV settings with SoC targets, SoC-meter sync) | B, C, D | [reference/cli.md](reference/cli.md#available-json-commands)            |
| Connector status       | `update_connector_status`, status cascades, auto-reset to Available, connector modes, `remove_connector`                                                  | B, C, D | [reference/cli.md](reference/cli.md#available-json-commands)            |
| Authorization          | `authorize`, idTag handling, local auth list (SendLocalList / GetLocalListVersion)                                                                        | B, C, D | [reference/cli.md](reference/cli.md)                                    |
| Reservations           | ReserveNow / CancelReservation handling plus scenario nodes to drive them                                                                                 | B, C, D | [reference/scenario-format.md](reference/scenario-format.md)            |
| Remote control         | RemoteStartTransaction / RemoteStopTransaction, TriggerMessage, ChangeAvailability, Reset, UnlockConnector (with configurable outcomes)                   | B, C, D | [reference/server.md](reference/server.md)                              |
| Charging profiles      | SetChargingProfile / ClearChargingProfile handling, `get_charging_profiles`                                                                               | B, C, D | [reference/cli.md](reference/cli.md#available-json-commands)            |
| Configuration          | GetConfiguration / ChangeConfiguration with persisted overrides, local `configSet` scenario node                                                          | B, C, D | [reference/server.md](reference/server.md#state-persistence)            |
| DataTransfer           | CP-initiated DataTransfer (scenario node + notification command), CSMS-initiated handling                                                                 | B, C, D | [reference/scenario-format.md](reference/scenario-format.md#node-types) |
| Firmware / diagnostics | `firmware_status_notification`, `diagnostics_status_notification`                                                                                         | B, C, D | [reference/cli.md](reference/cli.md#available-json-commands)            |
| Security extension     | SecurityEventNotification, SignCertificate / CertificateSigned, security config keys                                                                      | C, D    | [guides/security-profiles.md](guides/security-profiles.md)              |
| Transport security     | OCPP 1.6 security profiles 1–3 (`--security-profile`, `--authorization-key`, `--tls-ca/-cert/-key`)                                                       | C, D    | [guides/security-profiles.md](guides/security-profiles.md)              |

## Scenario engine

| Feature                 | Description                                                                                                                                                                                                                                                                             | Modes   | Docs                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------- |
| Visual + JSON scenarios | Node/edge graphs authored in the browser editor or as JSON files with a published, versioned JSON Schema                                                                                                                                                                                | B, C, D | [reference/scenario-format.md](reference/scenario-format.md)            |
| Flow nodes              | `start` (connect- or status-triggered), `end`, `delay`                                                                                                                                                                                                                                  | B, C, D | [reference/scenario-format.md](reference/scenario-format.md#node-types) |
| CP action nodes         | `transaction`, `meterValue` (auto-increment, curves, EV-settings stop), `statusChange`, `statusNotification` (errorCode / fault injection), `connectorPlug`, `dataTransfer`, `configSet`, `notification`                                                                                | B, C, D | [reference/scenario-format.md](reference/scenario-format.md#node-types) |
| CSMS-wait trigger nodes | `remoteStartTrigger`, `remoteStopTrigger`, `statusTrigger`, `reservationTrigger`, `csmsCallTrigger` (any action)                                                                                                                                                                        | B, C, D | [reference/scenario-format.md](reference/scenario-format.md#node-types) |
| Pre-arm nodes           | `unlockOutcome` (next UnlockConnector response), `responseOverride` (one-shot canned response for any action)                                                                                                                                                                           | B, C, D | [reference/scenario-format.md](reference/scenario-format.md#node-types) |
| Reservation nodes       | `reserveNow`, `cancelReservation`                                                                                                                                                                                                                                                       | B, C, D | [reference/scenario-format.md](reference/scenario-format.md#node-types) |
| Assertions              | 10 declarative check types (`ocpp_sent`, `ocpp_received`, `ocpp_absent`, `response_status`, `idtag_info_status`, `payload_match`, `message_order`, `message_after`, `state_transition`, `no_unexpected`) evaluated against the captured wire transcript, with machine-readable verdicts | B, C, D | [reference/scenario-format.md](reference/scenario-format.md#assertions) |
| Built-in templates      | Ready-made templates incl. certification-style scenarios, cloned per connector (`list_scenario_templates`, `run_scenario_template`)                                                                                                                                                     | B, C, D | [reference/cli.md](reference/cli.md#available-json-commands)            |
| Startup scenarios       | Auto-load scenario files at daemon start (`--scenario`, `--scenario-template`, `--scenario-template-file`, `--scenario-connector`)                                                                                                                                                      | C, D    | [reference/cli.md](reference/cli.md#startup-scenarios)                  |
| Run control             | Load / run / step / stop / remove scenarios at runtime, per-run status and reports                                                                                                                                                                                                      | B, C, D | [reference/cli.md](reference/cli.md#available-json-commands)            |
| Example library         | Runnable scenario JSONs incl. assertion-bearing flows                                                                                                                                                                                                                                   | —       | [examples/scenarios/](examples/scenarios/)                              |

## Control & automation

| Feature              | Description                                                                                                                                                                                                                                                | Modes | Docs                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------ |
| Socket.IO RPC        | Typed `rpc` request/ack contract: CP-scoped commands plus daemon methods (`cp.*`, `logs.*`, `config.*`, `scenario.templates`, `scenario.definitions.*`, `connector_settings.*`, `ev_settings.apply_default`, `events.*`, `state.reset`, `server.shutdown`) | D     | [reference/server.md](reference/server.md#socketio-rpc)            |
| Event push + rooms   | `events.subscribe` / `events.unsubscribe` with per-CP and registry scopes, real-time envelopes                                                                                                                                                             | D     | [reference/server.md](reference/server.md#event-push-and-rooms)    |
| MCP endpoint         | `POST /mcp`: 16 curated tools + `list_methods` / `call_method` generic escape hatch                                                                                                                                                                        | D     | [reference/server.md](reference/server.md#mcp-endpoint)            |
| CLI as client        | `--send` a CP command, `--events` / `--all` to stream, `--stop` to shut down; `--http-url` targeting, Basic Auth via `--http-basic-auth-user/-pass`                                                                                                        | C→D   | [reference/cli.md](reference/cli.md#3-daemon--server-mode)         |
| Health endpoint      | `GET /v1/healthz` (path configurable via `--health-path`) for probes and local/remote detection                                                                                                                                                            | D     | [reference/server.md](reference/server.md#health)                  |
| Multi-CP daemon      | `cp.create` / `cp.update` / `cp.delete` / `cp.list` — many charge points in one process                                                                                                                                                                    | D     | [reference/server.md](reference/server.md#daemon-methods)          |
| JVM / Testcontainers | Drive the Docker image from Java integration tests                                                                                                                                                                                                         | D     | [guides/automation.md](guides/automation.md#java--jvm-test-suites) |
| Runnable clients     | Node / Python agents, curl health probe, MCP client config                                                                                                                                                                                                 | D     | [examples/automation/](examples/automation/)                       |

## Analysis & observability

| Feature              | Description                                                                                                                           | Modes | Docs                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------ |
| `analyze` subcommand | DebugKit-powered reports from trace files or a live daemon (`--from-daemon`), Markdown or self-contained HTML, `--split-by connector` | C     | [reference/cli.md](reference/cli.md#analyze)           |
| OCPP trace output    | `--trace-output` appends every OCPP-J wire message as a JSONL record (documented format v1.1)                                         | C, D  | [reference/trace-format.md](reference/trace-format.md) |
| Structured logs      | `--log-format json` — one JSON object per line; plain format for humans                                                               | C, D  | [reference/server.md](reference/server.md#log-format)  |
| Log store + RPC      | Persisted `logs` table with `logs.get` / `logs.clear`                                                                                 | D     | [reference/server.md](reference/server.md#log-format)  |

## Persistence

| Feature             | Description                                                                                                                                      | Modes | Docs                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------------------------------------------------------------ |
| Browser persistence | sql.js + IndexedDB; scenarios, config overrides, profiles, logs survive reload                                                                   | B     | [reference/server.md](reference/server.md#state-persistence) |
| Daemon persistence  | `--state-db <path>` (bun:sqlite); CP registry, scenarios, configuration, charging profiles, availability, pending messages, logs survive restart | D     | [reference/server.md](reference/server.md#state-persistence) |
| State reset         | `state.reset` RPC / browser Reset action                                                                                                         | B, D  | [reference/server.md](reference/server.md#state-persistence) |

## Security & networking

| Feature                | Description                                                                                                                                      | Modes | Docs                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | -------------------------------------------------------------------------------------- |
| CSMS Basic Auth        | `--basic-auth-user/-pass` on the OCPP connection                                                                                                 | C, D  | [reference/cli.md](reference/cli.md#cli-options)                                       |
| Security profiles 1–3  | ws+Basic Auth / wss+CA verification / mutual TLS (`--tls-key` permission checks, `--insecure-tls-key-perms` escape hatch, `--cpo-name` for CSRs) | C, D  | [guides/security-profiles.md](guides/security-profiles.md)                             |
| Control-plane auth     | `--web-console-basic-auth-user/-pass` gates web console assets, Socket.IO, and MCP                                                               | D     | [reference/server.md](reference/server.md#security)                                    |
| CORS policy            | Safe same-origin default beyond loopback; `--cors-origin`, `--trust-forwarded-headers`, `--unsafe-remote` overrides; `--http-host` binding       | D     | [reference/server.md](reference/server.md#cors)                                        |
| Reverse proxy          | Traefik / nginx / Caddy patterns with an nginx + Authelia SSO example                                                                            | D     | [reference/server.md](reference/server.md#behind-a-reverse-proxy-traefik-nginx-caddy-) |
| SOAP callback endpoint | `--soap-path`, `--soap-callback-url`, `--soap-public-base-url` for CSMS→CP SOAP calls                                                            | C, D  | [guides/soap.md](guides/soap.md)                                                       |

Deprecated / compatibility-only: `--unix-socket` (accepted, warns, ignored — the control plane is TCP Socket.IO only; see [guides/migration.md](guides/migration.md)).
