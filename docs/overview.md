---
title: Overview
type: overview
summary: Master summary of the OCPP CP Simulator — what it is, how the pieces fit together, the source-package boundaries, and where to read next.
sources:
  - scripts/check-package-boundaries.ts
  - "issue #578"
updated: 2026-11-05
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
  [MCP endpoint](entities/mcp-endpoint.md), [Docker image](entities/docker-image.md).
  Pick one with
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
- **Vehicles** — reusable [vehicle profiles](concepts/vehicle-profiles.md)
  imported from the external [Open EV Directory](entities/open-ev-directory.md)
  catalog, saved locally and copied into a connector's, the default or a
  scenario's EV settings, so simulations never depend on the catalog.
- **Observability** — one [log line shape](concepts/log-format.md) everywhere;
  wire frames can be streamed as a versioned [trace](concepts/trace-format.md)
  and analyzed with [`analyze`](entities/analyze.md) (OCPP DebugKit); each
  charge point keeps an [operational timeline](concepts/operational-timeline.md)
  that correlates injected network faults with the recovery they cause, and a
  [charging-session history](concepts/charging-sessions.md) that sums up each
  transaction (duration, energy, stop reason, outcome) whatever its OCPP
  version.
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

## Source layout and package boundaries

Everything lives under `src/` today, but the repository is planned to become a
Bun workspace ([#578](https://github.com/shiv3/ocpp-cp-simulator/issues/578)),
moved in one pull request that only renames files and import specifiers. To
keep that move mechanical, the tree already obeys the dependency rules of the
packages it will be split into, and CI enforces them (`bun run check:boundaries`).
[`scripts/check-package-boundaries.ts`](../scripts/check-package-boundaries.ts)
is the canonical definition: its `PACKAGE_MAP` assigns every `.ts` / `.tsx`
file under `src/` to a future package (and says why, where it is not obvious),
`ALLOWED_DEPENDENCIES` is the dependency table below, and `--list <package>`
and `--json` print the files and the package-to-package import counts.

| Future package | Sources today                                                                                                                | May depend on                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `ocpp`         | `src/ocpp/`, `vendor/ocpp-schemas/`                                                                                          | nothing                            |
| `contracts`    | `src/protocol/` (the wire contract, [control plane](concepts/control-plane.md))                                              | nothing                            |
| `trace`        | `src/trace/` ([trace format](concepts/trace-format.md))                                                                      | nothing                            |
| `k6-runtime`   | `src/cli/exportK6/runtime/`                                                                                                  | nothing                            |
| `core`         | `src/cp/`, `src/scenario/`, `schema/`, scenario templates and blueprints in `src/utils/`                                     | ocpp, contracts, trace, k6-runtime |
| `client`       | `src/data/interfaces/`, `src/data/remote/`, `configPort.ts`, `RuntimeMode.ts`, `sqlite/SqliteConnectorSettingsRepository.ts` | core, contracts, ocpp, trace       |
| `apps/cli`     | the rest of `src/cli/`                                                                                                       | every package except `apps/web`    |
| `apps/web`     | the rest of `src/` (console, components, hooks, providers, store, `lib`)                                                     | every package except `apps/cli`    |

Rules the check enforces:

- An import (value, `import type`, `export … from`, `import()`, `new URL("./x", import.meta.url)`, relative or `@/`) from a package into one that is not in its "may depend on" column fails, **type-only imports included**: TypeScript project references forbid cycles at the type level too. Test files are checked like any other and belong to the package of the directory they sit in.
- `ocpp`, `contracts`, `trace`, `k6-runtime`, `core` and `client` must run in both Bun and the browser, so their non-test files may not import `react*`, `jotai`, `zustand`, `@xyflow/*`, `@radix-ui/*`, Vite-only specifiers (`?url`, `?raw`, `virtual:`), `bun:*` or Node built-ins, except for the files on the commented allow-list in the script (today only `src/cp/domain/persistence/BunSqliteDatabase.ts`, the daemon's `bun:sqlite` store). Type-only imports of such packages are erased and not flagged.
- A file under `src/` that matches no `PACKAGE_MAP` entry fails the check, so a new directory has to be placed on purpose. Known exceptions go in the script's `KNOWN_VIOLATIONS` / `TEST_ALLOW_LIST`, each with a reason; a stale entry also fails.

## Where to read next

| If you are…                          | Start with                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| New to the project                   | This page, then [Choosing an interface](analyses/choosing-an-interface.md)                                     |
| Automating a CSMS test               | [Driving from an AI agent](analyses/driving-from-an-ai-agent.md), [Control plane](concepts/control-plane.md)   |
| Writing a scenario                   | [Scenario format](concepts/scenario-format.md), [Scenario templates](entities/scenario-templates.md)           |
| Deploying                            | [Docker image](entities/docker-image.md), [Access control](concepts/access-control.md)                         |
| Debugging a session                  | [analyze](entities/analyze.md), [Log format](concepts/log-format.md), [Trace format](concepts/trace-format.md) |
| Maintaining this wiki (human or LLM) | [Conventions](conventions.md), [`CLAUDE.md`](../CLAUDE.md), [Index](index.md), [Log](log.md)                   |
