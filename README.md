# OCPP CP Simulator

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/shiv3/ocpp-cp-simulator)

A charge point (EV charging station) simulator with two core strengths:

- **Multi-version OCPP** — speaks OCPP **1.2, 1.5, 1.6J, 1.6S, 2.0.1, and 2.1** from one core: WebSocket JSON and SOAP transports, plus OCPP 1.6 security profiles 1–3.
- **Automation-first** — every function is scriptable: a headless daemon with a typed Socket.IO RPC, an MCP endpoint for AI agents, JSON-line logs, declarative scenarios with pass/fail assertions, and SQLite persistence.

![Web console — connector panel, scenario editor, and real-time logs](docs/images/web-console-overview.png)

## Version support

| Version    | Transport            | Browser      | CLI / daemon                            |
| ---------- | -------------------- | ------------ | --------------------------------------- |
| OCPP 1.6J  | WebSocket (JSON)     | ✅           | ✅ security profiles 1–3                |
| OCPP 2.0.1 | WebSocket (JSON)     | ✅           | ✅                                      |
| OCPP 2.1   | WebSocket (JSON)     | ✅           | ✅                                      |
| OCPP 1.6S  | SOAP / WS-Addressing | ⚠️ send-only | ✅ bidirectional, full 1.6 message set  |
| OCPP 1.5   | SOAP / WS-Addressing | ⚠️ send-only | ✅ bidirectional                        |
| OCPP 1.2   | SOAP / WS-Addressing | ⚠️ send-only | ✅ bidirectional (narrower 1.2 surface) |

⚠️ send-only: the browser cannot host the SOAP callback endpoint, so CSMS-initiated commands need CLI/daemon mode — see the [SOAP guide](docs/guides/soap.md).

## Interfaces

| Interface   | Description                                                      | Docs                                            |
| ----------- | ---------------------------------------------------------------- | ----------------------------------------------- |
| **Browser** | Classic console at `/`, redesigned console at `/v3`, desktop app | [guides/browser.md](docs/guides/browser.md)     |
| **CLI**     | Interactive REPL, JSON-lines mode, `analyze` reports             | [reference/cli.md](docs/reference/cli.md)       |
| **Daemon**  | Long-running Socket.IO control plane, multi-CP, MCP endpoint     | [reference/server.md](docs/reference/server.md) |
| **Docker**  | Pre-built image (daemon + web console) on GHCR                   | [guides/docker.md](docs/guides/docker.md)       |

## Quick start

```bash
# Browser UI from a checkout
npm install && npm run dev

# CLI: install the released binary tarball globally (requires Bun)
pnpm install -g https://github.com/shiv3/ocpp-cp-simulator/releases/latest/download/ocpp-cp-simulator.tgz

# Daemon + bundled web console on one port, pointed at your CSMS
ocpp-cp-sim --http-port 5172 --web-console \
            --cp-id CP001 --connectors 2 \
            --ws-url wss://csms.example.com/ocpp/
```

More install options (bun, pinned releases, `bun link`), first-run recipes, Docker, and reverse-proxy notes: [docs/getting-started.md](docs/getting-started.md).

## Drive it from agents and scripts

The daemon is a scriptable OCPP stub: one Socket.IO connection (or `POST /mcp` for MCP clients such as Claude Code) controls charge points, scenarios, and logs; every event streams back in real time.

```bash
ocpp-cp-sim --http-port 5172 --cp-id CP001 --ws-url wss://your-csms/ocpp/ \
            --state-db ./state.db --log-format json
node docs/examples/automation/agent.mjs
```

Runnable Node/Python/MCP/Testcontainers examples: [docs/guides/automation.md](docs/guides/automation.md).

## Scenarios

Declare a full charging flow (or fault injection, reservations, certification steps) as a JSON graph, run it from any interface, and assert on the captured OCPP transcript. Format: [reference/scenario-format.md](docs/reference/scenario-format.md) · Library: [docs/examples/scenarios/](docs/examples/scenarios/).

## Documentation

- **[Getting started](docs/getting-started.md)** — install, first runs, Docker
- **[Features](docs/features.md)** — the full capability list with doc links
- **[Docs index](docs/README.md)** — all guides and reference pages

Persistence (SQLite in both browser and daemon), local-vs-remote mode detection, reverse-proxy/CORS setup, and the SOAP/security-profile deep dives all live in the docs tree above.

## Contributing

See `AGENTS.md` for repository guidelines (project layout, required commands, PR expectations).
