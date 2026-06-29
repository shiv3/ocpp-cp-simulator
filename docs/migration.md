# Migrating from REST/Unix Control to Socket.IO

The daemon control plane is now one Socket.IO connection per client. Browser
Remote mode, the bundled CLI client, and external agents all use the same
contract:

```js
socket.emit("rpc", { cpId, method, params }, ack);
```

Ack shape:

```json
{ "ok": true, "result": {} }
```

or:

```json
{
  "ok": false,
  "error": { "code": "invalid_params", "message": "invalid params" }
}
```

Server push uses:

```js
socket.on("event", (envelope) => {});
```

where `envelope` is either `{ "kind": "cp", "cpId": "...", "evt": ... }` or
`{ "kind": "registry", "change": "added|removed|updated|reset", "cp": ... }`.

## Endpoint Mapping

| Before                                                  | After                                                                                                           |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /v1/healthz`                                       | Still available. Returns only `{ "ok": true }` and is unauthenticated.                                          |
| `GET /v1/cp`                                            | `rpc`: `{ "method": "cp.list", "params": {} }`                                                                  |
| `POST /v1/cp`                                           | `rpc`: `{ "method": "cp.create", "params": { "cpId": "...", "wsUrl": "...", "autoConnect": true } }`            |
| `GET /v1/cp/:cpId`                                      | `rpc`: `{ "cpId": "...", "method": "status", "params": {} }`                                                    |
| `DELETE /v1/cp/:cpId`                                   | `rpc`: `{ "method": "cp.delete", "params": { "cpId": "..." } }`                                                 |
| `POST /v1/cp/:cpId/command`                             | `rpc`: `{ "cpId": "...", "method": "<jsonMode command id>", "params": { ... } }`                                |
| `GET /v1/cp/:cpId/logs`                                 | `rpc`: `{ "method": "logs.get", "params": { "cpId": "...", "limit": 100 } }`                                    |
| `POST /v1/cp/:cpId/logs/clear`                          | `rpc`: `{ "method": "logs.clear", "params": { "cpId": "..." } }`                                                |
| `POST /v1/state/reset`                                  | `rpc`: `{ "method": "state.reset", "params": {} }`                                                              |
| `POST /v1/shutdown`                                     | `rpc`: `{ "method": "server.shutdown", "params": {} }`                                                          |
| `WS /v1/cp/:cpId/events`                                | `events.subscribe` RPC with `{ "scope": "<cpId>" }`; listen for `event` envelopes with `kind: "cp"`.            |
| `WS /v1/events`                                         | `events.subscribe` RPC with `{ "scope": "*" }`; listen for `event` envelopes with `kind: "cp"` or `"registry"`. |
| HTTP over `/tmp/ocpp-server.sock` or custom Unix socket | Removed. Use TCP Socket.IO, default `http://127.0.0.1:9700` with path `/socket.io/`.                            |

There is no new REST endpoint for `cp.update`; use the Socket.IO method
`cp.update` with the same params shape as `cp.create`.

## CP Command Names

For CP-scoped commands, the `method` is the JSON-mode command ID verbatim. For
example:

```json
{
  "cpId": "CP001",
  "method": "start_transaction",
  "params": { "connector": 1, "tagId": "TAG001" }
}
```

Common command IDs include `connect`, `disconnect`, `status`,
`start_transaction`, `stop_transaction`, `set_meter_value`,
`send_meter_value`, `run_scenario`, `set_soc_meter_sync`, and
`get_state_history`. The full table is in [server.md](server.md#cp-command-methods).

## Subscriptions

Subscribe with the `events.subscribe` RPC:

```js
const ack = await rpc({
  method: "events.subscribe",
  params: { scope: "*" },
});
```

`scope` must be:

- `"*"` for all CP events and registry changes,
- `"registry"` for registry changes,
- an existing CP ID for that CP's events.

The subscribe ack is atomic and includes:

```json
{
  "subscribed": ["*"],
  "snapshot": {
    "cps": [],
    "perCp": {}
  }
}
```

Apply the snapshot first, then process later `event` pushes.

## Auth Change

`--web-console-basic-auth-user` and `--web-console-basic-auth-pass` still gate
static web-console assets with HTTP Basic Auth. They now also gate the
Socket.IO handshake.

Socket.IO clients must send the same credentials in `socket.handshake.auth`:

```js
io("http://127.0.0.1:9700", {
  path: "/socket.io/",
  auth: { username: "admin", password: "secret" },
});
```

The health endpoint is always exempt:

```http
GET /v1/healthz
```

The CLI client flags `--http-basic-auth-user` and `--http-basic-auth-pass` send
Socket.IO handshake auth for `--send`, `--events`, and `--stop`. The
CSMS-facing `--basic-auth-user/pass` flags are unrelated.

## Unix Socket Removal

The Unix-domain control socket is removed. The `--unix-socket` flag remains
accepted only as a deprecated no-op so old launchers do not fail immediately.
It prints a warning and is ignored.

Use TCP Socket.IO instead:

```bash
ocpp-cp-sim --daemon
ocpp-cp-sim --http-url http://127.0.0.1:9700 --cp-id CP001 \
  --send '{"command":"status"}'
```

Bare `--daemon` now defaults to `http://127.0.0.1:9700`.

## External Agent Example

```js
// agent.mjs
import { io } from "socket.io-client";

const socket = io("http://127.0.0.1:9700", {
  path: "/socket.io/",
  // Include only when the daemon was started with
  // --web-console-basic-auth-user/pass.
  auth: { username: "admin", password: "secret" },
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

socket.disconnect();
```
