---
title: Local vs Remote mode (browser)
type: concept
summary: The web console decides once per page load whether charge points run in-browser (Local, sql.js) or in a daemon (Remote, Socket.IO) by probing `/v1/healthz` at its own origin; there is no toggle.
sources:
  - packages/client/src/RuntimeMode.ts (runtime-mode detection)
  - apps/web/src/data/ (providers)
  - vite.config.ts (`VITE_HEALTH_PATH`)
related:
  - ../entities/web-console.md
  - ../entities/daemon.md
  - ../entities/desktop-app.md
  - ../entities/docker-image.md
  - state-persistence.md
  - control-plane.md
  - vehicle-profiles.md
  - ../entities/open-ev-directory.md
  - charging-sessions.md
updated: 2026-11-08
---

# Local vs Remote mode (browser)

The browser UI auto-detects which mode to run in by probing `/v1/healthz` at
its own origin (path configurable at build time via `VITE_HEALTH_PATH`; it
must match the daemon's `--health-path`, see [Daemon → Health](../entities/daemon.md#health)):

| Served by                                                                                                                                    | Mode       | Where charge points run     | Persistence                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------- | ------------------------------------------------- |
| `ocpp-cp-sim --web-console`, the [Docker image](../entities/docker-image.md), the [desktop app](../entities/desktop-app.md) (daemon sidecar) | **Remote** | In the daemon process       | Daemon SQLite (`--state-db`)                      |
| Static build (GitHub Pages, `bun run dev` / `npm run dev`)                                                                                   | **Local**  | Entirely in the browser tab | sql.js + IndexedDB (`ocpp-cp-simulator` database) |

- A `200` with `{ "ok": true }` → **Remote**: every operation uses the
  daemon's [Socket.IO control plane](control-plane.md) (`rpc` acks + `event`
  push). sql.js / the WASM download are skipped entirely.
- Anything else → **Local**: the sql.js engine is loaded and the same SQLite
  schema is kept in IndexedDB ([State persistence → Browser](state-persistence.md#browser)).

There is no toggle — the mode is decided once on page load and never
overridden.

## Switching daemons (Remote mode)

In Remote mode the sidebar lists the daemon that served the console ("This
server") and the addresses you saved (#619). Picking one points the console at
that daemon: it first answers the health probe (`{ "ok": true }`), then the
Socket.IO connection must come up within 8 seconds. If either step fails, the
previous daemon stays selected and the sidebar says so. The saved list
(`ocpp-cp.saved-daemons`, at most 20 `http(s)://host[:port]` origins with an
optional name) and the last choice (`ocpp-cp.active-daemon`) live in
`localStorage`; after a reload the console re-selects the last daemon if it
still answers, else it falls back to the serving daemon. Addresses with
embedded credentials are refused, so no password is stored. The other daemon
must allow the console's origin ([`--cors-origin`](../entities/daemon.md)).
Local mode has no switcher and never touches these keys.

## Consequences

- Feature parity differs by mode: SOAP versions are send-only in Local mode,
  security profiles 2/3 and TLS files are daemon-only
  ([OCPP versions & transports](ocpp-versions-and-transports.md),
  [Security profiles](security-profiles.md)); [network simulation](network-simulation.md)
  works in both modes from `/settings`, but its RPC / MCP methods exist
  only on the daemon.
- The **Reset all simulator data** button calls `state.reset` in Remote mode
  and clears the local DB in Local mode.
- [Vehicle profiles](vehicle-profiles.md) (#458) work in both modes and are
  stored where the charge points' state is (daemon or sql.js), but the
  catalog is reached differently. Remote mode imports through the daemon's
  `vehicle_catalog.*` methods with the key the daemon was started with; the
  key never reaches the browser. Local mode calls
  [Open EV Directory](../entities/open-ev-directory.md) from the tab with a
  key you type, held in memory only, and only works if the API allows the
  page's origin (CORS); otherwise the console points you to daemon mode.
- The [charging-session history](charging-sessions.md) (#447) works in both
  modes: the daemon's `charging_sessions` table (or its in-memory store
  without `--state-db`) in Remote mode, the browser's sql.js database in Local
  mode. Local mode keeps a removed charge point's sessions until the next
  reset.
- In Remote mode the browser's log download and the daemon's `logs.get` return
  the same rows ([Log format](log-format.md)).
- [Expert OCPP calls](expert-ocpp-calls.md) (#389) work in both modes: the
  console's Expert section calls the in-tab charge point in Local mode and
  `send_ocpp_call` on the daemon in Remote mode, which is also the method the
  MCP tool and JSON-Lines mode use.
- Scenarios run in both modes without depending on which page is open. In
  Local mode each charge point's scenario runtime (`LocalScenarioRuntime`,
  owned by the browser's data layer) loads the connector's saved scenarios,
  fires status triggers and the connect / status auto-start, and reports runs
  as `scenario-started` / `-node-execute` / `-completed` / `-error` /
  `-wait-changed` events — the same events the daemon pushes, without a
  `runId`. Before #411 that runtime lived in the classic UI's connector card:
  with only the web console open, a Local-mode scenario could not run.
  Auto-start follows the daemon's rules
  ([Scenario format → start notes](scenario-format.md#start-notes-triggeron-connect-fires-on-_every_-connect)).
  Only the automatic starts wait for the charge point to be `Available` — a
  `statusChange` trigger and the connect / status auto-start, in both modes.
  An explicit run (the console's **Run**, `runScenario`, a template run)
  starts whatever the charge point's status, as `run_scenario` does on the
  daemon; a `statusChange` trigger that matches while the charge point is
  not `Available` leaves that run going. Before #425, Local mode skipped an
  explicit run on a charge point that was not `Available` without an error:
  the run page showed a running scenario that never progressed.
- A scenario's `evSettings` override is released by the run that **actually
  applied** it, in both modes, on an ordinary completion as well as a stop. In
  Local mode the connector's `ScenarioManager` records the run once its
  settings are written; the daemon records the run id
  ([File hot-reload](file-hot-reload.md)). A run that declared no
  `evSettings`, or whose settings were refused, leaves an operator's override
  alone (#105); an operator's set during a run takes the override over, so the
  run's end no longer releases it; and a definition installed under a running
  id but not yet run says nothing about who holds it. Before #333, Local mode
  decided from what the definition installed under the id _declared_.
- The scenario wait controls (extend / retry / continue, #240) work in both
  modes and refuse an idle scenario the same way. The run report that records
  them (`interventions`) is built the same way in both (#394).
- The scenario run history (#388, #394) works in both modes. One shared
  component (`ScenarioRunRecorder`, application layer) captures the OCPP
  transcript, evaluates the assertions, computes the verdict and assembles the
  report for the daemon's service and for the browser's `ScenarioManager`, so
  the same scenario yields the same report shape in either. In Local mode the
  reports go to the sql.js `scenario_runs` table (in memory when the database
  could not be opened), so a run survives a page reload; retention is the
  same 100 runs per charge point. `getScenarioReport` and `listScenarioRuns`
  answer from it, the run page and `/scenarios/runs` list and filter it as
  they do on the daemon, and the Local service emits the `scenario-*` events
  with a `runId` (minted per run) and `scenario-run-recorded`. A charge point
  that is no longer defined, and **Reset all simulator data**, drop its runs.
  Differences: a Local run's `simulatorVersion` is the console build's, and the
  timeline gets run attribution and `scenario_finished` only.
