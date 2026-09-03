---
title: Driving the simulator from an AI agent or test harness
type: analysis
summary: The minimal recipe and the feature checklist for using the daemon as a scriptable OCPP stub — structured logs, Socket.IO `rpc`/`event`, MCP tools, scenario templates, health probe, persistence — with the three client options ranked.
sources:
  - README.md (AI Agent & Automation Testing section)
  - synthesized from the control-plane, MCP and CLI pages
related:
  - ../concepts/control-plane.md
  - ../entities/mcp-endpoint.md
  - ../entities/cli.md
  - ../entities/daemon.md
  - ../concepts/log-format.md
  - ../sources/testcontainers-java-readme.md
updated: 2026-09-03
---

# Driving the simulator from an AI agent or test harness

The [daemon](../entities/daemon.md) exposes a single Socket.IO control
connection and emits structured logs, making it a scriptable OCPP stub that
any AI agent or test harness can drive.

| Feature                              | What it enables                                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `--log-format json`                  | One JSON object per line — easy to parse or feed to an LLM ([Log format](../concepts/log-format.md))                             |
| Socket.IO `rpc` event                | Send OCPP commands from any language or agent ([Control plane](../concepts/control-plane.md))                                    |
| `POST /mcp` endpoint                 | Drive the simulator via MCP clients (Claude Code, etc.) — [MCP endpoint](../entities/mcp-endpoint.md)                            |
| Scenario templates (JSON)            | Declare a full charging flow, inject at runtime without restart ([Scenario templates](../entities/scenario-templates.md))        |
| Socket.IO `event` push + rooms       | Subscribe to real-time OCPP events for assertions                                                                                |
| `scenario_report` + assertions       | Machine-readable PASS/FAIL verdict per run ([Scenario format → Assertions](../concepts/scenario-format.md#assertions--verdicts)) |
| `GET /v1/healthz`                    | Unauthenticated readiness detection and Docker healthcheck                                                                       |
| `--state-db`                         | Persist CP state across restarts — no re-bootstrap needed ([State persistence](../concepts/state-persistence.md))                |
| `socket.io-client` + `zod` contracts | Use the same typed contract as the browser UI and CLI (`src/protocol/`)                                                          |
| Network simulation                   | Inject latency / disconnects deterministically for resilience tests ([Network simulation](../concepts/network-simulation.md))    |

## Minimal setup

```bash
# 1. Start daemon with structured logs
ocpp-cp-sim --http-port 5172 --cp-id CP001 --connectors 1 \
            --ws-url wss://your-csms/ocpp/ \
            --state-db ./state.db --log-format json

# 2. External agent connects once with socket.io-client
node agent.mjs
```

```js
// agent.mjs
import { io } from "socket.io-client";

const socket = io("http://127.0.0.1:5172", { path: "/socket.io/" });
const rpc = (request) => socket.timeout(30_000).emitWithAck("rpc", request);

socket.on("event", (envelope) => console.log(JSON.stringify(envelope)));
await new Promise((resolve, reject) => {
  socket.once("connect", resolve);
  socket.once("connect_error", reject);
});

await rpc({ method: "events.subscribe", params: { scope: "CP001" } });
await rpc({
  cpId: "CP001",
  method: "start_transaction",
  params: { connector: 1, tagId: "TAG001" },
});
```

## Three client options, ranked by effort

1. **MCP** — `claude mcp add --transport http ocpp-sim http://127.0.0.1:9700/mcp`;
   the agent gets 16 curated tools, 3 network-sim tools and `list_methods` /
   `call_method` for everything else. Best for LLM agents; no code to write.
2. **Bundled CLI as client** — `ocpp-cp-sim --cp-id CP001 --send '{"command":"status"}'`,
   `--events [--all]`, `--stop`, `analyze --from-daemon`. Best for shell
   scripts and CI steps ([CLI → Client modes](../entities/cli.md#4-client-modes---send----events----stop)).
3. **socket.io-client (any language)** — the full contract including
   `cp.create`, rooms and snapshots. Best for test harnesses; the
   [Java/Testcontainers example](../sources/testcontainers-java-readme.md)
   is the reference sequence (`cp.create` → `events.subscribe` →
   `load_scenario` → `run_scenario` → poll `scenario_report`).

If the daemon is gated with `--web-console-basic-auth-*`, every option
authenticates as described in
[Access control](../concepts/access-control.md#authenticating-to-a-protected-daemon).

## Assertion pattern

- Subscribe to the CP room **before** issuing commands; apply the subscribe
  snapshot, then process pushes.
- Prefer scenario `assertions` + `scenario_report` over parsing logs — they
  return `frameRefs` pointing at the exact transcript frames.
- For post-hoc diagnosis, run [`analyze --from-daemon`](../entities/analyze.md#reading-from-a-running-daemon---from-daemon)
  or keep a `--trace-output` file.
- `scenario_status` keeps the terminal state (`completed` / `error`) after a
  run ends, so pollers can distinguish "unknown scenario" (`null`) from
  "already finished".
