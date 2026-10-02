---
title: Web console (browser UI)
type: entity
summary: The React + TypeScript browser UI — classic console at `/`, redesigned console at `/v3` — served from GitHub Pages (Local mode) or by the daemon / Docker image / desktop app (Remote mode).
sources:
  - src/ (React app)
  - index.html
  - vite.config.ts
related:
  - desktop-app.md
  - daemon.md
  - ../concepts/local-vs-remote-mode.md
  - ../concepts/state-persistence.md
  - ../concepts/expert-ocpp-calls.md
updated: 2026-10-02
---

# Web console (browser UI)

React + TypeScript web application with Flowbite/Tailwind UI. The same bundle
(`dist/`, built by Vite) is served in three ways: the hosted static site, the
[daemon](daemon.md) with `--web-console` (and therefore the
[Docker image](docker-image.md)), and the [desktop app](desktop-app.md).

![Web console — connector panel, scenario editor, and real-time logs](../images/web-console-overview.png)

## Web Version

https://shiv3.github.io/ocpp-cp-simulator/

The hosted web version runs in **Local mode** — every charge point lives in the
browser tab, persisting to IndexedDB via sql.js. Closing the tab keeps the data;
clearing site data drops it.

When the same React UI is served by `ocpp-cp-sim --web-console`, the Docker
image, or the desktop app, it runs in **Remote mode**. The page first probes
`/v1/healthz` at its own origin; a `200` response with `{ "ok": true }` means a
daemon is present. After that detection, all simulator control uses the same
Socket.IO connection documented in [Control plane](../concepts/control-plane.md):
`rpc` acks for commands and `event` push envelopes for CP / registry updates.
The detection rules are in [Local vs Remote mode](../concepts/local-vs-remote-mode.md).

## Layout (route prefixes)

The browser app serves the UIs under distinct route prefixes from the same origin:

- **`/`** — the classic console (the default). Also reachable at **`/v2`** for
  backward-compatible bookmarks.
- **`/v3`** — the redesigned console: a fleet of **Charge Points**,
  per-charge-point detail (`/v3/cp/:id`), a cross-CP **Scenario library** with
  a linear step editor and a separate run console (`/v3/scenarios`; each row's
  `…` menu — Duplicate, Export JSON, Delete — opens in a portal and flips
  upward near the bottom of the window, so it is never clipped by the table,
  #365), a cross-CP **Run history** (`/v3/scenarios/runs`, #388), a global
  **Message log** (`/v3/logs`), and **Settings** (`/v3/settings`, where
  global [network simulation](../concepts/network-simulation.md) and the
  **Reset all simulator data** button live).
- **`/v1`** — no longer a UI. The original single-page UI was removed in
  #411; its last version is the `legacy-v1-final` tag. A browser route under
  `/v1/...` redirects to `/`, so an old bookmark opens the console rather
  than an empty page. Only the client-side router does this: when the
  [daemon](daemon.md) serves the console, it answers `/v1/...` itself (the
  health endpoint, `404` for the removed REST paths), and these paths never
  reach the app. Its URL-hash preset links (`#config=…`) are not carried
  over: they had not loaded since the v1 code moved under `src/v1` (the
  hash key became `config-v1`). To share a configuration, use the JSON
  export / import in **Settings**.

In `/v3`, a charge point's **Active scenarios** panel lists the runs executing
or parked on its connectors, and its **Open run** link opens the scenario's run
console (`/v3/scenarios/run?cp=…&connector=…&id=…&run=<runId>`). The run
console **attaches** to a run that is already live in the runtime rather than
showing a fresh idle state: it hydrates the state (`running` / `waiting` / …),
current and already-executed nodes, the waiting expectation with its timeout
countdown, and the runId from `scenario_status`, and its **Stop** acts on that
run. Opening or reloading the page never starts a run; a run of the scenario
started elsewhere while the page is open (for example an auto-start trigger)
is attached the same way. When `run=` names a run that has ended or been
superseded, a banner says so (daemon only — local mode mints no runId) (#366).

While a run is `waiting`, the panel and the run console both offer **+30 s**
(only when the wait has a timeout), **Retry** and **Continue** beside the
waiting expectation ([Controls on a parked wait](../concepts/scenario-format.md#controls-on-a-parked-wait),
#240). The countdown follows the runtime's `waitDeadlineAt`, so an extension
shows at once, and a control the runtime refuses is shown inline instead of
being dropped. In Remote mode every open console re-reads the run on
`scenario_wait_changed`, not only the one that acted.

A charge point's **Expert** tab sends an
[expert OCPP call](../concepts/expert-ocpp-calls.md) (#389): pick any
station-initiated action of the CP's OCPP-J version, edit the JSON payload —
pre-filled with the smallest schema-valid one, **Reset to default** restores
it — and **Send**. The schema check runs as you type; a schema-invalid payload
is sent only with **Skip schema validation** ticked, and text that is not a
JSON object never is. **Apply the answer to the station's state** is off by
default. The tab shows the frame as sent and the CALLRESULT or CALLERROR, or
why the call was refused; a SOAP CP gets a notice instead of the form. It
works in both modes.

The run console's **Run history** lists the daemon's recorded runs of that
scenario on that connector — the latest 20, newest first, with each run's
result and verdict — plus the run the page is tracking until the daemon records
it, so the history survives navigating away and back or a daemon restart with
`--state-db`. Selecting a recorded run opens its report: verdicts, timing,
errors, assertion results, wait interventions and the run's OCPP transcript,
downloadable as JSON. **View all runs** opens the **Run History** page
(`/v3/scenarios/runs`), which lists every recorded run across charge points
with filters on charge point, connector, scenario id, verdict and execution
state, pages of 50, and the selected run's report beside the list. Filters, the
page and the selected run are kept in the URL (`?cp=&connector=&scenario=
&verdict=&state=&offset=&run=&runCp=`), so a copied URL reopens the same view;
a linked run that is no longer on that page (newer runs pushed it down) is
looked up by `runId` and its report still opens. A run is identified by its
charge point and its `runId` (`runCp` + `run`), since a runId is unique per
charge point only; a link without `runCp` opens its run only when that id
names a single one. Both re-list when the daemon
records a run, and when a charge point is deleted or the simulator reset
([Scenario run history](../concepts/control-plane.md#scenario-run-history), #388).
In Local mode the run console keeps a history of this page view only, and the
Run History page says it needs the daemon — local run reports are tracked in
#394.

The two consoles link to each other with a design switcher (the classic
navbar's **New design** button ↔ the redesigned sidebar's **Switch to classic
design** button).

Both consoles show the running build as `ocpp-cp-simulator vX.Y.Z · GitHub` —
in the classic UI's footer (#93) and at the bottom of the `/v3` sidebar
(#364). The two render the same component from the same source
(`src/lib/appBuildLabel.ts`): the package version stamped by the release
tooling (`__APP_VERSION__`), falling back to the short commit SHA on the
GitHub Pages deploy (`__APP_COMMIT__`, built from `main`); an unstamped dev
build shows no version rather than `v0.0.0`. In Remote mode the line also
shows the connected daemon's version, `· daemon vX.Y.Z`, from the `version`
of [`server.info`](../concepts/control-plane.md) (re-read on reconnect), since
the UI bundle and the daemon can be different releases — e.g. the hosted
console pointed at a self-hosted daemon. An unstamped daemon reports
`0.0.0-dev`. Local mode has no daemon and shows no daemon version; neither
does a daemon that predates `server.info`.

The `/v3` dashboard and connector cards, and the classic connector card and
expanded side panel, format a connector's live readings with
`src/lib/connectorFormat.ts`: the meter value, which is in Wh, as kWh with
2 decimals (`16208` → `16.21 kWh`), and the SoC with 1 decimal (`20.5%`). The
`/v3` connector card shows `—` when no SoC is reported; the classic side
panel's collapsed rail rounds the SoC to a whole percent (#368).

The redesign reuses the existing data layer, scenario engine, and per-step
forms unchanged; scenarios, charge points, and logs are simply promoted to
first-class routes instead of nested panels.

## What the console can do

- Create charge points and connectors, connect to a CSMS over OCPP-J
  (1.6J / 2.0.1 / 2.1) or — in Local mode, send-only — the SOAP versions
  (see [OCPP versions & transports](../concepts/ocpp-versions-and-transports.md)).
  In Remote mode, when the daemon holds a SOAP public base (`--soap-tunnel
ngrok` / `--soap-public-base-url`), the SOAP callback URL is optional in the
  create / edit form — the derived value is previewed — and the charge point's
  Configuration tab shows the effective URL with a **Copy** button, the value
  to register in the CSMS (#183).
- Author, import and export scenarios in the node-graph
  [scenario format](../concepts/scenario-format.md); load the built-in
  [scenario templates](scenario-templates.md), including the `cert16-*`
  certification flows.
- View the message log and download it as JSON Lines in the shared
  [log format](../concepts/log-format.md) (the same shape the daemon writes
  and the [trace adapter](../concepts/trace-format.md#producing-records) consumes).
- Persist everything (charge points, scenarios, configuration overrides,
  logs) — sql.js + IndexedDB in Local mode, the daemon's SQLite in Remote
  mode ([State persistence](../concepts/state-persistence.md)).

## Development

```bash
npm install

# Web dev server (Local mode)
npm run dev

# Production build → dist/
npm run build
```

The build inlines `VITE_HEALTH_PATH` (default `/v1/healthz`) as the Remote-mode
probe path; it must match the daemon's `--health-path` when that is changed
(see [Daemon → Health](daemon.md#health)).

### Prerequisites

- Node.js (v18 or later)
- Bun for anything that touches the daemon / desktop sidecar (see
  [Desktop app](desktop-app.md#development))
