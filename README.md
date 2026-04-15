# OCPP CP Simulator

OCPP 1.6J charge point simulator with three interfaces: a browser-based UI, a legacy web version (v1), and a headless CLI for automation.

| Interface     | Description                                         | Docs                               |
| ------------- | --------------------------------------------------- | ---------------------------------- |
| **Browser**   | React + Tailwind web app / Tauri desktop app        | [docs/browser.md](docs/browser.md) |
| **Legacy v1** | Original single-page web UI                         | [docs/v1.md](docs/v1.md)           |
| **CLI**       | Headless mode for scripting, CI, and AI integration | [docs/cli.md](docs/cli.md)         |

## Quick Start

```bash
# Install dependencies
npm install

# Browser UI (dev server)
npm run dev

# CLI mode (requires Bun)
bun src/cli/main.ts --ws-url ws://localhost:9000/ocpp --cp-id CP001
```

**With this monorepo’s `apps/ocpp-csms`:** use a **trailing slash** on `--ws-url`. **CLI (Bun)** sends **HTTP Basic** via `--basic-auth-user` / `--basic-auth-pass`. The **browser UI** cannot send Basic on WebSocket; the simulator appends `?ocpp_ws_secret=…` when Basic auth is enabled, which the CSMS accepts by default (`CSMS_OCPP_CP_QUERY_PASSWORD_PARAM`). Example CLI:

`bun src/cli/main.ts --ws-url ws://127.0.0.1:9000/ocpp/ --cp-id CP001 --basic-auth-user CP001 --basic-auth-pass dev-cp-secret`

## Doc

https://deepwiki.com/shiv3/ocpp-cp-simulator

## Contributing

Review `AGENTS.md` for repository guidelines covering project layout, required commands, and pull request expectations.
