---
title: Web console (browser UI)
type: entity
summary: The React + TypeScript web console at `/` (the classic UI stays at `/v2` for a transition) — served from GitHub Pages (Local mode) or by the daemon / Docker image / desktop app (Remote mode).
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

The browser app serves one web console, plus the classic UI during a
transition, from the same origin:

- **`/`** — the web console: a fleet of **Charge Points**, per-charge-point
  detail (`/cp/:id`), a cross-CP **Scenario library** (`/scenarios`; each
  row's `…` menu — Duplicate, Export JSON, Delete — opens in a portal and
  flips upward near the bottom of the window, so it is never clipped by the
  table, #365) with an editor (`/scenarios/edit`, see
  [Scenario editor](#scenario-editor-steps-and-graph)) and a separate run
  console (`/scenarios/run`), a cross-CP **Run history**
  (`/scenarios/runs`, #388), a global **Message log** (`/logs`), and
  **Settings** (`/settings`, where global
  [network simulation](../concepts/network-simulation.md) and the **Reset all
  simulator data** button live). Every page takes its state from the URL, so
  a deep link or a reload opens the same view; an unknown path shows a **Page
  not found** page with a link back to the charge points.
- **`/v2`** — the classic UI, kept while the features it still has alone
  move to the console (#411): deleting a charge point or a connector, bulk
  actions on every charge point, setting the meter value or SoC and sending
  a MeterValues by hand, a per-connector auto meter-value curve, a
  StatusNotification for connector 0, downloading the logs, the
  charging-profile view, and a scenario's description and EV settings. The
  console's sidebar **Classic UI** link and the Settings page's **Open
  classic UI** link go there; the classic navbar's **Web console** link comes
  back.
- **`/v3/...`** — where the console was served before #411. A bookmark
  redirects to the same route without the prefix, keeping the query string
  and the hash (`/v3/scenarios/run?cp=…&id=…` → `/scenarios/run?cp=…&id=…`).
  The redirect is client-side, so the GitHub Pages base path applies; the
  [daemon](daemon.md) serves the app for these paths like any other.
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

### Scenario editor: steps and graph

The editor (`/scenarios/edit?cp=…&connector=…&id=…`) shows one scenario in two
views, switched by the **Steps | Graph** toggle and kept in the URL
(`&view=steps|graph`):

- **Steps** — an ordered list of steps with a form for the selected one. It
  can only show a single START → … → END chain, so it is the default for such
  a scenario.
- **Graph** — the node graph editor (ReactFlow): nodes, edges, the node
  palette, auto-arrange, undo / redo, and a node panel (double-click a node,
  then **Apply**). A scenario with branches (a node with more than one
  outgoing edge — the executor runs them in parallel) or a loop always opens
  here, with **Steps** disabled; a linear one can be turned into a branching
  one here.

Both views edit the same definition: unsaved changes survive a switch, and
nothing is written until the page's **Save**, which saves this scenario only
(the connector's other scenarios are kept). The name, trigger and enabled
flag are edited in the header in both views; unlike the classic graph editor,
the graph view does not rewrite the trigger from a **Status Trigger** node,
so pick **On status change** in the header for a scenario that should start
on a status. A graph view opened because the scenario branches stays open
when an edit makes it linear again. Opening a scenario in the graph view is
not an edit: an edge to a missing node is hidden there, and leaves the saved
definition only with the first save after a graph edit. Before #411 a branching
scenario opened read-only, with a link to the classic UI's graph editor.

In the console, a charge point's **Active scenarios** panel lists the runs executing
or parked on its connectors, and its **Open run** link opens the scenario's run
console (`/scenarios/run?cp=…&connector=…&id=…&run=<runId>`). The run
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
(`/scenarios/runs`), which lists every recorded run across charge points
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

Both UIs show the running build as `ocpp-cp-simulator vX.Y.Z · GitHub` —
in the classic UI's footer (#93) and at the bottom of the console's sidebar
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

The console's dashboard and connector cards, and the classic connector card and
expanded side panel, format a connector's live readings with
`src/lib/connectorFormat.ts`: the meter value, which is in Wh, as kWh with
2 decimals (`16208` → `16.21 kWh`), and the SoC with 1 decimal (`20.5%`). The
console's connector card shows `—` when no SoC is reported; the classic side
panel's collapsed rail rounds the SoC to a whole percent (#368).

The console and the classic UI share the data layer, the scenario engine and
the per-step forms; the console promotes scenarios, charge points and logs
to first-class routes instead of nested panels.

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
