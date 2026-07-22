# Driving the Simulator from Agents & Scripts

The daemon exposes a single Socket.IO control connection and emits structured logs, making it a scriptable OCPP stub that any AI agent or test harness can drive.

| Feature                              | What it enables                                                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `--log-format json`                  | One JSON object per line — easy to parse or feed to an LLM                                                                    |
| Socket.IO `rpc` event                | Send OCPP commands from any language or agent                                                                                 |
| `POST /mcp` endpoint                 | Drive the simulator via MCP clients (Claude Code, etc.) — see [server.md § MCP Endpoint](../reference/server.md#mcp-endpoint) |
| Scenario templates (JSON)            | Declare a full charging flow, inject at runtime without restart                                                               |
| Socket.IO `event` push + rooms       | Subscribe to real-time OCPP events for assertions                                                                             |
| `GET /v1/healthz`                    | Unauthenticated local/remote detection and Docker healthcheck                                                                 |
| `--state-db`                         | Persist CP state across restarts — no re-bootstrap needed                                                                     |
| `socket.io-client` + `zod` contracts | Use the same typed contract as the browser UI and CLI                                                                         |

## Minimal setup

```bash
# 1. Start daemon with structured logs
ocpp-cp-sim --http-port 5172 --cp-id CP001 --connectors 1 \
            --ws-url wss://your-csms/ocpp/ \
            --state-db ./state.db --log-format json

# 2. External agent connects once with socket.io-client
node docs/examples/automation/agent.mjs
```

## Runnable examples

- [`agent.mjs`](../examples/automation/agent.mjs) — Node + socket.io-client: connect, subscribe to events, start a transaction
- [`agent.py`](../examples/automation/agent.py) — the same agent in Python (`pip install "python-socketio[asyncio_client]"`)
- [`healthcheck.sh`](../examples/automation/healthcheck.sh) — curl health probe, with a Basic Auth variant

## CLI as a client

Prefer not to write a client? The same `ocpp-cp-sim` binary doubles as a TCP Socket.IO client for a running daemon — `--send` a CP command, `--stop` it, or `--events` to stream. It targets `http://127.0.0.1:9700` by default or a custom `--http-url`. If the daemon is gated with `--web-console-basic-auth-*`, authenticate with `--http-basic-auth-user/pass`. See [server.md → Controlling a running daemon from the CLI](../reference/server.md#controlling-a-running-daemon-from-the-cli).

## MCP (Model Context Protocol)

The daemon serves `POST /mcp` — 16 curated tools plus `list_methods` / `call_method` escape hatches covering every RPC method (full reference: [server.md § MCP Endpoint](../reference/server.md#mcp-endpoint)). Point an MCP client at it, e.g. Claude Code via a project `.mcp.json` ([`mcp-config.json`](../examples/automation/mcp-config.json)):

```json
{
  "mcpServers": {
    "ocpp-cp-sim": {
      "type": "http",
      "url": "http://127.0.0.1:9700/mcp"
    }
  }
}
```

When the daemon is gated with `--web-console-basic-auth-*`, MCP clients authenticate with a standard HTTP `Authorization: Basic …` header.

## Java / JVM test suites

[`examples/testcontainers-java/`](../../examples/testcontainers-java/README.md) drives the Docker image from Testcontainers: boot the container, `cp.create` a charge point against your CSMS-under-test, `run_scenario`, and assert the machine-readable verdict — the "WireMock of OCPP" pattern.

## See also

[server.md](../reference/server.md) for the full Socket.IO API reference and [migration.md](migration.md) for the REST/Unix migration guide.
