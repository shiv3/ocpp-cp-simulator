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

## Doc

https://deepwiki.com/shiv3/ocpp-cp-simulator

## Contributing

Review `AGENTS.md` for repository guidelines covering project layout, required commands, and pull request expectations.
