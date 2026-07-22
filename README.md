# OCPP CP Simulator

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/shiv3/ocpp-cp-simulator)

OCPP 1.6J charge point simulator for **AI agent testing**, CI automation, and CSMS development. Comes with a browser UI, a headless CLI, and a Socket.IO control API that any agent or script can drive.

| Interface       | Description                                            | Docs                                                 |
| --------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| **Browser**     | Classic console (default, at `/`) / Tauri desktop app  | [docs/guides/browser.md](docs/guides/browser.md)     |
| **New console** | Redesigned console (React + Tailwind), served at `/v3` | [docs/guides/browser.md](docs/guides/browser.md)     |
| **Legacy v1**   | Original single-page web UI, served at `/v1`           | [docs/guides/legacy-v1.md](docs/guides/legacy-v1.md) |
| **CLI**         | Headless mode for scripting, CI, and AI integration    | [docs/reference/cli.md](docs/reference/cli.md)       |
| **Server**      | Long-running Socket.IO server, multi-CP per process    | [docs/reference/server.md](docs/reference/server.md) |
| **Docker**      | Pre-built image (daemon + web console) on GHCR         | [docs/guides/docker.md](docs/guides/docker.md)       |

![Web console — connector panel, scenario editor, and real-time logs](docs/images/web-console-overview.png)

## Quick Start

```bash
# Install dependencies
npm install

# Browser UI (dev server)
npm run dev

# CLI / Server mode (requires Bun)
ocpp-cp-sim --ws-url ws://localhost:9000/ocpp --cp-id CP001
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

# Headless daemon (Socket.IO control API only)
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

`--web-console` serves the browser UI (built into `dist/` and shipped inside the release tarball) from the same HTTP port as the Socket.IO control plane, so a single port is all you need to expose. See [docs/reference/cli.md](docs/reference/cli.md) for the full flag reference and [docs/reference/server.md](docs/reference/server.md) for the Socket.IO protocol.

> **Behind a reverse proxy?** Bound to a non-loopback host the daemon applies a safe same-origin CORS policy, so the web console served at a public URL will `403` its own assets until you name that origin with `--cors-origin https://your.url` (or, behind a trusted proxy, `--trust-forwarded-headers`). See [docs/reference/server.md → Behind a reverse proxy](docs/reference/server.md#behind-a-reverse-proxy-traefik-nginx-caddy-) for details and an nginx + Authelia example compose.

> **SOAP versions (1.2 / 1.5 / 1.6S):** full bidirectional SOAP from the CLI/daemon, send-only in the browser — see [docs/guides/soap.md](docs/guides/soap.md).
> **OCPP 1.6 security profiles 1–3:** Basic Auth, server-cert verification, mutual TLS — see [docs/guides/security-profiles.md](docs/guides/security-profiles.md).

## AI Agent & Automation Testing

The daemon exposes a single Socket.IO control connection and emits structured logs, making it a scriptable OCPP stub that any AI agent or test harness can drive.

| Feature                              | What it enables                                                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `--log-format json`                  | One JSON object per line — easy to parse or feed to an LLM                                                                                     |
| Socket.IO `rpc` event                | Send OCPP commands from any language or agent                                                                                                  |
| `POST /mcp` endpoint                 | Drive the simulator via MCP clients (Claude Code, etc.) — see [docs/reference/server.md § MCP Endpoint](docs/reference/server.md#mcp-endpoint) |
| Scenario templates (JSON)            | Declare a full charging flow, inject at runtime without restart                                                                                |
| Socket.IO `event` push + rooms       | Subscribe to real-time OCPP events for assertions                                                                                              |
| `GET /v1/healthz`                    | Unauthenticated local/remote detection and Docker healthcheck                                                                                  |
| `--state-db`                         | Persist CP state across restarts — no re-bootstrap needed                                                                                      |
| `socket.io-client` + `zod` contracts | Use the same typed contract as the browser UI and CLI                                                                                          |

**Minimal setup for an AI agent:**

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

Prefer not to write a client? The same `ocpp-cp-sim` binary doubles as a TCP Socket.IO client for a running daemon — `--send` a CP command, `--stop` it, or `--events` to stream. It targets `http://127.0.0.1:9700` by default or a custom `--http-url`. If the daemon is gated with `--web-console-basic-auth-*`, authenticate with `--http-basic-auth-user/pass`. See [docs/reference/server.md → Controlling a running daemon from the CLI](docs/reference/server.md#controlling-a-running-daemon-from-the-cli).

See [docs/reference/server.md](docs/reference/server.md) for the full Socket.IO API reference and [docs/guides/migration.md](docs/guides/migration.md) for the REST/Unix migration guide.

## Persistence

Both the browser UI and the daemon back their state with SQLite — sql.js + IndexedDB in the browser, `bun:sqlite` (via `--state-db <path>`) in the daemon. Scenarios, ChangeConfiguration overrides, charging profiles, availability flags, pending transaction messages, the daemon's CP registry and logs all survive reload / restart. See [docs/reference/server.md → State persistence](docs/reference/server.md#state-persistence).

## Web console layout

The browser app serves the UIs under distinct route prefixes from the same origin:

- **`/`** — the classic console (the default). Also reachable at **`/v2`** for backward-compatible bookmarks.
- **`/v3`** — the redesigned console: a fleet of **Charge Points**, per-charge-point detail (`/v3/cp/:id`), a cross-CP **Scenario library** with a linear step editor and a separate run console (`/v3/scenarios`), and a global **Message log** (`/v3/logs`).
- **`/v1`** — the original single-page UI (maintenance only).

The two consoles link to each other with a design switcher (the classic navbar's **New design** button ↔ the redesigned sidebar's **Switch to classic design** button).

The redesign reuses the existing data layer, scenario engine, and per-step forms unchanged; scenarios, charge points, and logs are simply promoted to first-class routes instead of nested panels.

## Local vs Remote mode (browser)

The browser UI auto-detects which mode to run in by probing `/v1/healthz` at its own origin (path configurable, see [docs/reference/server.md → Health](docs/reference/server.md#health)):

- Served by `ocpp-cp-sim --web-console`, the Docker image, or the **Tauri desktop app** (which bundles the daemon as a sidecar) → **Remote**: every operation uses the daemon's Socket.IO control plane.
- Static build (GitHub Pages, `bun run dev`) → **Local**: charge points run entirely in-browser, persistence via sql.js.

There is no toggle — the mode is decided once on page load and never overridden.

## Doc

https://deepwiki.com/shiv3/ocpp-cp-simulator

## Contributing

Review `AGENTS.md` for repository guidelines covering project layout, required commands, and pull request expectations.
