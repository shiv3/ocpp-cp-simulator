# OCPP CP Simulator

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/shiv3/ocpp-cp-simulator)

OCPP 1.6J charge point simulator for **AI agent testing**, CI automation, and CSMS development. Comes with a browser UI, a headless CLI, and a Socket.IO control API that any agent or script can drive.

| Interface     | Description                                         | Docs                               |
| ------------- | --------------------------------------------------- | ---------------------------------- |
| **Browser**   | React + Tailwind web app / Tauri desktop app        | [docs/browser.md](docs/browser.md) |
| **Legacy v1** | Original single-page web UI                         | [docs/v1.md](docs/v1.md)           |
| **CLI**       | Headless mode for scripting, CI, and AI integration | [docs/cli.md](docs/cli.md)         |
| **Server**    | Long-running Socket.IO server, multi-CP per process | [docs/server.md](docs/server.md)   |
| **Docker**    | Pre-built image (daemon + web console) on GHCR      | [docs/docker.md](docs/docker.md)   |

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

`--web-console` serves the browser UI (built into `dist/` and shipped inside the release tarball) from the same HTTP port as the Socket.IO control plane, so a single port is all you need to expose. See [docs/cli.md](docs/cli.md) for the full flag reference and [docs/server.md](docs/server.md) for the Socket.IO protocol.

> **Behind a reverse proxy?** Bound to a non-loopback host the daemon applies a safe same-origin CORS policy, so the web console served at a public URL will `403` its own assets until you name that origin with `--cors-origin https://your.url` (or, behind a trusted proxy, `--trust-forwarded-headers`). See [docs/server.md → Behind a reverse proxy](docs/server.md#behind-a-reverse-proxy-traefik-nginx-caddy-) for details and an nginx + Authelia example compose.

### SOAP Versions (1.2, 1.5, 1.6S)

OCPP 1.2, 1.5, and 1.6 (SOAP) all use SOAP 1.2 / WS-Addressing over HTTP (not WebSocket).
The browser UI can run them in **send-only mode** (CP→CSMS calls work; CSMS-initiated commands
like RemoteStart and Reset are unavailable since the browser can't host the callback endpoint).
Full bidirectional SOAP remains **CLI / server-mode only**. Point `--ws-url` at the CSMS
_CentralSystemService_ URL and give the callback URL the CSMS should reach the charge point on:

**OCPP 1.2:**

```bash
bun src/cli/main.ts \
  --cp-id CP-001 --ocpp-version OCPP-1.2 \
  --ws-url http://csms-host:8180/services/CentralSystemService \
  --soap-callback-url http://this-host:9700/ocpp/soap/CP-001/ChargePointService \
  --json
```

OCPP 1.2 has a narrower message surface: no DataTransfer, GetConfiguration,
LocalAuthList, or Reservation messages; status values are limited to a 4-value set.

**OCPP 1.5:**

```bash
bun src/cli/main.ts \
  --cp-id CP-001 --ocpp-version OCPP-1.5 \
  --ws-url http://csms-host:8180/steve/services/CentralSystemService \
  --soap-callback-url http://this-host:9700/ocpp/soap/CP-001/ChargePointService \
  --json
```

**OCPP 1.6 (SOAP):**

```bash
bun src/cli/main.ts \
  --cp-id CP-001 --ocpp-version OCPP-1.6S \
  --ws-url http://csms-host:8180/steve/services/CentralSystemService \
  --soap-callback-url http://this-host:9700/ocpp/soap/CP-001/ChargePointService \
  --json
```

OCPP 1.6S supports the full 1.6 message set including TriggerMessage and
charging profiles.

All SOAP versions share the same endpoint pattern:

- **CP → CSMS**: BootNotification, Heartbeat, StatusNotification, Authorize,
  Start/StopTransaction, MeterValues.
- **CSMS → CP**: the daemon hosts `POST <soap-path>/:cpId/ChargePointService`
  (default `--soap-path /ocpp/soap`); slice-1 handles **Reset** and other call-ins.
  The endpoint relies on the daemon's `--web-console-basic-auth-*` gate or a trusted
  network boundary — OCPP-S has no per-message authentication field.

Pairs with [SteVe](https://github.com/steve-community/steve) (register charge points
with protocol `ocpp1.2S`, `ocpp1.5S`, or `ocpp1.6S`, status Accepted).

## OCPP 1.6 Security Profiles

CLI/server mode supports the OCPP 1.6 Security Whitepaper transport profiles:

| Profile | Transport | Authentication / certificates                                                     |
| ------- | --------- | --------------------------------------------------------------------------------- |
| `1`     | `ws://`   | HTTP Basic Auth with CP ID as the username and `AuthorizationKey` as the password |
| `2`     | `wss://`  | Profile 1 plus CSMS server certificate verification (`--tls-ca` for private CAs)  |
| `3`     | `wss://`  | Mutual TLS with `--tls-cert` + `--tls-key`; Basic Auth is disabled                |

Profiles 2/3 and TLS certificate files are available in CLI/server mode only, not browser local mode.

- `--security-profile <0|1|2|3>` selects transport security enforcement; `0` leaves transport/auth as configured.
- `--authorization-key <hex>` sets the `AuthorizationKey` used as the Basic Auth password for profiles 1 and 2.
- `--tls-ca <path>` loads a PEM CA bundle used to verify the CSMS server certificate.
- `--tls-cert <path>` loads the PEM client certificate for profile 3 mutual TLS.
- `--tls-key <path>` loads the PEM client private key for profile 3 mutual TLS; the file must be mode `0600`.
- `--cpo-name <name>` sets the CPO name used when generating certificate signing requests.
- `--insecure-tls-key-perms` allows a `--tls-key` file readable by group/other for local testing.

```bash
# Profile 1: ws + Basic Auth against SteVe
ocpp-cp-sim --ws-url ws://localhost:8080/steve/websocket/CentralSystemService/ \
            --cp-id CP001 --security-profile 1 \
            --authorization-key 0123456789abcdef

# Profile 2: wss + CSMS CA + Basic Auth
ocpp-cp-sim --ws-url wss://steve.example.com/steve/websocket/CentralSystemService/ \
            --cp-id CP001 --security-profile 2 \
            --authorization-key 0123456789abcdef \
            --tls-ca ./certs/csms-ca.pem

# Profile 3: wss mutual TLS
chmod 600 ./certs/cp001.key
ocpp-cp-sim --ws-url wss://steve.example.com/steve/websocket/CentralSystemService/ \
            --cp-id CP001 --security-profile 3 \
            --tls-ca ./certs/csms-ca.pem \
            --tls-cert ./certs/cp001.crt \
            --tls-key ./certs/cp001.key \
            --cpo-name "Example CPO"
```

Security extension configuration keys include `SecurityProfile`, `AuthorizationKey`, `AdditionalRootCertificateCheck`, `CertificateSignedMaxChainSize`, `CertificateStoreMaxLength`, and `CpoName`. The simulator can send `SecurityEventNotification` and `SignCertificate`, handle inbound `CertificateSigned`, and exposes JSON-mode RPC commands `security_event_notification` and `sign_certificate`.

## AI Agent & Automation Testing

The daemon exposes a single Socket.IO control connection and emits structured logs, making it a scriptable OCPP stub that any AI agent or test harness can drive.

| Feature                              | What it enables                                                 |
| ------------------------------------ | --------------------------------------------------------------- |
| `--log-format json`                  | One JSON object per line — easy to parse or feed to an LLM      |
| Socket.IO `rpc` event                | Send OCPP commands from any language or agent                   |
| Scenario templates (JSON)            | Declare a full charging flow, inject at runtime without restart |
| Socket.IO `event` push + rooms       | Subscribe to real-time OCPP events for assertions               |
| `GET /v1/healthz`                    | Unauthenticated local/remote detection and Docker healthcheck   |
| `--state-db`                         | Persist CP state across restarts — no re-bootstrap needed       |
| `socket.io-client` + `zod` contracts | Use the same typed contract as the browser UI and CLI           |

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

Prefer not to write a client? The same `ocpp-cp-sim` binary doubles as a TCP Socket.IO client for a running daemon — `--send` a CP command, `--stop` it, or `--events` to stream. It targets `http://127.0.0.1:9700` by default or a custom `--http-url`. If the daemon is gated with `--web-console-basic-auth-*`, authenticate with `--http-basic-auth-user/pass`. See [docs/server.md → Controlling a running daemon from the CLI](docs/server.md#controlling-a-running-daemon-from-the-cli).

See [docs/server.md](docs/server.md) for the full Socket.IO API reference and [docs/migration.md](docs/migration.md) for the REST/Unix migration guide.

## Persistence

Both the browser UI and the daemon back their state with SQLite — sql.js + IndexedDB in the browser, `bun:sqlite` (via `--state-db <path>`) in the daemon. Scenarios, ChangeConfiguration overrides, charging profiles, availability flags, pending transaction messages, the daemon's CP registry and logs all survive reload / restart. See [docs/server.md → State persistence](docs/server.md#state-persistence).

## Local vs Remote mode (browser)

The browser UI auto-detects which mode to run in by probing `/v1/healthz` at its own origin (path configurable, see [docs/server.md → Health](docs/server.md#health)):

- Served by `ocpp-cp-sim --web-console`, the Docker image, or the **Tauri desktop app** (which bundles the daemon as a sidecar) → **Remote**: every operation uses the daemon's Socket.IO control plane.
- Static build (GitHub Pages, `bun run dev`) → **Local**: charge points run entirely in-browser, persistence via sql.js.

There is no toggle — the mode is decided once on page load and never overridden.

## Doc

https://deepwiki.com/shiv3/ocpp-cp-simulator

## Contributing

Review `AGENTS.md` for repository guidelines covering project layout, required commands, and pull request expectations.
