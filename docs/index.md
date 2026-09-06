---
title: Index
type: index
summary: Catalog of every page in the wiki with a one-line summary, by category. Read this first when answering a question.
updated: 2026-09-05
---

# Index

Start at [Overview](overview.md). Conventions for pages are in
[Conventions](conventions.md); the maintenance schema is
[`CLAUDE.md`](../CLAUDE.md); recent activity is in [Log](log.md).

## Entities (`entities/`)

| Page                                                          | Summary                                                                                                                             |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [CLI (`ocpp-cp-sim`)](entities/cli.md)                        | Headless Bun binary — REPL, JSON Lines, daemon launcher, client modes, install / packaging, `export-k6`, full flag reference        |
| [analyze subcommand](entities/analyze.md)                     | DebugKit failure-pattern reports from a trace file or a live daemon; per-CP / per-connector splitting; excluded records; disclaimer |
| [Daemon (server mode)](entities/daemon.md)                    | Long-lived multi-CP process: starting, flags, HTTP surfaces, health endpoint, security posture, limits                              |
| [Web console](entities/web-console.md)                        | React browser UI at `/`, `/v3`, `/v1`; Local vs Remote; what it can do; dev commands                                                |
| [Desktop app (Tauri)](entities/desktop-app.md)                | Tauri bundle running the daemon as a sidecar; installers per OS; state location; dev/build                                          |
| [Legacy v1 UI](entities/legacy-v1-ui.md)                      | Original single-page UI at `/v1`; URL-hash presets; experimental multi-charger mode                                                 |
| [Docker image](entities/docker-image.md)                      | `ghcr.io/shiv3/ocpp-cp-simulator`: tags, `/data` volume, compose variables, structured logs, custom health path                     |
| [MCP endpoint](entities/mcp-endpoint.md)                      | `POST /mcp` tools-only MCP server: 19 curated + 3 network-sim tools, `list_methods` / `call_method`, limits                         |
| [Built-in scenario templates](entities/scenario-templates.md) | Six general templates + 47 `cert16-*` certification templates + OCTT probe; where they are used; instance semantics                 |
| [CSMS peers](entities/csms-peers.md)                          | SteVe (SOAP, security profiles, steve-verify) and gocpp (e2e) — URL conventions and known quirks                                    |
| [OCPP DebugKit](entities/ocpp-debugkit.md)                    | The pinned third-party analysis engine behind `analyze`; version policy; limits                                                     |

## Concepts (`concepts/`)

| Page                                                                     | Summary                                                                                                                    |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| [Socket.IO control plane](concepts/control-plane.md)                     | The `rpc` / `event` contract: CP command methods, daemon methods, rooms and snapshots, error codes, end-to-end example     |
| [Scenario file format (v1.2)](concepts/scenario-format.md)               | Node-graph JSON: 23 node types, triggers, assertions and the two-axis verdict, template instances, versioning, changelog   |
| [OCPP trace format (v1.1)](concepts/trace-format.md)                     | Implementation-independent JSONL record per OCPP exchange; JSON Schema; producing records from logs                        |
| [State persistence](concepts/state-persistence.md)                       | SQLite schema shared by daemon (`--state-db`) and browser (sql.js); table catalog; `state.reset`                           |
| [Log format](concepts/log-format.md)                                     | One log-line shape across stderr, `logs` table, browser download and `logs.get`; newest-first `limit` windowing; retention |
| [Network simulation](concepts/network-simulation.md)                     | Seeded latency / disconnect fault injection; layering and null semantics; RPC methods; timer behaviors; limitations        |
| [Access control](concepts/access-control.md)                             | Bind gate, Basic Auth gate, CORS policy table, reverse-proxy 403 fix (`--cors-origin` / `--trust-forwarded-headers`)       |
| [OCPP versions and transports](concepts/ocpp-versions-and-transports.md) | 1.6J / 2.0.1 / 2.1 over WebSocket and 1.2 / 1.5 / 1.6S over SOAP; callback URL precedence; per-surface support             |
| [OCPP 1.6 security profiles](concepts/security-profiles.md)              | Profiles 1–3, TLS flags, SteVe examples, security extension messages and keys                                              |
| [Local vs Remote mode](concepts/local-vs-remote-mode.md)                 | How the browser picks in-tab vs daemon operation via the health probe, and what differs                                    |

## Sources (`sources/`)

| Page                                                                            | Summary                                                                                               |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [schema/scenario.schema.json](sources/scenario-json-schema.md)                  | Published scenario JSON Schema v1.1 — strict on known fields, permissive on unknown, advisory at load |
| [vendor/ocpp-schemas](sources/vendored-ocpp-schemas.md)                         | OCA OCPP 1.6 / 2.0.1 / 2.1 message schemas, vendored verbatim at a pinned commit; never modify        |
| [docs/examples/scenarios](sources/example-scenarios.md)                         | `demo-charging.json` (lifecycle demo) and `all-cases.json` (node-type catalogue, cross-version e2e)   |
| [Reverse-proxy + SSO example](sources/reverse-proxy-sso-example.md)             | nginx + Authelia compose showing `--trust-forwarded-headers` behind a proxy                           |
| [e2e/README.md](sources/e2e-readme.md)                                          | Local-only gocpp CSMS e2e suite across 1.6 / 2.0.1 / 2.1                                              |
| [scripts/steve-verify/README.md](sources/steve-verify-readme.md)                | Runner verifying all 47 cert16 templates against real SteVe via REST, with capability probe           |
| [examples/testcontainers-java/README.md](sources/testcontainers-java-readme.md) | JVM Testcontainers prototype driving the control plane and asserting a verdict                        |
| [scripts/poc/README.md](sources/socketio-bun-poc.md)                            | The socket.io-on-Bun PoC that gated the control-plane design (8/8 checks PASS)                        |
| [src/utils/scenarios/README.md](sources/cert16-templates-readme.md)             | Authoritative cert16 ↔ test-case mapping, side effects, responseOverride matrix, out-of-scope list    |
| [GitHub issues](sources/github-issues.md)                                       | Index of issue / PR numbers the wiki cites, with the pages that cite them                             |

## Analyses (`analyses/`)

| Page                                                                                      | Summary                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Choosing an interface](analyses/choosing-an-interface.md)                                | Use-case → interface table and a feature-coverage matrix across web / desktop / daemon / CLI                                                                              |
| [Driving from an AI agent](analyses/driving-from-an-ai-agent.md)                          | Feature checklist, minimal setup, MCP vs CLI vs socket.io-client, assertion patterns                                                                                      |
| [REST → Socket.IO migration](analyses/rest-to-socketio-migration.md)                      | Endpoint-by-endpoint mapping from the removed REST / WebSocket / Unix-socket control surface                                                                              |
| [Testing strategy](analyses/testing-strategy.md)                                          | Vitest vs Bun test, merged coverage, and the e2e / steve-verify / Testcontainers layers                                                                                   |
| [Fleet, load and observability roadmap](analyses/fleet-load-and-observability-roadmap.md) | Sequenced plan for fleet-scale work: bulk create and blueprints, `/metrics`, seeded background traffic, charging-curve meter values, a measured scale ceiling, hot-reload |

## Raw assets kept under `docs/`

- `docs/examples/` — scenario JSON and reverse-proxy examples (raw layer; summarized above).
- `docs/images/` — screenshots referenced by pages and the README.
