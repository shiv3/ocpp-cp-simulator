# OCPP CP Simulator

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/shiv3/ocpp-cp-simulator)

OCPP 1.6J charge point simulator for **AI agent testing**, CI automation, and CSMS development. Comes with a browser UI, a headless CLI, and an HTTP control API that any agent or script can drive.

| Interface     | Description                                              | Docs                               |
| ------------- | -------------------------------------------------------- | ---------------------------------- |
| **Browser**   | React + Tailwind web app / Tauri desktop app             | [docs/browser.md](docs/browser.md) |
| **Legacy v1** | Original single-page web UI                              | [docs/v1.md](docs/v1.md)           |
| **CLI**       | Headless mode for scripting, CI, and AI integration      | [docs/cli.md](docs/cli.md)         |
| **Server**    | Long-running HTTP/WebSocket server, multi-CP per process | [docs/server.md](docs/server.md)   |
| **Docker**    | Pre-built image (daemon + web console) on GHCR           | [docs/docker.md](docs/docker.md)   |

![Web console — connector panel, scenario editor, and real-time logs](docs/images/web-console-overview.png)

## Quick Start

```bash
# Install dependencies
npm install

# Browser UI (dev server)
npm run dev

# CLI / Server mode (requires Bun)
bun src/cli/main.ts --ws-url ws://localhost:9000/ocpp --cp-id CP001
```

### Install as a global command (`ocpp-cp-sim`)

```bash
# pnpm (recommended)
pnpm install -g https://github.com/shiv3/ocpp-cp-simulator/releases/latest/download/ocpp-cp-simulator.tgz

# bun
bun install -g https://github.com/shiv3/ocpp-cp-simulator/releases/latest/download/ocpp-cp-simulator.tgz

# Or pin to a specific CLI release
bun install -g https://github.com/shiv3/ocpp-cp-simulator/releases/download/cli-v0.1.0/ocpp-cp-simulator-0.1.0.tgz

# From a local checkout
bun link              # in this repo
bun link ocpp-cp-simulator   # in any other project
```

> The release tarballs are produced by the `Release CLI` workflow on `cli-v*` tags. A bare `bun install -g github:shiv3/ocpp-cp-simulator` does **not** work — `dist/` is built at release time, not committed, and bun doesn't install devDependencies for global packages so the on-install `vite build` can't run.

Then run from anywhere:

```bash
# Interactive REPL against a CSMS
ocpp-cp-sim --ws-url ws://localhost:9000/ocpp --cp-id CP001

# Headless daemon (HTTP/WS control API only)
ocpp-cp-sim --daemon --http-port 9700

# Daemon + bundled browser UI on the same origin
#   open http://127.0.0.1:5172 to drive the daemon from the web console
ocpp-cp-sim --http-port 5172 --web-console \
            --cp-id CP001 --connectors 2 \
            --ws-url wss://csms.example.com/ocpp/

# Full kitchen-sink: persistent SQLite, JSON-line logs, demo scenario auto-loaded
ocpp-cp-sim --http-port 5172 --web-console \
            --cp-id CP001 --connectors 5 \
            --ws-url wss://csms.example.com/ocpp/ \
            --scenario-template-file docs/examples/scenarios/demo-charging.json \
            --scenario-connector all \
            --state-db ./state.db --log-format json
```

`--web-console` serves the browser UI (built into `dist/` and shipped inside the release tarball) from the same HTTP port as the control API, so a single port is all you need to expose. See [docs/cli.md](docs/cli.md) for the full flag reference and [docs/server.md](docs/server.md) for the HTTP / WebSocket protocol.

## AI Agent & Automation Testing

The daemon exposes an HTTP/WebSocket control API and emits structured logs, making it a scriptable OCPP stub that any AI agent or test harness can drive.

| Feature                                     | What it enables                                                 |
| ------------------------------------------- | --------------------------------------------------------------- |
| `--log-format json`                         | One JSON object per line — easy to parse or feed to an LLM      |
| HTTP REST API (`POST /v1/cp/:cpId/command`) | Send OCPP commands from any language or agent                   |
| Scenario templates (JSON)                   | Declare a full charging flow, inject at runtime without restart |
| `WS /v1/cp/:cpId/events`                    | Subscribe to real-time OCPP events for assertions               |
| `--state-db`                                | Persist CP state across restarts — no re-bootstrap needed       |

**Minimal setup for an AI agent:**

```bash
# 1. Start daemon with structured logs
ocpp-cp-sim --http-port 5172 --cp-id CP001 --connectors 1 \
            --ws-url wss://your-csms/ocpp/ \
            --state-db ./state.db --log-format json

# 2. Trigger a transaction (agent POSTs this)
curl -X POST http://127.0.0.1:5172/v1/cp/CP001/command \
     -H 'Content-Type: application/json' \
     -d '{"command":"start_transaction","params":{"connector":1,"tagId":"TAG001"}}'

# 3. Stream events back to the agent
wscat -c ws://127.0.0.1:5172/v1/cp/CP001/events
```

See [docs/server.md](docs/server.md) for the full HTTP API reference.

## Persistence

Both the browser UI and the daemon back their state with SQLite — sql.js + IndexedDB in the browser, `bun:sqlite` (via `--state-db <path>`) in the daemon. Scenarios, ChangeConfiguration overrides, charging profiles, availability flags, pending transaction messages, the daemon's CP registry and logs all survive reload / restart. See [docs/server.md → State persistence](docs/server.md#state-persistence).

## Local vs Remote mode (browser)

The browser UI auto-detects which mode to run in by probing `/v1/healthz` at its own origin (path configurable, see [docs/server.md → Health](docs/server.md#health)):

- Served by `ocpp-cp-sim --web-console`, the Docker image, or the **Tauri desktop app** (which bundles the daemon as a sidecar) → **Remote**: every operation is proxied to the daemon over HTTP/WS.
- Static build (GitHub Pages, `bun run dev`) → **Local**: charge points run entirely in-browser, persistence via sql.js.

There is no toggle — the mode is decided once on page load and never overridden.

## Doc

https://deepwiki.com/shiv3/ocpp-cp-simulator

## Contributing

Review `AGENTS.md` for repository guidelines covering project layout, required commands, and pull request expectations.
