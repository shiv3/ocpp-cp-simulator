---
title: Web console (browser UI)
type: entity
summary: The React + TypeScript web console at `/` (the classic UI was retired in #426) — served from GitHub Pages (Local mode) or by the daemon / Docker image / desktop app (Remote mode).
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
updated: 2026-10-04
---

# Web console (browser UI)

React + TypeScript web application with Flowbite/Tailwind UI. The same bundle
(`dist/`, built by Vite) is served in three ways: the hosted static site, the
[daemon](daemon.md) with `--web-console` (and therefore the
[Docker image](docker-image.md)), and the [desktop app](desktop-app.md).

**Look.** The console uses neutral graphite surfaces with one blue accent,
kept for the selection and the primary action. A status is a small colored dot
plus plain text, never a filled pill (one color map for charge point statuses
and scenario run states: green, blue, amber, red, gray, purple for stepping).
Text is IBM Plex Sans, with IBM Plex Mono for ids, versions and numbers; the
font files are bundled with the app (`@fontsource/ibm-plex-*`, imported in
[`src/main.tsx`](../../src/main.tsx)), so the console looks the same offline,
in the daemon image and in the desktop app. Light and dark themes both come
from the palette variables in [`src/index.css`](../../src/index.css) (`--cx-*`,
exposed to Tailwind as `bg-cx-card`, `text-cx-muted`, …), which also retune the
shared shadcn variables, so dialogs, menus and the graph editor follow.

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

The browser app serves one web console:

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
- **`/v2/...`** — where the classic UI was served from #411 until #426
  retired it, once the console had the features found only there (#415–#424,
  #434). A bookmark redirects to the same console route without the prefix,
  as for `/v3` below: `/v2` → `/`, `/v2/settings` → `/settings`.
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

The console's sidebar holds the navigation, the mode pill (**Local mode** or
**Remote mode**) and the version line. In Remote mode
the pill's dot follows the connection to the daemon (#423): amber while
connecting, green once connected, red when the daemon cannot be reached, with
the reason in its tooltip, as the classic navbar's badge did. Before #423 it
was always green. Local mode has no daemon, so its dot carries no status.

### Dashboard

The dashboard (`/`, titled **Charge Points**) lists every charge point in one
of three **views**, under a row of **filters**. It replaces the card grid and
the **Recent activity** box of earlier versions; the traffic is on the
[Message Log](#layout-route-prefixes) page.

**Views.** A segmented control in the header (`role="group"`, label `View`;
the header reads: view switch, **All charge points** menu, **Add Charge
Point**) picks the layout. The choice is `?view=` in the URL; the Hierarchy
view is the default and leaves the parameter out.

| View (`?view=`)               | Shows                                                                                                                                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hierarchy** (`hierarchy`)   | One row per charge point in one bordered card, with its connectors as a grid of small cells under it.                                                                                                                                  |
| **Charge points** (`cp`)      | A table, one row per charge point: id, OCPP version, status, **In use** (`busy / total` connectors, busy = Charging, Preparing, SuspendedEV, SuspendedEVSE or Finishing), scenario badge or `—`, last Heartbeat, and the power button. |
| **Connectors** (`connectors`) | A flat table, one row per connector: `<cp id> #<n>`, status, meter (kWh), transaction (`#<id>` or `—`), scenario run state or `—`, and the charge point's status.                                                                      |

In the Hierarchy view a row's head holds, left to right: a **twist** button
(`Collapse connectors of <id>` / `Expand …`, `aria-expanded`) that folds the
connector grid away (kept on the page, not in the URL), a plug icon colored by
status, the id, the OCPP version as small muted text, the status (dot and text), the
**Scenario** badge (amber **Waiting: …** while a run is parked), the **Net
sim** badge, one small dot per connector (tooltip `#<n> <Status>`), and at the
right end an icon-only power button (`Connect <id>` / `Disconnect <id>`; its
tooltip carries the last Heartbeat, `heartbeat 3m ago`). Status colors, for
the pill, the dots and the icon: Available and Connected green; Charging blue;
Preparing, Finishing, Reserved, SuspendedEV and SuspendedEVSE amber; Faulted
and Unavailable red; Disconnected gray
([`statusColor.ts`](../../src/console/components/statusColor.ts)).

A **connector cell** shows little text: `#<n>`, the status with a colored dot,
a small play icon in the run state's color while a scenario runs on it, and at
the right either `Tx <id>` or, with no transaction and a non-zero meter, the
energy in kWh (nothing otherwise). The rest is in the tooltip, joined with
`·`: status, energy, `Tx #<id>`, and `<run state>: <scenario name>`. The
snapshot carries no fault code, so a Faulted connector's tooltip shows the
status only. The cell is a button (`aria-pressed` while it is the connector
open in the panel) and opens the panel on that connector.

**Filters.** The row above the list narrows it; every field is a URL
parameter, kept when the panel opens and changed with a replace (Back leaves
the page, not the last keystroke). The comboboxes filter as you type; **Enter**
takes the first suggestion, **Esc** closes the suggestions (and does not close
the side panel), and **Clear** empties the field.

| Field (label)               | URL            | Matches                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Charge point** combobox   | `?q=`          | A substring of the charge point id, case-insensitive. Suggestions: every id, with a status dot and the OCPP version.                                                                                                                                                                                                       |
| **Connector / Tx** combobox | `?conn=`       | `#3`, `3`, `Tx 42`, `tx42` or `42`: a connector whose number equals the digits, or whose transaction id contains them. Text that is not of that form matches nothing; `#` or `Tx` alone does not filter yet. Suggestions: every connector number as `#n`, then every running transaction as `Tx <id>` with `<cp id> #<n>`. |
| **Status** select           | `?status=`     | The connector's OCPP status (the nine values, in enum order). An unknown value in the URL is ignored.                                                                                                                                                                                                                      |
| **OCPP version** select     | `?version=`    | The charge point's version (`config.ocppVersion` in Remote mode; in Local mode the shared config's), among the versions present in the list.                                                                                                                                                                               |
| **Connected** checkbox      | `?connected=1` | Charge points that are connected: transport up, or a status other than Unavailable.                                                                                                                                                                                                                                        |
| **Scenario** checkbox       | `?scenario=1`  | Connectors with an active scenario run.                                                                                                                                                                                                                                                                                    |

The **connector-level** filters (Connector / Tx, Status, Scenario) hide the
charge points that have no matching connector and, in the Hierarchy view, the
connectors that do not match; the others (Charge point, OCPP version,
Connected) hide whole charge points. Filters combine with AND. At the right
end the counter reads `<n> CPs · <m> connectors` for what is shown. When
nothing matches, the list says **No charge points match the current
filters.**; with no charge point at all it keeps **No charge points** and the
add action. The filter logic is a pure module,
[`cpListFilters.ts`](../../src/console/pages/dashboard/cpListFilters.ts).

Clicking a charge point — its row, its id, a table row or a connector cell —
opens it in a **side panel** beside the list, without leaving the page. The
panel holds the [charge point page](#charge-point-page)'s content, with
**Open as full page** and **Close** buttons added to its header. The state is
in the URL, so a reload or a shared link reopens it:

| URL                       | Meaning                                                       |
| ------------------------- | ------------------------------------------------------------- |
| `/?cp=<id>`               | The list with that charge point open in the panel.            |
| `/?cp=<id>&connector=<n>` | The same, on connector `n` (a connector cell or row sets it). |
| `/?cp=<id>&tab=<section>` | The same, with a **More** section in the lower half.          |
| `/cp/<id>?connector=<n>`  | The full page, reached from **Open as full page**.            |

- **Open, swap, toggle.** Opening from a closed list adds one history entry.
  Clicking another charge point (or connector) while the panel is open swaps
  its content and replaces the entry; clicking the open charge point's row
  again closes the panel. A button, link or form control inside a row keeps
  its own job: **Connect** / **Disconnect** does not open the panel. The row
  of the open charge point is highlighted (`data-selected="true"`).
- **Close.** The **Close side panel** button, **Esc** (unless a dialog inside
  the panel handles it first), or a click on the list's background. Closing
  replaces the history entry and removes `cp` and `connector`; other search
  parameters stay.
- **Resize.** The panel's left edge is a handle (`role="separator"`): drag it,
  or focus it and press **←** (wider) / **→** (narrower) for 32 px a step. The
  width stays between 360 px and the window width minus 320 px, and is kept in
  the browser (`localStorage`, key `ocpp-cp.console.panel-width`); the default
  is `min(680px, 48vw)`. From 1100 px of window width the list stays usable
  beside the panel; below that the panel covers the page and the handle is
  hidden.
- **Open as full page** goes to `/cp/<id>?connector=<n>`. Leaving the full
  page with **← Back to charge points** returns to `/?cp=<id>&connector=<n>`:
  the list with that charge point still open in the panel, and its row
  scrolled into view.

With two charge points or more, the header's **All charge points** menu (#416) runs an
action on every charge point at once, as the classic UI's Multi-CP dialog did:

| Action                       | What each charge point does                                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Connect all**              | Connects.                                                                                                                                                   |
| **Disconnect all**           | Disconnects.                                                                                                                                                |
| **Send Heartbeat to all**    | Sends a Heartbeat.                                                                                                                                          |
| **Start transaction on all** | Starts a transaction on connector 1 with its own TagID: the first charge point gets the first TagID, and so on. A charge point left without one is skipped. |
| **Stop transaction on all**  | Stops every running transaction, read when the action runs. A charge point without one is skipped.                                                          |

The action runs on every charge point in parallel and ends with a one-line
report under the header, for example `Send Heartbeat to all: 1 of 2 charge
points. Failed: CP-2 (not connected).` The TagIDs come from **Settings**.

### Charge point page

The charge point page (`/cp/:id`) is one column, top to bottom:

- **Header.** The charge point id, its status, a network-simulation badge when
  it is on, and the OCPP version with the security profile (`OCPP-1.6J · SP2`);
  the WebSocket URL under it. The actions, in order: **Config**, **Connect** /
  **Disconnect**, and **More** (a `…` button), then **Open as full page** and
  **Close** in the side panel.
- **Config**, when on (`aria-expanded`, highlighted), opens an inline form in
  a card under the header: the same fields and checks as the Add / Configure
  dialog (both are `ChargePointConfigForm`), with the charge point id locked.
  **Save** updates the charge point (`cp.update` in Remote mode, the saved
  configuration in Local mode), re-reads it and closes the form; if the save
  fails the form stays open. **Cancel** closes it. In Remote mode a SOAP charge
  point's form shows the effective SOAP callback URL under the field, with a
  **Copy** button and, when it was derived from the daemon's tunnel, a note that
  it may change between daemon runs (#183).
- **Charge point (connector 0)**, one compact row (below).
- **Connector tabs**: a strip of `#1`, `#2`, … buttons (`role="tablist"`,
  each tab `aria-selected`), each with a dot in the connector's status color.
  The arrow keys, Home and End move the selection. Under the strip, the
  selected connector's card and, when a scenario run is live on that
  connector, its **run row** (below). A charge point without connectors shows
  **No connectors** instead.
- **The lower half**: the message log, or a section picked in **More**.

The same content is what the list's [side panel](#dashboard) shows. Two URL
parameters keep the view across the full page and the panel:

| Parameter        | Meaning                                                                                                                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `?connector=<n>` | The selected connector. Absent, or naming a connector the charge point does not have (for example a removed one), the first connector is selected. Choosing a tab replaces the history entry.             |
| `?tab=<section>` | The lower half: `transactions`, `analysis`, `diagnostics`, `expert` or `network`. Absent (or any other value) is the message log. The panel drops it when another charge point opens or the panel closes. |

**More** lists, in this order: **Message log**, **Transactions**, **Session
analysis**, **Diagnostics**, **Expert**, **Network simulation** (only when the
charge point has network simulation, that is, its snapshot's `networkSim` is
not `null`), **Scenarios** (a link to `/scenarios?cp=<id>`), and, after a
separator, **Delete** (red). Picking a section sets `?tab=` (replacing the
history entry) and swaps the lower half; the section's heading row has a
**← Message log** link back. **Diagnostics** is the state transition diagram
(Local mode only; its connector select starts on the selected connector).

**Delete** (#415), the last item of **More**, asks for a confirmation, removes
the charge point and goes back to the dashboard (from the side panel, it closes
the panel). In Remote mode it calls `cp.delete`, which also deletes
the charge point's persisted rows ([Control plane](../concepts/control-plane.md));
in Local mode it drops the charge point from the saved configuration. In Local
mode it refuses while that configuration has not loaded, instead of saving one
without any charge point. On a failure the page stays open and says why.

The **Charge point (connector 0)** row (#420) has the charge-point-level
calls of the classic charge point card, disabled while the charge point is
disconnected: the Heartbeat interval and when the last one was sent, with
**Send Heartbeat**; **Authorize** with a TagID from **Settings**; and **Send
status**, a StatusNotification for connector 0 (`Available`, `Unavailable` or
`Faulted`, the last with an error code, §7.6). A failed call shows its error in
the row.

Each connector card shows:

- the status, and the key figures as small uppercase labels over values:
  **Meter** (kWh), **SoC**, **Transaction** (`#<id>` and its TagID, or `—`) and
  **Availability** (`Operative` / `Inoperative`, set by ChangeAvailability,
  #422);
- a collapsed **Charging profiles (n)** list (#422): each profile's purpose,
  kind, stack level and schedule periods. The profile in effect is marked
  **Current**, and a profile whose every limit is 0 is marked **Paused**. The
  list follows SetChargingProfile / ClearChargingProfile live;
- **Start** / **Stop transaction** and **Set status**. **Faulted** is sent
  with the error code picked under the menu (#434): `InternalError` by
  default, any code but `NoError`, as in the classic side panel. Before #434
  the console sent none, so the charge point reported the connector's current
  error code (`NoError` unless something set one);
- **Meter & SoC** (#417), a dialog described below;
- **Auto meter values** (#418), described below;
- a trash button (#419) that removes the connector after a confirmation, as
  the classic card did. The removal is not saved: the connector comes back
  when the charge point is created again (a reload in Local mode, a daemon
  restart).

**Meter & SoC** opens a dialog that:

- sets the meter value (**Set**, **Set and send**);
- sets the SoC (**Set SoC**), or clears it (**Clear SoC**: the next
  MeterValues carries no SoC sample);
- sends a MeterValues with the current reading.

**Sync SoC and meter** derives one from the other with the EV's battery
capacity and initial SoC; it needs a capacity above 0 kWh. The flag is one
simulator-wide preference, applied to the connector when the dialog opens and
when it is toggled, as the classic side panel did; a connector whose
dialog was never opened keeps its own flag (on by default). Until the
preference is read, sync counts as off: the box is unchecked and disabled, and
**Set SoC** leaves the meter alone. If it cannot be read, the dialog says so
and sync stays off until the operator turns it on. A failed call, and a sync
choice the connector did not take or that was not saved, show their error in
the dialog.

**Auto meter values** opens the auto MeterValue editor for that connector: on
/ off, send interval and energy curve. It starts on the connector's live
configuration, else the one saved for it, else the default; when the saved
one cannot be read, the editor does not open (it would start on the default)
and the card says why. **Save** applies
the configuration to the connector, where a running transaction picks it up at
once, and saves it for the connector. The saved copy is only read back by this
editor: a restart does not restore it into the connector. The classic side
panel had the same editor wired, but no button opened it.

The **run row** under a connector's card shows the scenario run executing or
parked on that connector: its state, the scenario name, the current step and
`k/N`, the elapsed time, **Stop**, and the **Open run** link; while the run is
waiting, what it waits for with the wait controls (see
[Scenario editor](#scenario-editor-steps-and-graph)). There is no row without a
live run, and the runs are read once for the whole page and filtered by
connector.

The **lower half** (#421, #405) shows, by default, the charge point's **Message
Log** from the console's log buffer: a heading row with the entry count and
**Open in Message Log →**, a link to `/logs?cp=<id>` (the id URL-encoded); under
it a compact list, one line per message: the time, `↑` (sent) or `↓`
(received), the OCPP action and the payload, truncated (hover for the whole
line). A response names the action of the call it answers. The newest line is at
the bottom and the list follows it until the reader scrolls up; it draws the
latest 500 lines (the Message Log page has the rest). It is at most 340 px tall
in the side panel, and 70% of the window on the full page. The heading row has:

- **Download** saves every persisted log row of the charge point as JSON
  Lines (`ocpp-logs-<cp>-<timestamp>.jsonl`, the
  [log format](../concepts/log-format.md));
- **Clear screen** hides the lines on screen;
- **Clear screen + DB** also deletes the persisted rows (`logs.clear` in
  Remote mode). Before #421 the console's **Clear screen + DB** left the
  persisted rows in place.

The searchable, filterable log viewer (`LogViewer`) is the run console's;
its toolbar wraps instead of clipping when it is narrow (#405).

The global **Message log** page (`/logs`) has the same **Download**, for the
charge point picked in its filter or for all of them in one file
(`ocpp-logs-all-<timestamp>.jsonl`). It downloads the persisted rows, not the
filtered lines on screen. Its charge point filter is `?cp=<id>`: the page opens
with that charge point preselected (the link from the charge point page), and
picking one writes the parameter back (replacing the history entry); **All
charge points** removes it.

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
flag are edited in the header in both views, and under it the description and
the collapsed **Scenario EV Settings** (#424): the EV the scenario applies to
its connector when it starts, field by field (an empty field keeps the
connector's value; the placeholders show the Default EV Settings from
**Settings**); a scenario whose fields are all empty saves no EV settings.
The graph view does not rewrite the trigger from a **Status Trigger** node, as
the classic UI's graph editor did, so pick **On status change** in the header for a scenario that should start
on a status. A graph view opened because the scenario branches stays open
when an edit makes it linear again. Opening a scenario in the graph view is
not an edit: an edge to a missing node is hidden there, and leaves the saved
definition only with the first save after a graph edit. Before #411 a branching
scenario opened read-only, with a link to the classic UI's graph editor.

In the console, a connector's **run row** (under its card on the
[charge point page](#charge-point-page)) shows the run executing or parked on
it, and its **Open run** link opens the scenario's run
console (`/scenarios/run?cp=…&connector=…&id=…&run=<runId>`). The run
console **attaches** to a run that is already live in the runtime rather than
showing a fresh idle state: it hydrates the state (`running` / `waiting` / …),
current and already-executed nodes, the waiting expectation with its timeout
countdown, and the runId from `scenario_status`, and its **Stop** acts on that
run. Opening or reloading the page never starts a run; a run of the scenario
started elsewhere while the page is open (for example an auto-start trigger)
is attached the same way. When `run=` names a run that has ended or been
superseded, a banner says so (daemon only — local mode mints no runId) (#366).

While a run is `waiting`, the run row and the run console both offer **+30 s**
(only when the wait has a timeout), **Retry** and **Continue** beside the
waiting expectation ([Controls on a parked wait](../concepts/scenario-format.md#controls-on-a-parked-wait),
#240). The countdown follows the runtime's `waitDeadlineAt`, so an extension
shows at once, and a control the runtime refuses is shown inline instead of
being dropped. In Remote mode every open console re-reads the run on
`scenario_wait_changed`, not only the one that acted.

A charge point's **Expert** section (**More → Expert**) sends an
[expert OCPP call](../concepts/expert-ocpp-calls.md) (#389): pick any
station-initiated action of the CP's OCPP-J version, edit the JSON payload —
pre-filled with the smallest schema-valid one, **Reset to default** restores
it — and **Send**. The schema check runs as you type; a schema-invalid payload
is sent only with **Skip schema validation** ticked, and text that is not a
JSON object never is. **Apply the answer to the station's state** is off by
default. The section shows the frame as sent and the CALLRESULT or CALLERROR, or
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

The console shows the running build as `ocpp-cp-simulator vX.Y.Z · GitHub` at
the bottom of its sidebar (#364), as the classic UI's footer did (#93). It
comes from `src/lib/appBuildLabel.ts`: the package version stamped by the release
tooling (`__APP_VERSION__`), falling back to the short commit SHA on the
GitHub Pages deploy (`__APP_COMMIT__`, built from `main`); an unstamped dev
build shows no version rather than `v0.0.0`. In Remote mode the line also
shows the connected daemon's version, `· daemon vX.Y.Z`, from the `version`
of [`server.info`](../concepts/control-plane.md) (re-read on reconnect), since
the UI bundle and the daemon can be different releases — e.g. the hosted
console pointed at a self-hosted daemon. An unstamped daemon reports
`0.0.0-dev`. Local mode has no daemon and shows no daemon version; neither
does a daemon that predates `server.info`.

The console's dashboard (the connector cells and the Connectors view) and the connector cards format a connector's live readings
with
`src/lib/connectorFormat.ts`: the meter value, which is in Wh, as kWh with
2 decimals (`16208` → `16.21 kWh`), and the SoC with 1 decimal (`20.5%`). The
console's connector card shows `—` when no SoC is reported (#368).

The console promotes scenarios, charge points and logs to first-class routes,
where the classic UI nested them in panels.

## What the console can do

- Create charge points and connectors, connect to a CSMS over OCPP-J
  (1.6J / 2.0.1 / 2.1) or — in Local mode, send-only — the SOAP versions
  (see [OCPP versions & transports](../concepts/ocpp-versions-and-transports.md)).
  In Remote mode, when the daemon holds a SOAP public base (`--soap-tunnel
ngrok` / `--soap-public-base-url`), the SOAP callback URL is optional in the
  create / edit form — the derived value is previewed — and the charge point's
  **Config** form shows the effective URL with a **Copy** button, the value
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
