# OCPP CP Simulator

OCPP 1.6J charge point simulator with three interfaces: a browser-based UI, a legacy web version (v1), and a headless CLI for automation.

| Interface     | Description                                              | Docs                               |
| ------------- | -------------------------------------------------------- | ---------------------------------- |
| **Browser**   | React + Tailwind web app / Tauri desktop app             | [docs/browser.md](docs/browser.md) |
| **Legacy v1** | Original single-page web UI                              | [docs/v1.md](docs/v1.md)           |
| **CLI**       | Headless mode for scripting, CI, and AI integration      | [docs/cli.md](docs/cli.md)         |
| **Server**    | Long-running HTTP/WebSocket server, multi-CP per process | [docs/server.md](docs/server.md)   |
| **Docker**    | Pre-built image (daemon + web console) on GHCR           | [docs/docker.md](docs/docker.md)   |

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
# Prebuilt release tarball (includes the web-console bundle in dist/)
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
ocpp-cp-sim --ws-url ws://localhost:9000/ocpp --cp-id CP001
ocpp-cp-sim --daemon --http-port 9700        # server mode

# Daemon with persistent state + structured logs
ocpp-cp-sim --daemon --http-port 9700 \
            --state-db ./state.db --log-format json
```

## Persistence

Both the browser UI and the daemon back their state with SQLite — sql.js + IndexedDB in the browser, `bun:sqlite` (via `--state-db <path>`) in the daemon. Scenarios, ChangeConfiguration overrides, charging profiles, availability flags, pending transaction messages, the daemon's CP registry and logs all survive reload / restart. See [docs/server.md → State persistence](docs/server.md#state-persistence).

## Local vs Remote mode (browser)

The browser UI auto-detects which mode to run in by probing `/healthz` at its own origin:

- Served by `ocpp-cp-sim --web-console` (or the Docker image) → **Remote**: every operation is proxied to the daemon over HTTP/WS.
- Static build (GitHub Pages, `bun run dev`, Tauri) → **Local**: charge points run entirely in-browser, persistence via sql.js.

There is no toggle — the mode is decided once on page load and never overridden.

## Doc

https://deepwiki.com/shiv3/ocpp-cp-simulator

## Contributing

Review `AGENTS.md` for repository guidelines covering project layout, required commands, and pull request expectations.
