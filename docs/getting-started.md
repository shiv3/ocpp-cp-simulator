# Getting Started

## Prerequisites

- **Browser UI (dev server):** Node.js + npm
- **CLI / daemon:** the [Bun](https://bun.sh/) runtime

## Run the browser UI

```bash
npm install
npm run dev
```

Charge points run entirely in-browser (local mode) with sql.js persistence — no daemon needed. See [guides/browser.md](guides/browser.md).

## Install the CLI (`ocpp-cp-sim`)

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

## First runs

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

`--web-console` serves the browser UI (built into `dist/` and shipped inside the release tarball) from the same HTTP port as the Socket.IO control plane, so a single port is all you need to expose. See [reference/cli.md](reference/cli.md) for the full flag reference and [reference/server.md](reference/server.md) for the Socket.IO protocol.

> **Behind a reverse proxy?** Bound to a non-loopback host the daemon applies a safe same-origin CORS policy, so the web console served at a public URL will `403` its own assets until you name that origin with `--cors-origin https://your.url` (or, behind a trusted proxy, `--trust-forwarded-headers`). See [reference/server.md → Behind a reverse proxy](reference/server.md#behind-a-reverse-proxy-traefik-nginx-caddy-) for details and an nginx + Authelia example compose.

## Run with Docker

```bash
# Pull the latest published image
docker pull ghcr.io/shiv3/ocpp-cp-simulator:latest

# Run with an ephemeral state DB (state wiped on container exit)
docker run --rm -p 9700:9700 \
  -e STATE_DB=:memory: \
  ghcr.io/shiv3/ocpp-cp-simulator:latest \
  --cp-id CP001 --connectors 2 \
  --ws-url wss://example.invalid/chargepoint/

# Open the bundled UI
open http://localhost:9700/
```

See [guides/docker.md](guides/docker.md) for image tags, persistent state, compose, and health checks.

## Next steps

- [features.md](features.md) — everything the simulator can do, with doc links
- [guides/browser.md](guides/browser.md) — web console tour, desktop app, local vs remote mode
- [guides/automation.md](guides/automation.md) — drive the simulator from agents and scripts
- [reference/cli.md](reference/cli.md) — every flag, REPL/JSON modes, `analyze` reports
- [reference/server.md](reference/server.md) — Socket.IO RPC, MCP endpoint, persistence
