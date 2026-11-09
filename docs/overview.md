---
title: Overview
type: overview
summary: Master summary of the OCPP CP Simulator — what it is, how the pieces fit together, the workspace packages and their boundaries, and where to read next.
sources:
  - scripts/check-package-boundaries.ts
  - "issue #578"
updated: 2026-11-09
---

# OCPP CP Simulator — overview

**What it is.** A charge-point (CP) simulator for OCPP — primarily 1.6J, also
2.0.1 / 2.1 over WebSocket and 1.2 / 1.5 / 1.6S over SOAP — built for
**AI-agent testing, CI automation and CSMS development**. One TypeScript core
(the `ChargePoint` domain under `packages/core/src/cp/`) is exposed through several
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
  ([Scenario format](concepts/scenario-format.md), JSON Schema in `packages/core/schema/`),
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

The repository is a Bun workspace
([#578](https://github.com/shiv3/ocpp-cp-simulator/issues/578)): `packages/*`
hold the code that runs in both Bun and the browser, `apps/*` the two programs
built from it, and the root `package.json` stays the published
`ocpp-cp-simulator` package (the CLI bundle plus the web console). Everything
else at the root — `index.html`, `public/`, `vite.config.ts`, `src-tauri/`,
`docs/`, `e2e/`, `scripts/`, `examples/`, `docker/` — is shared tooling and
keeps its place; Vite's root is the repository root.

Dependency rules between the packages are executable (`bun run check:boundaries`
in CI). [`scripts/check-package-boundaries.ts`](../scripts/check-package-boundaries.ts)
is the canonical definition: `PACKAGE_MAP` assigns every file under
`packages/` and `apps/` to its package, `ALLOWED_DEPENDENCIES` is the
dependency table below, and `--list <package>` and `--json` print the files and
the package-to-package import counts.

`bun run check:boundaries` also runs
[`scripts/check-direct-time.ts`](../scripts/check-direct-time.ts): the code
under `packages/core/src/cp/domain/` and `application/` reads time and arms
timers through the charge point's `SimClock`, and draws random numbers and ids
from its `RngStreams` ([Charger engine](concepts/charger-engine.md#clock-and-random)).
The script lists every direct `Date.now()`, argument-less `new Date()`,
`performance.now()`, `Math.random()`, `crypto.randomUUID()` and global timer
call that is left, against a shrinking exemption list (`EXEMPTIONS`): it fails
on a use the list does not allow and on an entry that allows more than the file
has. It also runs [`scripts/check-single-writer.ts`](../scripts/check-single-writer.ts):
only `packages/core/src/cp/application/engine/` may assign a connector's `status`,
`availability`, `scheduledAvailability`, `currentErrorCode`, `errorInfo` or
`vendorErrorCode`, `transaction`, `transactionId` or a transaction's fields ([Charger engine](concepts/charger-engine.md#the-engine)).

| Package (`@ocpp-cp-simulator/<dir>`) | Holds                                                                                                                                                                                                   | May depend on                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `packages/ocpp`                      | the generated OCPP message types and validators (`src/`) and the vendored OCA schemas (`vendor/ocpp-schemas/`)                                                                                          | nothing                                     |
| `packages/contracts`                 | the wire contract of the daemon (`src/`; [control plane](concepts/control-plane.md))                                                                                                                    | nothing                                     |
| `packages/trace`                     | the log-to-trace adapter (`src/`; [trace format](concepts/trace-format.md))                                                                                                                             | nothing                                     |
| `packages/k6-runtime`                | the k6 runtime files copied verbatim into an export (`src/`) and the ambient k6 module types (`k6-types.d.ts`)                                                                                          | nothing                                     |
| `packages/vehicle`                   | the protocol-independent [vehicle behavior](concepts/vehicle-behavior.md) domain (`src/`): what a vehicle asks for and when, a pure function of its inputs and the instant                              | nothing                                     |
| `packages/core`                      | the charge point and the scenario engine (`src/cp/`, `src/scenario/`), scenario templates and blueprints (`src/utils/`), the shared test helpers (`src/test/`) and the scenario JSON Schema (`schema/`) | ocpp, contracts, trace, k6-runtime, vehicle |
| `packages/client`                    | how a UI or tool talks to a daemon or to an in-process engine (`src/interfaces/`, `src/remote/`, `src/configPort.ts`, `src/RuntimeMode.ts`, `src/sqlite/SqliteConnectorSettingsRepository.ts`)          | core, contracts, ocpp, trace                |
| `apps/cli`                           | the CLI, the daemon, the MCP endpoint, `export-k6` and `analyze` (`src/`), and the tests that build the CLI bundle and the Tauri sidecar (`src/build/`)                                                 | every package except `apps/web`             |
| `apps/web`                           | the browser console: components, console pages, hooks and providers (`src/data/`), store, `lib`, assets, and the jsdom test setup                                                                       | every package except `apps/cli`             |

Packages are private, versionless and have no build step: each `package.json`
exposes its sources through `"exports": { "./*": "./src/*.ts" }` (plus explicit
entries for the few JSON files other packages import), so a specifier mirrors
the path under `src/` — `@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint`.
Bun, Vite and `tsc` (`moduleResolution: bundler`) read the TypeScript directly
through the workspace links; curated public entry points are future work.
Third-party dependencies are still declared once, in the root `package.json`.
Each package has a composite `tsconfig.json` that extends
`tsconfig.base.json` and references the packages it depends on; `bun run
typecheck` is `tsc -b`.

Rules the check enforces:

- An import (value, `import type`, `export … from`, `import()`, `new URL("./x", import.meta.url)`, relative, `@/` or `@ocpp-cp-simulator/…`) from a package into one that is not in its "may depend on" column fails, **type-only imports included**: TypeScript project references forbid cycles at the type level too. Test files are checked like any other and belong to the package of the directory they sit in.
- Across packages the import must be an `@ocpp-cp-simulator/<package>/…` specifier that resolves through the package's `exports`, never a relative path into another package. Inside one package imports stay relative (inside `apps/web` the `@/` alias, `apps/web/src`, also works).
- Each `package.json` is private, named after its directory, and declares exactly the `workspace:*` dependencies its imports need — no more, no less. The root `package.json` must not use `workspace:` anywhere, or the published tarball would not install outside the repository.
- `ocpp`, `contracts`, `trace`, `k6-runtime`, `vehicle`, `core` and `client` must run in both Bun and the browser, so their non-test files may not import `react*`, `jotai`, `zustand`, `@xyflow/*`, `@radix-ui/*`, Vite-only specifiers (`?url`, `?raw`, `virtual:`), `bun:*` or Node built-ins, except for the files on the commented allow-list in the script (today only `packages/core/src/cp/infrastructure/persistence/BunSqliteDatabase.ts`, the daemon's `bun:sqlite` store). Type-only imports of such packages are erased and not flagged.
- A file under `packages/` or `apps/` that matches no `PACKAGE_MAP` entry fails the check, so a new workspace directory has to be registered on purpose. Known exceptions go in the script's `KNOWN_VIOLATIONS` / `TEST_ALLOW_LIST`, each with a reason; a stale entry also fails.
- Inside `packages/core/src/cp/` the layers have a direction ([#571](sources/github-issues.md)): `domain/` imports only `domain/` and `shared/`; `application/` imports `domain/`, `application/` and `shared/`, never `infrastructure/`; `infrastructure/` may import every layer; `shared/` imports only `shared/`. `domain/` and `shared/` also may not import core code outside `src/cp` or anything under `apps/`; other workspace packages stay governed by the table above. Type-only imports count, test files are not checked. The script's `LAYER_EXEMPTIONS` list is empty since [#575](https://github.com/shiv3/ocpp-cp-simulator/issues/575) moved `ChargePoint`'s last imports of `application/` behind domain interfaces, which meets the goal of the epic [#577](https://github.com/shiv3/ocpp-cp-simulator/issues/577); the list is kept, so a new violation fails, and so would an entry that no longer matches.
- A file under `packages/` or `apps/`, test files included, may not reach itself through static value imports, in one package or across several; there is no allow-list for this rule. `import`, a side-effect import, `export … from` (`export *` included, even of a types-only module) and `require` count; `import type`, `export type … from`, `import("x").T` and a dynamic `import()` do not ([#570](sources/github-issues.md)). The ESLint rule `@typescript-eslint/consistent-type-imports` makes an import used only as a type say so, or it would count here. `scripts/` and `e2e/` are not scanned.

### What goes where in `packages/core/src`

The conventions come from
[#576](https://github.com/shiv3/ocpp-cp-simulator/issues/576). The charge point
lives in `cp/`, split in four layers; their import direction is the layer
bullet above, not repeated here.

- `cp/domain/` — the charge point's state and invariants (charge point,
  connector, session, reservation, security, topology, …) and the ports it
  needs, such as the repository interfaces and `LogSink` under
  `domain/persistence/`, the transport ports under `domain/transport/`
  (`ChargePointSocket`, `RawFrameSink`, `OcppCallActions`) and
  `ChargePointDeps`, what a charge point is built with. `domain/engine/` holds
  the engine and behavior vocabulary (`ChargerState`, `EngineEvent`,
  `PersistedEngineState`, the behavior rules) and the interfaces
  `ChargePoint` sees its engine and behavior registry through
  (`ChargePointEngine`, `ChargePointBehaviorRegistry`); `domain/services/`
  holds the interfaces of its heartbeat, state manager and operational
  timeline (`ChargePointHeartbeat`, `ChargePointStateManager`,
  `ChargePointTimeline`) and the state-history types (`StateSnapshot`,
  `StateTransition`, `ValidationResult`).
- `cp/application/` — the use cases that drive the domain: the charger engine
  and its behaviors, services (state history, heartbeat, operational
  timeline), the scenario engine (`application/scenario/`) and run
  verification, and the ports they own, such as `ScenarioRepository` and
  `ScenarioRunRepository`. The engine, the behavior registry and the services
  implement the `domain/engine/` and `domain/services/` interfaces.
- `cp/infrastructure/` — adapters to the outside: WebSocket and SOAP
  transports, the SQLite stores, schema and migrations
  (`infrastructure/persistence/`, since
  [#573](https://github.com/shiv3/ocpp-cp-simulator/issues/573)), HTTP
  (`fileUpload.ts`), the vehicle catalog, and `LogRepository` (log persistence,
  in `infrastructure/persistence/`). `infrastructure/charge-point/createChargePoint.ts`
  is the composition root of a charge point
  ([#575](https://github.com/shiv3/ocpp-cp-simulator/issues/575)): the CLI,
  the web console, the benches, the e2e suites and the tests build one
  through it (only `ChargePoint.deps.test.ts` calls the
  constructor with their own deps), and it
  passes the `ChargePoint` constructor its `ChargePointDeps` — the transport
  factory (`createDefaultTransport.ts`), the factories of the engine, the
  behavior registry, the heartbeat, the state manager and the timeline, and
  the `transactions` port bound to `default.transaction`
  (`DEFAULT_SERVICES` in `createDefaultServices.ts`), a `LogRepository` over
  the charge point's database (a no-op one without a database), the
  charge point's repositories (`createChargePointRepositories`: SQLite over
  its database, no-ops without one,
  [#878](https://github.com/shiv3/ocpp-cp-simulator/issues/878)), and
  `UploadFile` for GetDiagnostics.
- `cp/shared/` — dependency-free utilities: clock, RNG, timers, logger,
  event emitter, reconnect policy, redaction.

Outside `cp/`: `scenario/` holds the scenario-format helpers (schema
validation, loading, connection rules, partial matching), `utils/` the built-in
scenario templates and blueprints, `types/` ambient declarations
(`webcrypto-globals.d.ts`), and `test/` the shared test helpers, behavior
suites, golden-wire rig and regression tests.

Tests go in a `__tests__/` folder beside the code they cover (outside `cp/`,
`src/test/` and the two template tests in `utils/` are the exceptions). A
`*.bun.test.ts` file runs under `bun test`; any other `*.test.ts(x)` runs
under vitest, which excludes the Bun files.

## Where to read next

| If you are…                          | Start with                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| New to the project                   | This page, then [Choosing an interface](analyses/choosing-an-interface.md)                                     |
| Automating a CSMS test               | [Driving from an AI agent](analyses/driving-from-an-ai-agent.md), [Control plane](concepts/control-plane.md)   |
| Writing a scenario                   | [Scenario format](concepts/scenario-format.md), [Scenario templates](entities/scenario-templates.md)           |
| Deploying                            | [Docker image](entities/docker-image.md), [Access control](concepts/access-control.md)                         |
| Debugging a session                  | [analyze](entities/analyze.md), [Log format](concepts/log-format.md), [Trace format](concepts/trace-format.md) |
| Maintaining this wiki (human or LLM) | [Conventions](conventions.md), [`CLAUDE.md`](../CLAUDE.md), [Index](index.md), [Log archive](log.md)           |
