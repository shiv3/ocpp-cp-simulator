---
title: Choosing an interface
type: analysis
summary: Side-by-side of the six ways to run the simulator — hosted web console, desktop app, CLI REPL / JSON, daemon, Docker image, MCP — by use case, feature coverage and operational footprint.
sources:
  - README.md
  - synthesized from the entity pages
related:
  - ../entities/web-console.md
  - ../entities/desktop-app.md
  - ../entities/cli.md
  - ../entities/daemon.md
  - ../entities/docker-image.md
  - ../entities/mcp-endpoint.md
  - ../concepts/local-vs-remote-mode.md
updated: 2026-09-03
---

# Choosing an interface

| You want to…                                               | Use                                                                             | Why                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Poke a CSMS by hand with zero install                      | [Web console](../entities/web-console.md) on GitHub Pages (Local mode)          | Runs in the tab, persists to IndexedDB; OCPP-J 1.6J/2.0.1/2.1, SOAP send-only                      |
| Same, but with the full daemon feature set on a laptop     | [Desktop app](../entities/desktop-app.md)                                       | Bundles the daemon as a sidecar → Remote mode UX, no Bun/Node needed                               |
| Script one charge point from a shell or CI job             | [CLI](../entities/cli.md) REPL or `--json`                                      | stdin/stdout JSON Lines, exit codes, `--trace-output`                                              |
| Host many charge points and drive them programmatically    | [Daemon](../entities/daemon.md) + [Control plane](../concepts/control-plane.md) | One Socket.IO connection per client, rooms/events, `--state-db`, scenarios injected at runtime     |
| Ship it into a Kubernetes / compose / Testcontainers setup | [Docker image](../entities/docker-image.md)                                     | Daemon + web console on one port, `/data` volume, healthcheck, semver tags                         |
| Let an LLM agent operate it as a tool                      | [MCP endpoint](../entities/mcp-endpoint.md) (on the daemon)                     | Curated tools + generic `call_method`; see [Driving from an AI agent](driving-from-an-ai-agent.md) |
| Verify a CSMS against OCPP 1.6 certification flows         | Daemon / console + [`cert16-*` templates](../entities/scenario-templates.md)    | 44 CP-side test cases; [steve-verify](../sources/steve-verify-readme.md) shows the full automation |
| Diagnose a captured session                                | [`analyze`](../entities/analyze.md)                                             | DebugKit reports from a trace file or a live daemon                                                |
| Load-test a CSMS                                           | [`export-k6`](../entities/cli.md#export-k6)                                     | Scenario → k6 bundle (OCPP 1.6J)                                                                   |

## Feature coverage by surface

| Capability                          | Web console (Local) | Desktop / daemon / Docker (Remote)        | CLI REPL / JSON  |
| ----------------------------------- | ------------------- | ----------------------------------------- | ---------------- |
| OCPP-J 1.6J / 2.0.1 / 2.1           | ✅                  | ✅                                        | ✅               |
| SOAP 1.2 / 1.5 / 1.6S bidirectional | send-only           | ✅                                        | ✅               |
| Security profiles 2/3 (TLS files)   | ❌                  | ✅                                        | ✅               |
| Scenario editor (node graph)        | ✅                  | ✅                                        | files only       |
| Multiple charge points per process  | ✅ (per tab)        | ✅                                        | ❌ (one CP)      |
| Network simulation                  | ❌                  | ✅                                        | ❌               |
| Persistence                         | IndexedDB           | SQLite `--state-db`                       | ❌               |
| External control (Socket.IO / MCP)  | ❌                  | ✅                                        | ❌               |
| Trace output / analyze              | log download        | `--trace-output`, `analyze --from-daemon` | `--trace-output` |

The mode a browser ends up in is decided by the health probe, not by a
setting — see [Local vs Remote mode](../concepts/local-vs-remote-mode.md).
