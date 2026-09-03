---
title: Overview
type: overview
summary: Master summary of the OCPP CP Simulator — what it is, how the pieces fit together, and where to read next.
updated: 2026-09-03
---

# OCPP CP Simulator — overview

**What it is.** A charge-point (CP) simulator for OCPP — primarily 1.6J, also
2.0.1 / 2.1 over WebSocket and 1.2 / 1.5 / 1.6S over SOAP — built for
**AI-agent testing, CI automation and CSMS development**. One TypeScript core
(the `ChargePoint` domain under `src/cp/`) is exposed through several
interfaces: a browser console, a desktop app, a headless CLI, a multi-CP
daemon with a Socket.IO control plane and an MCP endpoint, and a Docker image.

## How the pieces fit

```
                 ┌──────────────── interfaces ─────────────────┐
  you / agent →  │ Web console │ Desktop app │ CLI │ MCP client │
                 └──────┬────────────┬─────────┬────────┬──────┘
                        │ Remote     │ sidecar │ --json │ POST /mcp
                        ▼            ▼         │        ▼
                 ┌────────────────────────────────────────────┐
                 │ Daemon: Socket.IO control plane (rpc/event) │  ← Docker image
                 │  CP registry · scenarios · logs · state-db  │
                 └───────────────────┬────────────────────────┘
                                     │ OCPP-J (ws/wss) or OCPP-S (SOAP)
                                     ▼
                              CSMS (SteVe, gocpp, yours)
```

- **Interfaces** — [Web console](entities/web-console.md) (Local mode in a tab
  or Remote mode against a daemon), [Desktop app](entities/desktop-app.md),
  [CLI](entities/cli.md), [Daemon](entities/daemon.md),
  [MCP endpoint](entities/mcp-endpoint.md), [Docker image](entities/docker-image.md),
  [Legacy v1 UI](entities/legacy-v1-ui.md). Pick one with
  [Choosing an interface](analyses/choosing-an-interface.md).
- **Control plane** — every Socket.IO client of the daemon (web console in
  Remote mode, CLI client modes, external agents) speaks the same
  [contract](concepts/control-plane.md): `rpc` acks and `event` pushes,
  zod-validated, closed error codes. REST and the Unix socket were removed
  ([migration](analyses/rest-to-socketio-migration.md)).
- **MCP** — a separate transport for LLM agents: stateless JSON-RPC over
  `POST /mcp`, exposing the same daemon methods as tools
  ([MCP endpoint](entities/mcp-endpoint.md)); it has no event push.
- **Scenarios** — scripted CP behavior is a node-graph JSON
  ([Scenario format](concepts/scenario-format.md), JSON Schema in `schema/`),
  authored in the editor or loaded from files / [built-in templates](entities/scenario-templates.md)
  (including 47 OCPP 1.6 certification test cases). Runs produce a
  machine-readable verdict with conformance and compatibility axes.
- **Observability** — one [log line shape](concepts/log-format.md) everywhere;
  wire frames can be streamed as a versioned [trace](concepts/trace-format.md)
  and analyzed with [`analyze`](entities/analyze.md) (OCPP DebugKit).
- **Operations** — [state persistence](concepts/state-persistence.md)
  (SQLite in the daemon, sql.js in the browser),
  [access control](concepts/access-control.md) (bind gate, Basic Auth, CORS,
  reverse proxies), [network simulation](concepts/network-simulation.md)
  (seeded latency / disconnects).
- **Protocol coverage** — [OCPP versions & transports](concepts/ocpp-versions-and-transports.md),
  [OCPP 1.6 security profiles](concepts/security-profiles.md); message types
  are generated from the [vendored OCA schemas](sources/vendored-ocpp-schemas.md).
- **Verification** — unit / Bun tests, a gocpp e2e suite, the steve-verify
  harness and a Testcontainers example ([Testing strategy](analyses/testing-strategy.md),
  [CSMS peers](entities/csms-peers.md)).

## Where to read next

| If you are…                          | Start with                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| New to the project                   | This page, then [Choosing an interface](analyses/choosing-an-interface.md)                                     |
| Automating a CSMS test               | [Driving from an AI agent](analyses/driving-from-an-ai-agent.md), [Control plane](concepts/control-plane.md)   |
| Writing a scenario                   | [Scenario format](concepts/scenario-format.md), [Scenario templates](entities/scenario-templates.md)           |
| Deploying                            | [Docker image](entities/docker-image.md), [Access control](concepts/access-control.md)                         |
| Debugging a session                  | [analyze](entities/analyze.md), [Log format](concepts/log-format.md), [Trace format](concepts/trace-format.md) |
| Maintaining this wiki (human or LLM) | [Conventions](conventions.md), [`CLAUDE.md`](../CLAUDE.md), [Index](index.md), [Log](log.md)                   |
