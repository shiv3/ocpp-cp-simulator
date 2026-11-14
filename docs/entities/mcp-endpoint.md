---
title: MCP endpoint (`POST /mcp`)
type: entity
summary: Stateless Model Context Protocol endpoint served by the daemon so MCP clients such as Claude Code can drive the simulator; curated tools + network-sim tools + power-loss tools + a generic escape hatch, and the OCPP JSON Schemas as resources.
sources:
  - apps/cli/src/server/mcp/tools.ts
  - apps/cli/src/server/mcp/schemaResources.ts
  - packages/ocpp/src/schemaSources.ts
  - apps/cli/src/server/__tests__/mcpSchemaResources.test.ts
  - packages/ocpp/vendor/ocpp-schemas/NOTICE
  - "issue #613"
  - apps/cli/src/server/__tests__/mcp.test.ts
  - apps/cli/src/server/__tests__/networkSimMcp.bun.test.ts
  - apps/cli/src/server/__tests__/mcpToolSchemaParity.test.ts
related:
  - daemon.md
  - ../concepts/control-plane.md
  - ../concepts/network-simulation.md
  - ../concepts/power-loss.md
  - ../analyses/driving-from-an-ai-agent.md
  - ../concepts/expert-ocpp-calls.md
  - ../concepts/vehicle-profiles.md
  - open-ev-directory.md
  - ../concepts/operational-timeline.md
  - ../concepts/charging-sessions.md
  - ../concepts/local-authorization.md
updated: 2026-11-14
---

# MCP endpoint (`POST /mcp`)

The [daemon](daemon.md) exposes a Model Context Protocol (MCP) endpoint at
`POST /mcp` for AI agents and external clients. The endpoint is stateless,
Streamable HTTP, and serves tools and read-only resources (the OCPP JSON
Schemas, [below](#ocpp-schema-resources)) — no prompts, or server-to-client
event push. It uses the same Basic Auth and CORS gates as the rest of the HTTP
surface ([Access control](../concepts/access-control.md)).

Connect any MCP-compatible client (Claude Code, etc.) with:

```bash
# Default daemon (http://127.0.0.1:9700)
claude mcp add --transport http ocpp-sim http://127.0.0.1:9700/mcp

# With Basic Auth configured
claude mcp add --transport http ocpp-sim http://127.0.0.1:9700/mcp \
  --header "Authorization: Basic $(echo -n 'user:pass' | base64)"
```

## Curated Tools

The endpoint exposes the curated tools listed below, wrapping the daemon's
[RPC methods](../concepts/control-plane.md):

| Tool                          | RPC Method                    | Params                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cp_list`                     | `cp.list`                     | `labels?` — keep only the CPs carrying every pair; schema derived from `cp.list`'s ([Charge-point labels](../concepts/control-plane.md#charge-point-labels))                                                                                                                                                                                                                         |
| `cp_create`                   | `cp.create`                   | Every `cp.create` parameter plus `autoConnect?` — the schema is derived from the method's, so the two cannot drift ([cp.create parameters](../concepts/control-plane.md#cpcreate-parameters))                                                                                                                                                                                        |
| `cp_create_many`              | `cp.create_many`              | Every `cp.create` parameter except `cpId`, plus `count` / `idPattern?` / `startIndex?` / `blueprintId?` — schema derived the same way ([batch fields](../concepts/control-plane.md#cpcreate_many--the-batch-fields))                                                                                                                                                                 |
| `blueprint_list`              | `blueprint.list`              | — (built-ins first, then stored)                                                                                                                                                                                                                                                                                                                                                     |
| `blueprint_save`              | `blueprint.save`              | `blueprint` — schema derived from `blueprintSchema` ([Blueprints](../concepts/control-plane.md#blueprints))                                                                                                                                                                                                                                                                          |
| `fleet_template_list`         | `fleet.template.list`         | — (file templates and stored ones; [Fleet templates](../concepts/fleet-templates.md))                                                                                                                                                                                                                                                                                                |
| `fleet_template_get`          | `fleet.template.get`          | `id`                                                                                                                                                                                                                                                                                                                                                                                 |
| `fleet_template_save`         | `fleet.template.save`         | `template` — schema derived from `fleetTemplateSchema`                                                                                                                                                                                                                                                                                                                               |
| `fleet_template_delete`       | `fleet.template.delete`       | `id`                                                                                                                                                                                                                                                                                                                                                                                 |
| `fleet_create`                | `fleet.create`                | `templateId`, `wsUrl?`, `idPrefix?`, `autoConnect?` — creates every charge point of the template; `created` / `failed` in template order                                                                                                                                                                                                                                             |
| `cp_delete`                   | `cp.delete`                   | `cpId`                                                                                                                                                                                                                                                                                                                                                                               |
| `cp_labels_set`               | `cp.labels.set`               | `cpId`, `labels` — replaces the CP's labels in place, no reconnect; schema derived from the method's (#446)                                                                                                                                                                                                                                                                          |
| `cp_behaviors_set`            | `cp.behaviors.set`            | `cpId`, `behaviors` (ids, `[]` or `null`) — choose which loaded behaviors the CP runs, in place; ids only, never code; an unknown id names the loaded ids                                                                                                                                                                                                                            |
| `behavior_list`               | `behavior.list`               | — (the library `--behavior` loaded, whether `--watch-behaviors` is on, and the built-in default behaviors with the actions each answers)                                                                                                                                                                                                                                             |
| `behavior_reload`             | `behavior.reload`             | — (no parameters: re-reads the files given at start; no path or code can be supplied). **Together with `cp_behaviors_set` this gives an AI agent control over which loaded code runs, and over re-reading files on disk: do not connect an agent to a daemon whose behavior directories it can write** ([trust line](../concepts/charger-engine.md#loading-code-and-the-trust-line)) |
| `cp_bulk`                     | `cp.bulk`                     | `labels`, `action` (`connect` / `disconnect` / `reset`) — every CP carrying every pair; `{}` refused; partial success is the result; schema derived from the method's (#470)                                                                                                                                                                                                         |
| `cp_scenario_run`             | `cp.scenario.run`             | `labels`, `connector`, `templateId`, `evSettings?`, `strict?`, `once?` — `run_scenario_template` on every CP carrying every pair; `{}` refused; returns `started` with each `scenarioId`; schema derived from the method's (#486)                                                                                                                                                    |
| `cp_connect`                  | `connect`                     | `cpId`                                                                                                                                                                                                                                                                                                                                                                               |
| `cp_disconnect`               | `disconnect`                  | `cpId`                                                                                                                                                                                                                                                                                                                                                                               |
| `cp_status`                   | `status`                      | `cpId`                                                                                                                                                                                                                                                                                                                                                                               |
| `start_transaction`           | `start_transaction`           | `cpId`, `connector`, `tagId?` — omitted, draws from the CP's [idTag pool](../concepts/control-plane.md#idtag-pool) (#299); `triggerReason?`, `chargingState?` — OCPP 2.x Started-event values (#335, [parameters](../concepts/control-plane.md#transaction-event-parameters)); `idTokenType?` — 2.x `IdToken.type` (#599)                                                            |
| `stop_transaction`            | `stop_transaction`            | `cpId`, `connector`, `reason?`, `triggerReason?` — 1.6 reason / 2.0.1 stoppedReason and the 2.x Ended-event trigger (#335)                                                                                                                                                                                                                                                           |
| `authorize`                   | `authorize`                   | `cpId`, `tagId?` — same idTag pool fallback as `start_transaction` (#299); `idTokenType?` (#599)                                                                                                                                                                                                                                                                                     |
| `send_ocpp_call`              | `send_ocpp_call`              | `cpId`, `action`, `payload`, `skipValidation?`, `applyResponse?` — [Expert OCPP calls](../concepts/expert-ocpp-calls.md) (#389)                                                                                                                                                                                                                                                      |
| `send_raw_frame`              | `send_raw_frame`              | `cpId`, `frame`, `waitMs?`: [Expert OCPP calls → Raw frames](../concepts/expert-ocpp-calls.md#raw-frames-level-c-393) (#393)                                                                                                                                                                                                                                                         |
| `auth_cache_get`              | `get_auth_cache`              | `cpId` — cache switch and entries ([Local authorization](../concepts/local-authorization.md#control-plane-seam), #452)                                                                                                                                                                                                                                                               |
| `auth_cache_seed`             | `seed_auth_cache`             | `cpId`, `entries` — schema taken from the method; writes whatever the cache switch says (#452)                                                                                                                                                                                                                                                                                       |
| `auth_cache_clear`            | `clear_auth_cache`            | `cpId` — empties the cache whatever its switch says; nothing goes on the wire (#452)                                                                                                                                                                                                                                                                                                 |
| `security_event_notification` | `security_event_notification` | `cpId`, `type`, `techInfo?` — schema taken from the method; sends SecurityEventNotification on 1.6 and 2.x (A04), SOAP only logs it; a dropped 2.x CALL is `disconnected`; a critical event sent offline is queued (A04.FR.02) ([Security profiles](../concepts/security-profiles.md), #537)                                                                                         |
| `get_15118_ev_certificate`    | `get_15118_ev_certificate`    | `cpId`, `iso15118SchemaVersion`, `action`, `exiRequest` (base64), 2.1 `maximumContractCertificateChains?` / `prioritizedEMAIDs?` — schema taken from the method; returns the CSMS answers (#537)                                                                                                                                                                                     |
| `set_connector_status`        | `update_connector_status`     | `cpId`, `connector`, `status` (a connector status, as `update_connector_status` enforces), `errorCode?`, `info?`, `vendorErrorCode?`, `vendorId?`, `timestamp?`, `suppressChargingStateTransactionEvent?`                                                                                                                                                                            |
| `ev_disconnected`             | `ev_disconnected`             | `cpId`, `connector` — an EV-side unplug; `StopTransactionOnEVSideDisconnect` stops or suspends a running transaction (#488)                                                                                                                                                                                                                                                          |
| `set_meter_value`             | `set_meter_value`             | `cpId`, `connector`, `value`                                                                                                                                                                                                                                                                                                                                                         |
| `send_meter_value`            | `send_meter_value`            | `cpId`, `connector`, `context?` — `ReadingContext` the readings carry (#335)                                                                                                                                                                                                                                                                                                         |
| `scenario_templates`          | `scenario.templates`          | —                                                                                                                                                                                                                                                                                                                                                                                    |
| `run_scenario_template`       | `run_scenario_template`       | `cpId`, `connector`, `templateId`, `evSettings?`, `strict?`, `once?`                                                                                                                                                                                                                                                                                                                 |
| `scenario_status`             | `scenario_status`             | `cpId`, `connector`, `scenarioId`                                                                                                                                                                                                                                                                                                                                                    |
| `control_scenario_wait`       | `<action>_scenario_wait`      | `cpId`, `connector`, `scenarioId`, `action` (`extend` / `retry` / `continue`), `seconds?` — required by `extend` (#240)                                                                                                                                                                                                                                                              |
| `get_logs`                    | `logs.get`                    | `cpId`, `limit?`, `offset?`, `order?` — `limit` takes the most recent N ([Log windowing](../concepts/log-format.md#log-windowing))                                                                                                                                                                                                                                                   |
| `tail_logs`                   | `logs.get`                    | `cpId`, `lines?` (default 50, max 1000), `level?` (this level or more severe), `type?`, `contains?` (case-insensitive) — the end of the log, oldest first, the newest entry last; filters apply before the tail is taken. Use `get_logs` to page further back (#613)                                                                                                                 |
| `get_timeline`                | `timeline.get`                | `cpId`, `connectorId?`, `runId?`, `incidentId?`, `kinds?`, `limit?`, `offset?`, `order?` — the [operational timeline](../concepts/operational-timeline.md), windowed like `get_logs` (#448)                                                                                                                                                                                          |
| `list_charging_sessions`      | `sessions.list`               | `cpId?` (omitted: the whole fleet, #489), `labels?`, `startedFrom?`, `startedTo?`, `connectorId?`, `outcomes?`, `limit?` (default 50), `offset?`, `order?` — the [charging sessions](../concepts/charging-sessions.md), newest first by default (#447)                                                                                                                               |
| `get_config_keys`             | `cp.config_keys.get`          | `cpId`, `keys?` — the OCPP [configuration keys](../concepts/control-plane.md#configuration-keys-612) of a running charge point; a write-only value is returned empty (#612)                                                                                                                                                                                                          |
| `set_config_key`              | `cp.config_keys.set`          | `cpId`, `key`, `value` — write one key; `not_found` for an unknown key, `invalid_params` for a read-only key or a refused value (#612)                                                                                                                                                                                                                                               |

Most of these tools hand-declare a copy of their method's fields rather than
deriving it (`cp_create` / `cp_create_many`, `cp_list`, `cp_labels_set`,
`cp_bulk` and `cp_scenario_run` are the exception — see
[cp.create parameters](../concepts/control-plane.md#cpcreate-parameters)), so
a field the method later gains, or an optional field the tool over-tightened
to required, could silently drift out of reach of an MCP agent (#284, #299).
`get_timeline`, `list_charging_sessions`, `get_config_keys` and `set_config_key` sit in between: they list their
fields by hand but take each field's schema from the method's, so a field
cannot be over-tightened, while a field the method gains still has to be added.
`mcpToolSchemaParity.test.ts` guards against both directions for every
curated tool except the ones noted in its own comments (`network_sim_get` /
`network_sim_set`, which dispatch to one of two methods, `control_scenario_wait`,
which dispatches to one of three, `tail_logs`, which adds client-side filters to
`logs.get`'s `cpId`, and the generic `call_method` /
`list_methods`); the multi-method tools are checked against every method
they can call.

### Network-simulation tools

Further tools wrap the [network simulation](../concepts/network-simulation.md)
RPC methods:

| Tool                             | RPC Method(s)                                    | Params                                                                                                        |
| -------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `network_sim_get`                | `network_sim.global.get`, `network_sim.cp.get`   | `cpId?` — if omitted, returns global config; if set, returns per-CP config and resolved state                 |
| `network_sim_set`                | `network_sim.global.save`, `network_sim.cp.save` | `cpId?`, `config` — if omitted, saves global config; if set, saves per-CP config                              |
| `modem_get`                      | `modem.get`                                      | `cpId` — masked modem and SIM state ([Cellular modem and SIM](../concepts/cellular-modem.md))                 |
| `modem_command`                  | `modem.command`                                  | `cpId`, `command`, `sim?`, `networkInterface?` — insert / remove / replace SIM, suspend / activate, interface |
| `network_sim_trigger_disconnect` | `network_sim.disconnect.trigger`                 | `cpId`, `ruleId` — triggers a manual-disconnect rule for the CP                                               |

Two more tools simulate a [power loss](../concepts/power-loss.md) (#455): `power_loss`
(`cpId`, `restoreAfterMs?`, `transactions?`, `txResumptionTimeoutSeconds?`) wraps `power.loss`, `power_restore`
(`cpId`, `transactions?`, `txResumptionTimeoutSeconds?`) wraps `power.restore`.

## OCPP schema resources

The endpoint lists and serves the official OCA JSON Schema of every OCPP
message, so an agent can read the schema of a message before it builds a
`send_ocpp_call` payload ([Expert OCPP calls](../concepts/expert-ocpp-calls.md)).
Use `resources/list` and `resources/read`; there are no templates and no
subscriptions.

| URI                                            | Content                                                                                                                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ocpp-schema://<version>/<Action>/<direction>` | `<version>` is `v16`, `v201` or `v21`; `<Action>` is the OCPP action name (`BootNotification`); `<direction>` is `request` or `response`. MIME type `application/schema+json` |
| `ocpp-schema://NOTICE`                         | The attribution and license text, `text/plain`                                                                                                                                |

One resource exists per vendored schema file (181 for 2.1, 128 for 2.0.1, 78 for
1.6, plus the notice). The schema text is **byte-identical** to the vendored
file: nothing is parsed or re-serialized, because the files are CC BY-ND and
may be redistributed only unmodified. The URI is built from the file name.
Every schema read returns the vendored `NOTICE` verbatim as a second content
item, and the description of every resource (the notice included) carries the
attribution "© Open Charge Alliance, CC BY-ND 4.0" with the license link
<https://creativecommons.org/licenses/by-nd/4.0/>, so attribution and license
travel with the schema. The same license covers the 1.6, 2.0.1 and 2.1
schemas. An unknown URI, or one that tries to leave the list
(`ocpp-schema://v21/../NOTICE`), is answered with a JSON-RPC error. The texts
are compiled into the binary from
[`packages/ocpp/vendor/ocpp-schemas/`](../../packages/ocpp/vendor/ocpp-schemas/NOTICE)
by `bun run gen:ocpp` (`packages/ocpp/src/schemaSources.ts`, generated); the
vendored directory stays verbatim-only ([Conventions](../conventions.md#layers),
[Vendored OCPP schemas](../sources/vendored-ocpp-schemas.md)).

## Generic Escape Hatch

For any RPC method not in the curated set, use the generic tools:

- **`list_methods`** — no params → returns all method names with one-line descriptions and whether `cpId` is required. Pass `{ method }` to retrieve the full JSON Schema for one method.
- **`call_method`** — `{ method, cpId?, params? }` → dispatches any RPC method. Rejects `events.subscribe` / `events.unsubscribe` (socket-bound) with an error. The description warns that `server.shutdown` and `state.reset` are destructive operations.

The [vehicle profile](../concepts/vehicle-profiles.md) methods
(`vehicle_profiles.*`, `vehicle_catalog.*`, #458) have no curated tool: call
them through `call_method`, without `cpId` (`list_methods` reports
`cpIdRequired: false`). See the
[Open EV Directory smoke test](open-ev-directory.md#smoke-test).

## Error Handling

Tool-level failures return an MCP tool result with `isError: true` and text in the format
`"<code>: <message>"`, using the same error codes as the Socket.IO RPC:
`not_found`, `invalid_params`, `connect_failed`, `timeout`, `internal`,
`unauthorized`, and — from the `vehicle_catalog.*` methods (#458) —
`rate_limited` and `unavailable`: eight of the nine codes the
[Control plane](../concepts/control-plane.md#rpc) defines, with the same
meanings. An error's `retryAfterSeconds` is not a separate field here; the
wait survives only in the message text
(`rate_limited: Open EV Directory rate limit reached; retry in 7 s`). `disconnected` is mostly absent: the Socket.IO client synthesises
it when the socket drops before an ack arrives, and an HTTP request/response
has no such state to report. The three exceptions are `send_ocpp_call`, which
answers `disconnected` when its CALL was dropped before the CSMS could answer
([Expert OCPP calls](../concepts/expert-ocpp-calls.md#errors), #389),
`get_15118_ev_certificate`, which does so when its first CALL was
([Get15118EVCertificate relay](../concepts/security-profiles.md#get15118evcertificate-relay), #537),
and a 2.x `security_event_notification`, which does so when its CALL was
dropped before it was written ([Security profiles](../concepts/security-profiles.md#ocpp-201-and-21-behaviour), #537).

Transport-level errors (malformed JSON-RPC, invalid auth, rate limit) are handled by the MCP
protocol layer. Every call is subject to a 30-second deadline; timeout failures surface as
`timeout: <message>`.

## Limits

- Request body: 1 MB cap → `413 Payload Too Large`.
- Rate limit: a dedicated token bucket with the same numbers as the Socket.IO RPC (100 calls/s refill, 64 in-flight) → `429 Too Many Requests`.
- Non-POST requests to `/mcp` → `405 Method Not Allowed` (no server-initiated SSE stream, no sessions).
- Per-call deadline: 30 seconds (same as Socket.IO RPC).
- `serverInfo.version` reports the same build version as [`/v1/healthz`](daemon.md#health).
