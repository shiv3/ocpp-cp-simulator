---
title: MCP endpoint (`POST /mcp`)
type: entity
summary: Stateless, tools-only Model Context Protocol endpoint served by the daemon so MCP clients such as Claude Code can drive the simulator; 19 curated tools + 3 network-sim tools + a generic escape hatch.
sources:
  - src/cli/server/mcp/tools.ts
  - src/cli/server/__tests__/mcp.test.ts
  - src/cli/server/__tests__/networkSimMcp.bun.test.ts
  - src/cli/server/__tests__/mcpToolSchemaParity.test.ts
related:
  - daemon.md
  - ../concepts/control-plane.md
  - ../concepts/network-simulation.md
  - ../analyses/driving-from-an-ai-agent.md
updated: 2026-09-04
---

# MCP endpoint (`POST /mcp`)

The [daemon](daemon.md) exposes a Model Context Protocol (MCP) endpoint at
`POST /mcp` for AI agents and external clients. The endpoint is stateless,
Streamable HTTP, and tools-only — no resources, prompts, or server-to-client
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

The endpoint exposes 19 curated tools wrapping the daemon's
[RPC methods](../concepts/control-plane.md):

| Tool                    | RPC Method                | Params                                                                                                                                                                                                               |
| ----------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cp_list`               | `cp.list`                 | —                                                                                                                                                                                                                    |
| `cp_create`             | `cp.create`               | Every `cp.create` parameter plus `autoConnect?` — the schema is derived from the method's, so the two cannot drift ([cp.create parameters](../concepts/control-plane.md#cpcreate-parameters))                        |
| `cp_create_many`        | `cp.create_many`          | Every `cp.create` parameter except `cpId`, plus `count` / `idPattern?` / `startIndex?` / `blueprintId?` — schema derived the same way ([batch fields](../concepts/control-plane.md#cpcreate_many--the-batch-fields)) |
| `blueprint_list`        | `blueprint.list`          | — (built-ins first, then stored)                                                                                                                                                                                     |
| `blueprint_save`        | `blueprint.save`          | `blueprint` — schema derived from `blueprintSchema` ([Blueprints](../concepts/control-plane.md#blueprints))                                                                                                          |
| `cp_delete`             | `cp.delete`               | `cpId`                                                                                                                                                                                                               |
| `cp_connect`            | `connect`                 | `cpId`                                                                                                                                                                                                               |
| `cp_disconnect`         | `disconnect`              | `cpId`                                                                                                                                                                                                               |
| `cp_status`             | `status`                  | `cpId`                                                                                                                                                                                                               |
| `start_transaction`     | `start_transaction`       | `cpId`, `connector`, `tagId?` — omitted, draws from the CP's [idTag pool](../concepts/control-plane.md#idtag-pool) (#299)                                                                                            |
| `stop_transaction`      | `stop_transaction`        | `cpId`, `connector`                                                                                                                                                                                                  |
| `authorize`             | `authorize`               | `cpId`, `tagId?` — same idTag pool fallback as `start_transaction` (#299)                                                                                                                                            |
| `set_connector_status`  | `update_connector_status` | `cpId`, `connector`, `status`, `errorCode?`, `info?`, `vendorErrorCode?`, `vendorId?`, `timestamp?`, `suppressChargingStateTransactionEvent?`                                                                        |
| `set_meter_value`       | `set_meter_value`         | `cpId`, `connector`, `value`                                                                                                                                                                                         |
| `send_meter_value`      | `send_meter_value`        | `cpId`, `connector`                                                                                                                                                                                                  |
| `scenario_templates`    | `scenario.templates`      | —                                                                                                                                                                                                                    |
| `run_scenario_template` | `run_scenario_template`   | `cpId`, `connector`, `templateId`, `evSettings?`, `strict?`                                                                                                                                                          |
| `scenario_status`       | `scenario_status`         | `cpId`, `connector`, `scenarioId`                                                                                                                                                                                    |
| `get_logs`              | `logs.get`                | `cpId`, `limit?`, `offset?`, `order?` — `limit` takes the most recent N ([Log windowing](../concepts/log-format.md#log-windowing))                                                                                   |

Most of these tools hand-declare a copy of their method's fields rather than
deriving it (`cp_create` / `cp_create_many` are the exception — see
[cp.create parameters](../concepts/control-plane.md#cpcreate-parameters)), so
a field the method later gains, or an optional field the tool over-tightened
to required, could silently drift out of reach of an MCP agent (#284, #299).
`mcpToolSchemaParity.test.ts` guards against both directions for every
curated tool except the ones noted in its own comments (`network_sim_get` /
`network_sim_set`, which dispatch to one of two methods, and the generic
`call_method` / `list_methods`).

### Network-simulation tools

Three further tools wrap the [network simulation](../concepts/network-simulation.md)
RPC methods:

| Tool                             | RPC Method(s)                                    | Params                                                                                        |
| -------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `network_sim_get`                | `network_sim.global.get`, `network_sim.cp.get`   | `cpId?` — if omitted, returns global config; if set, returns per-CP config and resolved state |
| `network_sim_set`                | `network_sim.global.save`, `network_sim.cp.save` | `cpId?`, `config` — if omitted, saves global config; if set, saves per-CP config              |
| `network_sim_trigger_disconnect` | `network_sim.disconnect.trigger`                 | `cpId`, `ruleId` — triggers a manual-disconnect rule for the CP                               |

## Generic Escape Hatch

For any RPC method not in the curated set, use the generic tools:

- **`list_methods`** — no params → returns all method names with one-line descriptions and whether `cpId` is required. Pass `{ method }` to retrieve the full JSON Schema for one method.
- **`call_method`** — `{ method, cpId?, params? }` → dispatches any RPC method. Rejects `events.subscribe` / `events.unsubscribe` (socket-bound) with an error. The description warns that `server.shutdown` and `state.reset` are destructive operations.

## Error Handling

Tool-level failures return an MCP tool result with `isError: true` and text in the format
`"<code>: <message>"`, using the same error codes as the Socket.IO RPC:
`not_found`, `invalid_params`, `connect_failed`, `timeout`, `internal`,
`unauthorized` — six of the seven codes the
[Control plane](../concepts/control-plane.md#rpc) defines, with the same
meanings. `disconnected` is the exception: the Socket.IO client synthesises
it when the socket drops before an ack arrives, and an HTTP request/response
has no such state to report.

Transport-level errors (malformed JSON-RPC, invalid auth, rate limit) are handled by the MCP
protocol layer. Every call is subject to a 30-second deadline; timeout failures surface as
`timeout: <message>`.

## Limits

- Request body: 1 MB cap → `413 Payload Too Large`.
- Rate limit: a dedicated token bucket with the same numbers as the Socket.IO RPC (100 calls/s refill, 64 in-flight) → `429 Too Many Requests`.
- Non-POST requests to `/mcp` → `405 Method Not Allowed` (no server-initiated SSE stream, no sessions).
- Per-call deadline: 30 seconds (same as Socket.IO RPC).
- `serverInfo.version` reports the same build version as [`/v1/healthz`](daemon.md#health).
