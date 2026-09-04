---
title: Socket.IO control plane
type: concept
summary: The one wire contract every client of the daemon uses — `rpc` acks for commands (CP-scoped and daemon-level methods), `event` push envelopes with room-scoped subscriptions, closed error codes, zod-validated schemas.
sources:
  - src/protocol/
  - src/cli/server/
  - scripts/poc/README.md
related:
  - ../entities/daemon.md
  - ../entities/cli.md
  - ../entities/mcp-endpoint.md
  - network-simulation.md
  - log-format.md
  - state-persistence.md
  - ../analyses/rest-to-socketio-migration.md
  - ../analyses/fleet-load-and-observability-roadmap.md
updated: 2026-09-04
---

# Socket.IO control plane

Clients connect to the [daemon](../entities/daemon.md)'s HTTP origin with
Socket.IO path `/socket.io/`. Browser Remote mode, the bundled CLI client,
the [MCP endpoint](../entities/mcp-endpoint.md) (internally) and external
agents all use the same contract. The feasibility of this design on
`Bun.serve` was gated by the [socket.io-on-Bun PoC](../sources/socketio-bun-poc.md).

## RPC

All request/response control calls use the `rpc` event:

```js
socket.emit("rpc", { cpId, method, params }, (ack) => {
  // ack is { ok: true, result } or
  //        { ok: false, error: { code, message } }
});
```

`cpId` is required for CP commands and omitted for daemon-level methods. CP
command method names are the JSON-mode command IDs verbatim (see
[CLI → JSON Lines mode](../entities/cli.md#2-json-lines-mode)); the server
routes them through the same command handler used by `--json`.

Error codes are closed over:
`not_found`, `invalid_params`, `internal`, `connect_failed`, `unauthorized`,
`timeout`, and `disconnected`.

| Code             | Means                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not_found`      | The registry has no such charge point, or the method does not exist. A statement about the registry, never about the envelope.                                                           |
| `invalid_params` | The call was malformed. A CP-scoped method called without a `cpId` answers this and says so — including when the `cpId` was placed inside `params`, which is where `cp.create` wants it. |
| `connect_failed` | The CSMS refused or dropped the connection (#286). The message carries the close code and reason; the daemon is fine and its reconnect loop is already running.                          |
| `internal`       | The daemon itself failed. If you see this for a connection problem, it is a bug.                                                                                                         |
| `unauthorized`   | The web-console Basic Auth gate rejected the caller ([Access control](access-control.md)).                                                                                               |
| `timeout`        | The 30 s deadline elapsed. The server returns it when a handler exceeds the deadline (`withRpcDeadline`), and the Socket.IO client also synthesises it when no ack arrives at all.       |
| `disconnected`   | The socket dropped before the ack — client-synthesised.                                                                                                                                  |

The protocol schemas live in `src/protocol/` and are validated with `zod`.
Runtime packages for this control plane are `socket.io`,
`@socket.io/bun-engine`, `socket.io-client`, and `zod`.

Rate limiting: a token bucket (100 calls/s refill, 64 in-flight) and a
30-second per-call deadline apply to every RPC (the MCP endpoint has its own
bucket with the same numbers).

### CP command methods

| Method                            | Params                                                                                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect`                         | `{}`                                                                                       | Connect to the CSMS. **Resolves when the socket opens and rejects on the first close**, with `connect_failed` carrying the close code and reason. It is not fire-and-forget, and it is not the whole story either: after a rejection the reconnect loop keeps trying, so a caller that cares about eventual success watches the `connected` event rather than re-calling. A refused upgrade also logs the HTTP status the CSMS answered with ([Security profiles](security-profiles.md), #288). |
| `disconnect`                      | `{}`                                                                                       | Disconnect from the CSMS.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `status`                          | `{}`                                                                                       | Returns the redacted CP status snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `reset`                           | `{}`                                                                                       | Reset the simulated CP the way an inbound `Reset` does: drain and drop the WebSocket, clear per-connection state (response overrides, timers, outbox), then reconnect; SOAP CPs fall back to disconnect + connect.                                                                                                                                                                                                                                                                              |
| `heartbeat`                       | `{}`                                                                                       | Send one Heartbeat.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `start_heartbeat`                 | `{ "interval": number }`                                                                   | Start periodic Heartbeat in seconds.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `stop_heartbeat`                  | `{}`                                                                                       | Stop periodic Heartbeat.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `start_transaction`               | `{ "connector": number, "tagId"?: string }`                                                | `connector` must be `>= 1`. `tagId` is optional since #299 — omitted, the charge point draws from its [idTag pool](#idtag-pool).                                                                                                                                                                                                                                                                                                                                                                |
| `stop_transaction`                | `{ "connector": number }`                                                                  | `connector` must be `>= 1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `authorize`                       | `{ "tagId"?: string }`                                                                     | Send Authorize. `tagId` is optional since #299 — see [idTag pool](#idtag-pool).                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `diagnostics_status_notification` | `{ "status": string }`                                                                     | Send DiagnosticsStatusNotification.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `firmware_status_notification`    | `{ "status": string }`                                                                     | Send FirmwareStatusNotification.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `update_connector_status`         | `{ "connector": number, "status": string }`                                                | Only this connector-taking method accepts connector `0`.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `set_meter_value`                 | `{ "connector": number, "value": number }`                                                 | `value` is Wh and must be a non-negative integer.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `send_meter_value`                | `{ "connector": number }`                                                                  | Send current meter value to the CSMS.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `remove_connector`                | `{ "connector": number }`                                                                  | Remove a connector from the simulated CP.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `set_ev_settings`                 | `{ "connector": number, "settings": object }`                                              | Store EV settings for a connector.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `get_ev_settings`                 | `{ "connector": number }`                                                                  | Return EV settings for a connector.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `set_auto_meter_config`           | `{ "connector": number, "config": object }`                                                | Configure automatic meter values.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `get_auto_meter_config`           | `{ "connector": number }`                                                                  | Return automatic meter-value config.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `set_auto_traffic_config`         | `{ "connector": number, "config": object }`                                                | Configure seeded background traffic — see [Background traffic](#background-traffic).                                                                                                                                                                                                                                                                                                                                                                                                            |
| `get_auto_traffic_config`         | `{ "connector": number }`                                                                  | Return the background-traffic config.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `set_auto_reset_to_available`     | `{ "connector": number, "enabled": boolean }`                                              | Toggle auto-reset to Available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `set_mode`                        | `{ "connector": number, "mode": string }`                                                  | Set connector mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `set_soc`                         | `{ "connector": number, "soc": number \| null }`                                           | Set or clear SoC.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `set_soc_meter_sync`              | `{ "connector": number, "enabled": boolean }`                                              | Toggle SoC-to-meter synchronization.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `get_charging_profiles`           | `{ "connector": number }`                                                                  | Return active charging profiles.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `get_state_history`               | `{ "options"?: object }`                                                                   | Return state history for the CP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `security_event_notification`     | `{ "type": string, "techInfo"?: string }`                                                  | Send SecurityEventNotification ([Security profiles](security-profiles.md)).                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `sign_certificate`                | `{ "csr"?: string }`                                                                       | Send SignCertificate ([Security profiles](security-profiles.md)).                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `list_scenario_templates`         | `{}`                                                                                       | List built-in [scenario templates](../entities/scenario-templates.md).                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `load_scenario_template`          | `{ "connector": number, "templateId": string, "evSettings"?: object }`                     | Load a built-in template.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `load_scenario`                   | `{ "connector": number, "file"?: string, "scenario"?: object }`                            | Load a scenario from a file path or inline definition. An inline definition missing `id`, `name`, `targetType`, `nodes` or `edges` is rejected with `invalid_params`.                                                                                                                                                                                                                                                                                                                           |
| `list_scenarios`                  | `{ "connector": number }`                                                                  | List loaded scenarios: `{ scenarioId, name, active, state, mode }`. `state` / `mode` mirror `scenario_status` and are `null` for a scenario that has never run.                                                                                                                                                                                                                                                                                                                                 |
| `run_scenario`                    | `{ "connector": number, "scenarioId": string, "strict"?: boolean }`                        | Run a loaded scenario. `strict` promotes warning-severity assertions to failures ([Scenario format → Severity](scenario-format.md#severity-conformance-vs-compatibility)).                                                                                                                                                                                                                                                                                                                      |
| `run_scenario_file`               | `{ "connector": number, "file": string, "strict"?: boolean }`                              | Load a scenario file and run it **with the options given**. The connector's auto-start gate is suppressed for this load, so `strict` always reaches the run this call starts; an id that was already running before the call is an error, never a silent success (#314).                                                                                                                                                                                                                        |
| `run_scenario_template`           | `{ "connector": number, "templateId": string, "evSettings"?: object, "strict"?: boolean }` | Load and run a built-in template.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `scenario_status`                 | `{ "connector": number, "scenarioId": string }`                                            | Return scenario execution status: the live context while a run is in flight, otherwise the **terminal** state (`completed` / `error`) and `runId` of the last run, until the scenario is removed. `null` only for a scenarioId with no run on record — which is how a poller tells "unknown scenario" from "already finished".                                                                                                                                                                  |
| `scenario_report`                 | `{ "connector": number, "scenarioId": string, "runId"?: string, "format"?: "json" }`       | Machine-readable verdict of a finished run (`verdict`, `conformanceVerdict`, `compatibilityVerdict`, `assertions[]` with `frameRefs`, `transcript`, `simulatorVersion`). Used by the [Testcontainers harness](../sources/testcontainers-java-readme.md).                                                                                                                                                                                                                                        |
| `get_scenario`                    | `{ "connector": number, "scenarioId": string }`                                            | Return a loaded scenario definition.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `stop_scenario`                   | `{ "connector": number, "scenarioId": string }`                                            | Stop one scenario.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `step_scenario`                   | `{ "connector": number, "scenarioId": string, "force"?: boolean }`                         | Step a scenario.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `scenario_reset`                  | `{ "connector": number, "scenarioId": string }`                                            | Stop the scenario, return the connector to `Available` (emitting the StatusNotification so a CSMS stays in sync) and drop the persisted scenario position.                                                                                                                                                                                                                                                                                                                                      |
| `stop_all_scenarios`              | `{ "connector": number }`                                                                  | Stop every scenario on a connector.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `remove_scenario`                 | `{ "connector": number, "scenarioId": string }`                                            | Remove a loaded scenario.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

> Scenario definitions (the `scenario` param above, and the file read by
> `load_scenario`'s `file` param / `run_scenario_file`) follow
> [Scenario format](scenario-format.md) and its published
> [JSON Schema](../../schema/scenario.schema.json). Validation against that
> schema is advisory — a mismatch is logged, not rejected — with one exception:
> the fields the schema marks `required` (`id`, `name`, `targetType`, `nodes`,
> `edges`) are a hard gate, because the runtime keys on them. Without `id` a
> definition used to load "successfully" and then be neither runnable nor
> removable.

> The exact zod schema of every method is retrievable at runtime through the MCP `list_methods`
> tool ([MCP endpoint](../entities/mcp-endpoint.md#generic-escape-hatch)) or
> by reading `src/protocol/`.

#### `cp.create` parameters

The full set, shared by `cp.create` and `cp.update`, by `cp.create_many` (which
drops `cpId` and adds the batch fields), and — since #284 — by the MCP
`cp_create` / `cp_create_many` tools, which derive their input schemas from this
one rather than restating a subset.

| Field                                             | Type                             | Notes                                                                                                                                                            |
| ------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cpId`                                            | string, **required**             | Charge point identifier.                                                                                                                                         |
| `idTagPool`                                       | object                           | Tags this CP draws from when a call names none — see [idTag pool](#idtag-pool).                                                                                  |
| `wsUrl`                                           | string \| string[], **required** | CSMS endpoint. `ws(s)://` for OCPP-J, `http(s)://` for the SOAP versions. OCPP-J may pass several — see [Multiple supervision URLs](#multiple-supervision-urls). |
| `urlDistribution`                                 | string                           | `round-robin` (default), `random`, `cp-affinity`. Only meaningful with several URLs.                                                                             |
| `ocppVersion`                                     | string                           | `OCPP-1.6J` (default), `OCPP-2.0.1`, `OCPP-2.1`, `OCPP-1.2`, `OCPP-1.5`, `OCPP-1.6S`.                                                                            |
| `connectors`, `vendor`, `model`                   | number, string, string           | Connector count and BootNotification identity.                                                                                                                   |
| `basicAuth`                                       | `{ username, password }`         | Legacy Basic Auth. Prefer `securityProfile` + `authorizationKey` for OCPP 1.6.                                                                                   |
| `bootNotification`                                | object                           | Overrides for the BootNotification payload.                                                                                                                      |
| `centralSystemUrl`, `soapPath`, `soapCallbackUrl` | string                           | SOAP only. See [OCPP versions & transports](ocpp-versions-and-transports.md).                                                                                    |
| `securityProfile`, `authorizationKey`, `cpoName`  | `0`–`3`, string, string          | OCPP 1.6 security profiles. See [Security profiles](security-profiles.md).                                                                                       |
| `tlsCaPath`, `tlsCertPath`, `tlsKeyPath`          | string                           | Paths to PEM material. `tlsCaPath` **replaces** the system trust store.                                                                                          |
| `tls`                                             | object                           | The same material inline: `ca`, `cert`, `key`, `rejectUnauthorized`, `serverName`.                                                                               |
| `autoConnect`                                     | boolean                          | Connect immediately after the call.                                                                                                                              |

Unknown properties are stripped, not rejected — so a misspelled field is
accepted and ignored rather than reported.

##### idTag pool

Every place an idTag was needed took a literal. That is fine for one scripted
run and wrong for anything with more than one session: a fleet where every
charge point presents the same tag is not exercising the CSMS's authorization
cache, its local auth list, or its per-tag concurrency rules.

`idTagPool` gives a charge point tags to draw from when a call names none:

```jsonc
"idTagPool": { "tags": ["RFID-001", "RFID-002"], "distribution": "connector-affinity" }
"idTagPool": { "file": "./tags.json" }   // a JSON array of strings
```

Exactly one of `tags` or `file` — naming both, or neither, is refused.

| `distribution`       | Behaviour                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `round-robin`        | Default. The next tag per draw, across the whole charge point.                            |
| `random`             | Drawn from a stream seeded by the `cpId`, so a run replays and a fleet does not lockstep. |
| `connector-affinity` | A connector always presents the same tag — the captive-fleet model, and assertable.       |

**An explicit `tagId` always wins.** The pool only fills a gap, so
`start_transaction` and `authorize` take `tagId` as optional now, and a scenario
transaction node without one draws from the pool. A charge point with no pool
keeps the historical `123456` fallback, so nothing changes for a caller that
never configured one.

**`file` is resolved at creation.** What the charge point stores and persists is
the list itself, so a bad path fails the create rather than the first
transaction. A relative path is resolved against the daemon's working directory
at that moment and stored **absolute**, so a restart from another directory
still names the same file. By default a file edited later does not change a
running charge point; a daemon started with
[`--watch`](../entities/daemon.md#file-hot-reload) (#314) re-reads it and
replaces the pool live, which is safe because the pool is drawn from once per
session. The pool holds at most 1000 tags and is persisted in
`charge_points.id_tags` / `id_tag_distribution` (schema v9) plus the source path
in `id_tag_file` (schema v11), so a restart does not bring the charge point back
drawing nothing — or, under `--watch`, watching nothing.

An unrecognised `distribution` is refused rather than defaulted.

##### Background traffic

"Run plausible charging traffic against this CSMS for an hour" was
unexpressible. [Scenarios](scenario-format.md) are deterministic node graphs
that terminate in a verdict — exactly what makes them good for conformance and
bad for open-ended load — so a non-terminating random construct does not belong
inside them.

Background traffic is instead a **per-connector runtime behaviour**, modelled
on auto-meter: set by RPC, stored beside it, and independent of whether a
scenario is loaded.

| Method                                 | Params                          |
| -------------------------------------- | ------------------------------- |
| `connector_settings.auto_traffic.get`  | `{ cpId, connectorId }`         |
| `connector_settings.auto_traffic.save` | `{ cpId, connectorId, config }` |
| `set_auto_traffic_config` (CP command) | `{ connector, config }`         |
| `get_auto_traffic_config` (CP command) | `{ connector }`                 |

```jsonc
{
  "enabled": true,
  "seed": 42,
  "minDurationSec": 60,
  "maxDurationSec": 300,
  "minGapSec": 30,
  "maxGapSec": 120,
  "probabilityOfStart": 0.8,
  "requireAuthorize": true,
  "stopAfterSec": 3600,
}
```

The loop is: wait a drawn gap, roll `probabilityOfStart`, optionally Authorize,
start a session, wait a drawn duration, stop, repeat.

**Seeded, and that is the point.** Every draw comes from the same PRNG
[network simulation](network-simulation.md) uses, keyed on
`seed:cpId:connectorId` so two connectors — and two charge points — do not step
in lockstep. A CI failure that only shows up under an hour of background load
is worthless if it cannot be replayed.

The seed fixes the **draws, not the clock**: the timer path is `setTimeout` and
`Date.now()`, so wall-clock timestamps still vary between runs. Assert on the
drawn values, or on observed times within a stated tolerance — never on exact
timestamps. The duration is drawn before the probability roll, so the sequence
a seed produces does not depend on which attempts happened to fire.

**A scenario taking control suspends it.** While any scenario is running the
attempt is _skipped_, not queued: queuing would burst the moment the scenario
ended, which is the interference the rule exists to prevent. A run's verdict
must never depend on whether background traffic fired.

Per-connector counters — attempted, started, skipped, rejected, completed — are
the assertion surface for a load run. A refused Authorize or a failed start is
counted and the loop continues; surviving those is what a load run is for.

Config is persisted in `connector_settings.auto_traffic` (schema v10), and every
runner's timers are stopped when the charge point is deleted.

##### Multiple supervision URLs

`wsUrl` accepts a list so a charge point can survive one CSMS node going away.
The list stays in the charge point's config and **one URL is resolved per
connection attempt**, so `cp.list`, the persisted `charge_points.ws_url` and
every log line keep reporting a single string — the one currently in play.

| `urlDistribution` | Behaviour                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| `round-robin`     | Default. Moves to the next URL on every connection attempt, so a dead node drains after one attempt.        |
| `random`          | Draws per attempt from a stream seeded by the `cpId`, so a run replays.                                     |
| `cp-affinity`     | Hashes the `cpId` to a **primary** and stays on it. Deterministic — a test can assert which node saw a run. |

`cp-affinity` is **sticky, with a failover threshold**, because the two obvious
readings of "affinity" contradict each other once the primary is down: always
return the primary and never connect, or rotate like round-robin and lose the
determinism that is the point. So: the primary is retried while consecutive
failures are below the threshold (3); on reaching it the pool advances one URL;
and **any successful connection resets it to the primary**, so the next
disconnect episode starts from the assigned node again. Only a close the charge
point did not ask for counts as a failure: a `disconnect`, a `reset`, and an
injected [network-simulation](network-simulation.md) disconnect all say nothing
about the node and must not push a charge point off its primary.

**Every URL in the list is validated at creation**, not just the first. A later
entry is only reached on reconnect, where the URL is parsed synchronously
inside a timer callback — a malformed one would throw there, uncaught, and take
the daemon down instead of failing over to the next node.

An unrecognised `urlDistribution` is **refused**, not defaulted — a typo that
silently produced round-robin when affinity was asked for would take away the
determinism affinity exists to provide.

A list is an **OCPP-J** feature. The SOAP versions post to the Central System
service and are called back on one advertised address, with no reconnect loop
to rotate, so `cp.create` refuses a list for them rather than accepting one and
ignoring it.

The list and the policy are **persisted** (`charge_points.supervision_urls` /
`url_distribution`, schema v7) and restored with the charge point. They are the
failover configuration: a restart that brought the charge point back on
`ws_url` alone would silently disable the one thing the list exists to provide.
See [State persistence](state-persistence.md).

##### Blueprints

A **blueprint** is a named, reusable _hardware_ description — what a charge
point is — where a [scenario](scenario-format.md) is the _behaviour_ half: what
it does. They compose, and neither knows about the other.

| Method             | Params          | Returns                     |
| ------------------ | --------------- | --------------------------- |
| `blueprint.list`   | `{}`            | Built-ins, then stored ones |
| `blueprint.save`   | `{ blueprint }` | `{ id }`                    |
| `blueprint.delete` | `{ id }`        | `{ ok: true }`              |

A blueprint carries an `id`, a `name`, an optional `description`, the
`cp.create` parameter block (minus `cpId`, which is generated), optional
default `evSettings`, and an optional `scenarioTemplateId`.

**`wsUrl` is optional on a blueprint and required at instantiation.** A
blueprint describes hardware; the CSMS a fleet points at is a property of the
run, which is why the built-in profiles carry no URL at all. The merged result
is validated against `cp.create_many`'s own schema, so a blueprint without a
URL still cannot produce a charge point without one.

Instantiate with `cp.create_many { blueprintId, count }`; `idPattern` is
optional here and defaults to `<blueprintId>-{n:03}`. Any
parameter given alongside `blueprintId` **overrides** the blueprint's, so a
fleet can share hardware and differ in one field. A `blueprintId` that names
nothing is `not_found` before anything is created.

A blueprint is more than its `cp.create` block: `evSettings` are applied to
**every** connector of each created charge point, and `scenarioTemplateId` is
loaded onto each. A charge point whose defaults could not be applied is
reported in `failed` rather than left half-configured in `created` — a station
that came up with generic EV settings while the caller asked for a 150 kW
profile is the kind of wrong that only shows up in the meter readings.

Five read-only built-ins ship with the daemon (`ac-22kw`, `ac-22kw-x2`,
`dc-50kw`, `dc-150kw`, `dc-350kw`) — the authoritative mapping is
[`src/utils/blueprints/README.md`](../../src/utils/blueprints/README.md).
Saving or deleting a built-in id is refused:
`blueprint.delete` cannot restore one, so an accidental overwrite would be
permanent for that daemon.

At most 995 blueprints can be stored. `blueprint.list` returns the built-ins
and the stored ones under one result cap, so an unbounded store would make the
call fail validation for everyone rather than refuse the one save that crossed
the line. A stored row that no longer matches the schema is skipped rather than
returned, for the same reason.

A charge point whose blueprint defaults could not be applied is **rolled
back**, not left in `cp.list`: it is already registered and persisted by then,
so reporting it in `failed` and leaving it behind would put a half-configured
station in the registry and make the obvious retry fail with an already-exists
error.

Blueprints are stored in `charge_points`' sibling table `blueprints`
(schema v8) when `--state-db` is given, and **in memory otherwise** — the
daemon's default is no database, and a save that answered success while storing
nothing would be worse than either.

##### `cp.create_many` — the batch fields

`cp.create_many` takes the table above **without `cpId`** (ids are generated),
plus:

| Field        | Type                 | Notes                                                                                                                                                                                                               |
| ------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `count`      | number, **required** | How many to create. `1`–`200` (`CP_CREATE_MANY_MAX`), enforced by the schema.                                                                                                                                       |
| `idPattern`  | string               | Id template. `{n}` is the index, `{n:03}` zero-pads it — `CP{n:03}` → `CP001`, … **Required, unless `blueprintId` is given** — a blueprint batch defaults it to `<blueprintId>-{n:03}` ([Blueprints](#blueprints)). |
| `startIndex` | number               | First index substituted (default `1`).                                                                                                                                                                              |

Two guarantees worth relying on:

- **Partial success is the result, not an error.** One id that collides with an
  existing CP, or a CSMS only some of them can reach, does not roll back the
  rest. The ack is `{ created: string[], failed: { cpId, reason }[] }` and is
  `ok: true` even when `failed` is non-empty; the call itself fails only when
  the parameters are unusable. A `reason` falls back to the error code when the
  daemon blanks the message (an "already exists" message could carry a CSMS
  URL).
- **Creation is sequential**, so `registry` events arrive in id order.

The `count` ceiling is enforced rather than merely documented: this is the one
control-plane method that allocates unbounded resources from a single request.
The `{n:0W}` width is capped at two digits for the same reason, and — because a
pattern may repeat the placeholder, so the width cap alone bounds nothing — each
**expanded id** is capped at 256 characters. Every id and callback route in the
batch is checked before the first charge point is created, so a bad pattern is
refused outright rather than leaving a partial fleet behind.

**SOAP batches need a placeholder in the callback URL too.** The daemon routes
inbound CS→CP calls on `<soapPath>/<cpId>/ChargePointService` and advertises
`soapCallbackUrl` verbatim, so one address shared across a batch would send
every station's callbacks to the first station's route — while every create
reported success. `cp.create_many` therefore parses each **expanded** `soapCallbackUrl` with the
router's own pattern and requires the charge point segment to equal the
generated id. A placeholder alone is not enough: `SOAP{n}` against ids
generated as `SOAP{n:03}` registers `SOAP001` while advertising a route for
`SOAP1`, and every inbound call 404s while all the creates report success.
Matching the way the router does — rather than by substring — also accepts a
percent-encoded id such as `/SITE%20A-1/` and rejects an extra path segment
that would 404. Expanded URLs are capped at 2048 characters. The CLI applies
the same rule to `--soap-callback-url`.

A `failed[].reason` is truncated to 2000 characters. An error message that
repeated a long input would otherwise push the batch's ack past the result
schema and turn the promised per-item report into an opaque `internal` — after
every charge point had already been created.

### Daemon methods

| Method                                                         | Params                                                                               | Result / purpose                                                                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cp.list`                                                      | `{}`                                                                                 | Array of redacted CP registry items.                                                                                                                                                         |
| `cp.create`                                                    | See [cp.create parameters](#cpcreate-parameters) below                               | Create a CP; `autoConnect: true` connects it after creation.                                                                                                                                 |
| `cp.create_many`                                               | See [cp.create_many](#cpcreate_many--the-batch-fields) below                         | Create N CPs sharing every parameter but the generated id. Partial success is a normal result.                                                                                               |
| `blueprint.list` / `.save` / `.delete`                         | See [Blueprints](#blueprints) below                                                  | Named, reusable CP hardware descriptions; instantiate with `cp.create_many { blueprintId }`.                                                                                                 |
| `cp.update`                                                    | Same as `cp.create`                                                                  | Replace an existing CP config; `autoConnect: true` reconnects it after update.                                                                                                               |
| `cp.delete`                                                    | `{ "cpId": string }`                                                                 | Remove a CP from the registry.                                                                                                                                                               |
| `logs.get`                                                     | `{ "cpId": string, "limit"?: number, "offset"?: number, "order"?: "asc" \| "desc" }` | Return persisted logs, or the in-memory log buffer when no state DB is configured. `limit` takes the **most recent** N; see [Log format → Log windowing](log-format.md#log-windowing).       |
| `logs.clear`                                                   | `{ "cpId": string }`                                                                 | Delete persisted logs for the CP.                                                                                                                                                            |
| `state.reset`                                                  | `{}`                                                                                 | Drop in-memory CPs and clear simulator-owned state DB tables while preserving schema ([State persistence → Reset](state-persistence.md#reset)).                                              |
| `server.shutdown`                                              | `{}`                                                                                 | Request daemon shutdown.                                                                                                                                                                     |
| `events.subscribe`                                             | `{ "scope": "*" \| "registry" \| "<cpId>" }`                                         | Join event rooms and return an atomic snapshot.                                                                                                                                              |
| `events.unsubscribe`                                           | `{ "scope": "*" \| "registry" \| "<cpId>" }`                                         | Leave an event room.                                                                                                                                                                         |
| `config.get`                                                   | `{}`                                                                                 | Daemon-wide simulator config (the global settings the web console edits), or `null`.                                                                                                         |
| `config.save`                                                  | `{ "config": object \| null }`                                                       | Replace the daemon-wide simulator config; `null` clears it.                                                                                                                                  |
| `scenario.templates`                                           | `{}`                                                                                 | Built-in template catalogue (`id`, `name`, `description`, `targetType`) — the daemon-level twin of the CP-scoped `list_scenario_templates`; what the MCP `scenario_templates` tool calls.    |
| `scenario.definitions.list` / `.save` / `.replace` / `.delete` | `{ "cpId", "connectorId", … }` plus `definition` / `definitions[]` / `definitionId`  | CRUD over persisted scenario definitions for one connector — the web console's scenario library; `list_scenarios` / `load_scenario` are the run-time view of the same rows.                  |
| `connector_settings.auto_meter.get` / `.save`                  | `{ "cpId", "connectorId" }` (+ `config` on save)                                     | Persisted automatic-meter-value config per connector (`connector_settings` table); `set_auto_meter_config` is the CP-scoped live equivalent.                                                 |
| `connector_settings.auto_traffic.get` / `.save`                | `{ "cpId", "connectorId" }` (+ `config` on save)                                     | Persisted [background-traffic](#background-traffic) config per connector (`connector_settings` table, schema v10); `set_auto_traffic_config` is the CP-scoped live equivalent.               |
| `connector_settings.soc_meter_sync.get` / `.save`              | `{ "cpId", "connectorId" }` (+ `enabled` on save)                                    | Persisted SoC↔meter sync flag per connector.                                                                                                                                                 |
| `ev_settings.apply_default`                                    | `{ "settings": object }`                                                             | Push default EV settings onto every connector of every CP that has no explicit / scenario override (issue #105). Distinct from the per-CP `set_ev_settings`, which always marks an override. |
| `network_sim.*`                                                | see [Network simulation → RPC methods](network-simulation.md#rpc-methods)            | Global / per-CP fault-injection config and manual disconnect trigger.                                                                                                                        |

## Event push and rooms

Server-to-client push uses one Socket.IO event:

```js
socket.on("event", (envelope) => {
  // envelope.kind is "cp", "registry", "config", "scenario-definitions"
  // or "file-reload"
});
```

CP event envelope (the `evt` payloads are the CLI [event list](../entities/cli.md#events)):

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

File-reload event envelope, pushed only by a daemon started with `--watch`
(#314) — see [Daemon → File hot-reload](../entities/daemon.md#file-hot-reload):

```json
{
  "kind": "file-reload",
  "event": "file-reloaded",
  "target": "id-tags",
  "path": "/srv/fleet/tags.json",
  "cpId": "CP001",
  "connectorId": null,
  "scenarioId": null,
  "outcome": "applied",
  "error": null
}
```

`outcome` is the whole contract, and a consumer should branch on it rather than
assume a reload took effect:

| `outcome`  | Meaning                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applied`  | The re-read copy is live.                                                                                                                                                                                                                                                                                                                                                                           |
| `deferred` | The file parsed, but the charge point is mid-session; the new copy is held and installed when that session ends — when the transaction stops, when the in-flight run's cleanup completes, or when a `cp.update` rebuilds the charge point. Never dropped: a `deferred` is always followed by an `applied` or a `rejected` for that path unless the scenario, or its charge point, is removed first. |
| `rejected` | The file could not be read or did not parse. The previous good copy is untouched, and `error` says why.                                                                                                                                                                                                                                                                                             |

`target` is `"id-tags"` or `"scenario"`. `connectorId` and `scenarioId` are
non-null only for `"scenario"`; an idTag reload is charge-point wide.

Subscribe with `events.subscribe`:

```js
const ack = await socket.timeout(30_000).emitWithAck("rpc", {
  method: "events.subscribe",
  params: { scope: "CP001" },
});
```

Scopes:

| Scope                    | Push events received                                                                                  | Subscribe result snapshot                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `"*"`                    | CP events for every CP and all registry changes                                                       | `snapshot.cps` for the registry and `snapshot.perCp` for every CP.                         |
| `"registry"`             | Registry `added`, `removed`, `updated`, and `reset` changes                                           | `snapshot.cps` for the registry and `snapshot.perCp` for every CP.                         |
| `"<cpId>"`               | CP events for that CP                                                                                 | `snapshot.cps` still includes registry entries; `snapshot.perCp` includes the selected CP. |
| `"config"`               | `config-changed` pushes for the shared simulator config                                               | `snapshot.cps` only; `snapshot.perCp` is empty for this scope.                             |
| `"scenario-definitions"` | `scenario-definitions-changed` pushes, including the ones a `--watch` scenario reload produces (#314) | `snapshot.cps` only; `snapshot.perCp` is empty for this scope.                             |
| `"file-reload"`          | `file-reloaded` pushes from a `--watch` daemon (#314)                                                 | `snapshot.cps` only; `snapshot.perCp` is empty for this scope.                             |

The subscribe ack is atomic: the room join and snapshot capture happen together,
so clients can apply the snapshot before processing subsequent `event` pushes.
The ack shape is `{ "subscribed": ["*"], "snapshot": { "cps": [], "perCp": {} } }`.

## Authentication

When the daemon is started with `--web-console-basic-auth-user/pass`, the
Socket.IO handshake must carry the same credentials in `socket.handshake.auth`
(`{ username, password }`). See
[Access control → Authenticating to a protected daemon](access-control.md#authenticating-to-a-protected-daemon).

## End-to-end example (socket.io-client)

```js
// agent.mjs
import { io } from "socket.io-client";

const socket = io("http://127.0.0.1:9700", {
  path: "/socket.io/",
  // Include only when the daemon was started with
  // --web-console-basic-auth-user/pass.
  // auth: { username: "admin", password: "secret" },
});

function connect() {
  return new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
}

function rpc(request) {
  return socket
    .timeout(30_000)
    .emitWithAck("rpc", request)
    .then((ack) => {
      if (!ack.ok) {
        const err = new Error(ack.error.message);
        err.code = ack.error.code;
        throw err;
      }
      return ack.result;
    });
}

socket.on("event", (envelope) => {
  console.log("event", JSON.stringify(envelope));
});

await connect();

console.log(await rpc({ method: "cp.list", params: {} }));

await rpc({
  method: "cp.create",
  params: {
    cpId: "CP001",
    wsUrl: "ws://localhost:9000/ocpp",
    connectors: 1,
    autoConnect: true,
  },
});

const sub = await rpc({
  method: "events.subscribe",
  params: { scope: "CP001" },
});
console.log("snapshot", sub.snapshot);

await rpc({
  cpId: "CP001",
  method: "start_transaction",
  params: { connector: 1, tagId: "TAG001" },
});

await rpc({
  cpId: "CP001",
  method: "set_meter_value",
  params: { connector: 1, value: 1200 },
});

await rpc({
  cpId: "CP001",
  method: "stop_transaction",
  params: { connector: 1 },
});

await rpc({ method: "server.shutdown", params: {} });
socket.disconnect();
```

For a JVM/Testcontainers harness that drives this same control plane (start the
container, `cp.create`, `run_scenario`, assert the machine-readable verdict), see
[`examples/testcontainers-java/`](../sources/testcontainers-java-readme.md) (issue #111).
Prefer not to write a client at all? The bundled CLI's
[client modes](../entities/cli.md#4-client-modes---send----events----stop) and
the [MCP endpoint](../entities/mcp-endpoint.md) cover the common cases.

## Limits & roadmap

- One Socket.IO connection per client; `rpc` ack for commands; `event` push
  for CP and registry updates; TCP only.
- Removed: REST control endpoints, native WebSocket event streams, Unix-domain
  socket control listener ([migration guide](../analyses/rest-to-socketio-migration.md)).
- Future: bearer token auth or mTLS can be added at the HTTP/socket boundary
  without changing CP command method names.
