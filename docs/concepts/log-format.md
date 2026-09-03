---
title: Log format
type: concept
summary: One log-line shape (`timestamp` / `level` / `type` / `message` / `cpId`) shared by daemon stderr in `--log-format json`, the `logs` table, the browser log download and the `logs.get` RPC — plus the newest-first `limit` windowing rules.
sources:
  - src/cli/server/ (logs.get / logs.clear)
  - src/trace/logEntryToTrace.ts
related:
  - ../entities/daemon.md
  - ../entities/docker-image.md
  - state-persistence.md
  - trace-format.md
  - ../entities/analyze.md
updated: 2026-09-03
---

# Log format

By default the [daemon](../entities/daemon.md) writes human-readable log lines:

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

- the rows persisted in the `logs` table ([State persistence](state-persistence.md)),
- the JSON Lines file produced by the browser's "Download" button in the log
  viewer,
- the result of the `logs.get` RPC method.

So you can pipe daemon stderr into the same `jq` pipeline that consumes a
downloaded log file (see [Docker image → Structured logs](../entities/docker-image.md#structured-logs)
for an example). The same lines are what the [trace adapter](trace-format.md#producing-records)
turns into trace records, which is how [`analyze --from-daemon`](../entities/analyze.md#reading-from-a-running-daemon---from-daemon)
works without a trace file.

## Related RPC methods

| Method        | Params                                                                               | Returns / purpose                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `logs.get`    | `{ "cpId": string, "limit"?: number, "offset"?: number, "order"?: "asc" \| "desc" }` | Log rows for the CP. Falls back to the in-memory Logger buffer when `--state-db` is not set. See [Log windowing](#log-windowing). |
| `logs.clear`  | `{ "cpId": string }`                                                                 | Delete the persisted log rows for the CP.                                                                                         |
| `state.reset` | `{}`                                                                                 | Truncate every simulator-owned table (logs included), then disconnect/forget every in-memory CP. Schema is preserved.             |

### Log windowing

`limit` selects the **most recent** N entries, not the oldest — so
`{"limit": 200}` answers "what just happened?" on a charge point that has been
up for days.

| Params                            | Returns                                                     |
| --------------------------------- | ----------------------------------------------------------- |
| _(none)_                          | Every entry, oldest first.                                  |
| `{"limit": 100}`                  | The newest 100, oldest first within the window.             |
| `{"limit": 100, "offset": 100}`   | The 100 entries before those — `offset` pages back in time. |
| `{"limit": 100, "order": "desc"}` | The newest 100, newest first.                               |

> **Changed in 0.7.6.** `limit` used to return the _oldest_ N, which meant no
> limit could reach recent activity on a long-running charge point. A client
> that wants the old behaviour can page from the far end with `offset`, or omit
> `limit` and slice the full result itself. The MCP `get_logs` tool follows the
> same semantics.

## Retention

- Without `--state-db`: a bounded in-memory Logger buffer, lost on restart.
- With `--state-db`: the `logs` table, batched writes (50 entries / 500 ms),
  trimmed to 10 k rows per CP, cleared by `logs.clear` or `state.reset`.
- A `--trace-output` file ([Trace format](trace-format.md)) is the only source
  guaranteed to hold every wire frame since the process last (re)started.
