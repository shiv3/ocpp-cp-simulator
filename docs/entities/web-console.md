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
  - ../concepts/scenario-format.md
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
  detail (`/cp/:id`), a cross-CP **Scenarios** page (`/scenarios`, see
  [Scenarios page](#scenarios-page): the live **Active runs** and the
  **Library**, whose row `…` menu — Duplicate, Export JSON, Delete — opens in a
  portal and flips upward near the bottom of the window, so it is never clipped
  by the table, #365; a Library scenario is edited inline at
  `/scenarios?tab=library&edit=<id>`) with a per-connector editor
  (`/scenarios/edit`, see
  [Scenario editor](#scenario-editor-steps-and-graph)) and a read-only run
  page (`/scenarios/run`, see
  [Scenario runs](#scenario-runs-panel-and-page)), a cross-CP **Run history**
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
[Message Log](#message-log-page) page.

**Views.** A segmented control in the header (`role="group"`, label `View`;
the header reads: view switch, **All charge points** menu, **Add Charge
Point**) picks the layout. The choice is `?view=` in the URL; the Hierarchy
view is the default and leaves the parameter out.

| View (`?view=`)               | Shows                                                                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Hierarchy** (`hierarchy`)   | One row per charge point in one bordered card, with its connectors as a grid of small cells under it.                                                                                                                    |
| **Charge points** (`cp`)      | A table, one row per charge point: id, OCPP version, status, **In use** (`busy / total` connectors, busy = Charging, Preparing, SuspendedEV, SuspendedEVSE or Finishing), scenario badge or `—`, and the last Heartbeat. |
| **Connectors** (`connectors`) | A flat table, one row per connector: `<cp id> #<n>`, status, meter (kWh), transaction (`#<id>` or `—`), scenario run state or `—`, and the charge point's status.                                                        |

In the Hierarchy view a row's head holds, left to right: a **twist** button
(`Collapse connectors of <id>` / `Expand …`, `aria-expanded`) that folds the
connector grid away (kept on the page, not in the URL), a plug icon colored by
status, the id, the OCPP version as small muted text, the status (dot and text), the
**Scenario** badge (amber **Waiting: …** while a run is parked), the **Net
sim** badge, one small dot per connector (tooltip `#<n> <Status>`), and at the
right end, only while the charge point is connected, the last Heartbeat as
muted mono text (`heartbeat 3m ago`, `heartbeat never` before the first). The
list has no **Connect** / **Disconnect** button, in either view: connecting is
in the side panel's header and the **All charge points** menu. Status colors, for
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
the page, not the last keystroke). The connector filter is `?conn=`, not
`?connector=`: that one is the side panel's selected connector (see below) and
the two are independent. The comboboxes filter as you type; **Enter**
takes the first suggestion, **Esc** closes the suggestions (and does not close
the side panel), and **Clear** empties the field.

| Field (label)             | URL            | Matches                                                                                                                                                                                                                                                        |
| ------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Charge point** combobox | `?q=`          | A substring of the charge point id, case-insensitive. Suggestions: every id, with a status dot and the OCPP version.                                                                                                                                           |
| **Connector** combobox    | `?conn=`       | A connector number, `3` or `#3` (the URL holds `3`): connectors whose number equals it. Text that is not a number matches nothing; `#` alone does not filter yet. Suggestions: every connector number once, as `#n`.                                           |
| **Transaction** combobox  | `?tx=`         | A transaction id or part of one, `42` or `#42` (the URL holds `42`): connectors whose transaction id contains it, so `42` also finds `4207`. Text that is not a number matches nothing. Suggestions: every running transaction as `#<id>` with `<cp id> #<n>`. |
| **Status** select         | `?status=`     | The connector's OCPP status (the nine values, in enum order). An unknown value in the URL is ignored.                                                                                                                                                          |
| **OCPP version** select   | `?version=`    | The charge point's version (`config.ocppVersion` in Remote mode; in Local mode the shared config's), among the versions present in the list.                                                                                                                   |
| **Connected** checkbox    | `?connected=1` | Charge points that are connected: transport up, or a status other than Unavailable.                                                                                                                                                                            |
| **Scenario** checkbox     | `?scenario=1`  | Connectors with an active scenario run.                                                                                                                                                                                                                        |

The **connector-level** filters (Connector, Transaction, Status, Scenario) hide the
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
| `/?cp=<id>&tab=<section>` | The same, with that tab of the lower half.                    |
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
- **The connectors.** The full page shows **every connector at once**, like the
  classic UI: one [connector card](#connector-card) per connector, each followed
  by its own [scenario card](#scenario-card), in a grid with **up to four cards
  per row**: the cards are at least about 420 px wide, as many as fit share the
  row (never more than four), and fewer connectors share the width (two
  connectors on a wide window are two half-width cards, one is full width; a
  phone gets one column). Pure CSS, no measuring
  (`repeat(auto-fit, minmax(min(100%, max(420px, quarter)), 1fr))`). The card
  lays itself out by **its own width** (a container query, not the viewport):
  the battery sits beside the figures from about 400 px, the stepper goes
  compact under about 520 px (tighter padding and lines, the TagID select or
  `Tx #…` note on its own line), which also governs the card in the side
  panel. The side panel shows **one connector at a time**: a strip
  of `#1`, `#2`, … buttons (`role="tablist"`, each tab `aria-selected`, a dot in
  the connector's status color; the arrow keys, Home and End move the
  selection) over the selected connector's card and scenario card. A charge
  point without connectors shows **No connectors** instead.
- **The lower half**: an underline tab strip (`role="tablist"`, _Charge point
  sections_): **Message log** (the default), **Transactions**, **Session
  analysis**, **Diagnostics**, **Expert** and **Network simulation** (only when
  the charge point has network simulation, that is, its snapshot's
  `networkSim` is not `null`). The arrow keys, Home and End move along it.

The same content is what the list's [side panel](#dashboard) shows. Two URL
parameters keep the view across the full page and the panel:

| Parameter        | Meaning                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `?connector=<n>` | The selected connector. Absent, or naming a connector the charge point does not have (for example a removed one), the first connector is selected. In the panel it is the tab shown; on the full page it marks that card (an accent ring, `data-selected`) and scrolls it into view on load. It is also what the run panel (`?run=`) and the Diagnostics select use. Selecting one replaces the history entry. |
| `?tab=<section>` | The lower half's tab: `transactions`, `analysis`, `diagnostics`, `expert` or `network`. Absent (or any other value) is the message log. The panel drops it when another charge point opens or the panel closes.                                                                                                                                                                                                |

On the full page a click on a card's header (the title, status and
availability, not its **Config** / **Controls** buttons) selects that
connector. Picking a lower-half tab sets `?tab=` (replacing the history entry)
and swaps the content. **Diagnostics** is the state transition diagram (Local
mode only; its connector select starts on the selected connector).

**More** holds **Scenarios** (a link to `/scenarios?tab=library&cp=<id>`, the
Library filtered to this charge point) and, after a separator, **Delete**
(red); the sections moved to the tab strip. **Delete** (#415) asks for a
confirmation, removes the charge point and goes back to the dashboard (from the
side panel, it closes the panel). In Remote mode it calls `cp.delete`, which
also deletes the charge point's persisted rows
([Control plane](../concepts/control-plane.md)); in Local mode it drops the
charge point from the saved configuration. In Local mode it refuses while that
configuration has not loaded, instead of saving one without any charge point.
On a failure the page stays open and says why.

The **Charge point (connector 0)** row (#420) has the charge-point-level
calls of the classic charge point card, disabled while the charge point is
disconnected: the Heartbeat interval and when the last one was sent, with
**Send Heartbeat**; **Authorize** with a TagID from **Settings**; and **Send
status**, a StatusNotification for connector 0 (`Available`, `Unavailable` or
`Faulted`, the last with an error code, §7.6). A failed call shows its error in
the row.

#### Connector card

A connector card is the connector as a charging session
([`ConnectorCard.tsx`](../../src/console/pages/cp/ConnectorCard.tsx)), top to
bottom:

- **Header**: `Connector <n>`, its status, its availability (`Operative` /
  `Inoperative`, set by ChangeAvailability, #422), then **⚙ Config** (the
  [Config dialog](#config-dialog)) and **Controls ▾** (`aria-expanded`,
  `aria-controls`), which unfolds the [simulator controls](#simulator-controls)
  inside the card.
- **Session stepper** (`role="group"`, _Charging session_): **Plug in → Start
  charging → Stop charging → Unplug**, no numbers. Done steps carry a ✓
  (green), the next step is the primary button (▶), later steps are faint.
  Where the session stands comes from the connector: `Available` (or anything
  else without a transaction) → **Plug in**; `Preparing`, or a charging status
  without a transaction → **Start charging**, with a TagID select beside it
  (the TagIDs from **Settings**; with none it reads _No TagIDs configured_ and
  Start is disabled); a transaction → **Stop charging**, with `Tx #<id> · <tag>`
  at the right; `Finishing` → **Unplug**. `Faulted` marks the step it was at
  (**Charging (faulted)** with a transaction) with nothing to press;
  `Unavailable` disables every step and says _Unavailable: send Available in
  Controls to plug in_. Start calls `startTransaction(cp, n, tag)`, Stop
  `stopTransaction`. **Plug in** and **Unplug** send a StatusNotification
  `Preparing` / `Available` (`sendStatusNotification`): the simulator's
  `connectorPlug` scenario node runs a no-op callback, and the exported k6
  runtime sends exactly these, so the card does what the node means on the
  wire. While a step's call runs the stepper waits; a failure shows under it.
- **EV and battery**: an SVG battery whose fill follows the SoC (accent with a
  bolt while `Charging`, green once the SoC reaches the target, red when
  `Faulted`, the foreground grey otherwise), a dashed line at the EV's target SoC, and the
  SoC as the hero figure (`—` without one). Under it: _Target 80 % · about
  3 h 27 min at 7.4 kW · Tesla Model 3_; the time to target is (target − SoC) /
  100 × capacity ÷ power, left out without power or SoC, and _Target reached_
  once the SoC is there. The vehicle is the EV settings' model name, else the
  preset whose battery and power match, else _Custom EV_. The battery is also a
  range input (`aria-label="State of charge (drag)"`): the figure follows the
  drag and `setConnectorSoc` is called on release (with SoC ↔ meter sync on,
  the meter is moved to match, as the former Meter & SoC dialog did).
- **Figures** (a `dl`): **Energy added** (the register minus its value at
  transaction start, `of <capacity> kWh`, a 3 px bar), **Power** (the slope of
  the last two meter readings, kW, `max <EV max>`, a bar), **Session** (time
  since the transaction started, `Tx #<id>`) and **Meter** (the register in
  kWh). The readings are kept per connector by `useConnectorPower` from the
  `connector-meter` events and the snapshot, for the current transaction only:
  a new transaction id starts them over. Snapshots carry no `meterStart`, so a
  transaction the console meets half-way counts its energy from the first
  reading it sees.
- **Power this session**: the readings' power as a line over a 14 % area, the
  EV's max power as the top grid line, the configured auto meter curve as a
  dotted ghost on the same time axis, a dot at the latest reading, `start` and
  `now` ticks; _no transaction_ without readings. Under it the auto meter row:
  a switch (**Auto meter values**, `setAutoMeterValueConfig` with `enabled`
  toggled, from the live configuration, else the saved one, else the default),
  `every <n> s · <energy> kWh over <m> min, peak <p> kW[, stop at target SoC]`
  and **Edit curve…**, which opens the Config dialog on **Auto meter**.
- **Footer**: `Tag <tag>` while a transaction runs, and the collapsed
  **Charging profiles (n)** list (#422): each profile's purpose, kind, stack
  level and schedule periods, the one in effect marked **Current**, one whose
  every limit is 0 marked **Paused**; it follows SetChargingProfile /
  ClearChargingProfile live.

#### Config dialog

**⚙ Config** opens _Connector n · Config_
([`ConnectorConfigDialog.tsx`](../../src/console/pages/cp/ConnectorConfigDialog.tsx)),
a dialog with a vertical tab rail (`role="tablist"`, `aria-orientation="vertical"`;
it lies across the top on a narrow screen). It reads the connector's settings
when it opens; **Save** applies only what changed and closes, **Cancel** drops
it. A failed or refused value keeps the dialog open with the reason.

- **EV**: **Vehicle** (the presets of `EV_PRESETS` with their battery and
  power, and **Custom**; a preset fills Battery and Max power), **Battery**
  (kWh), **Max power** (kW), **Initial SoC** and **Target SoC** (%), checked on
  Save (battery and power above 0, SoCs within 0–100), then `setEVSettings`.
  **Sync SoC and meter through the battery capacity** is the simulator-wide
  preference that derives one from the other with the battery capacity and the
  initial SoC; it needs a capacity above 0 kWh. It is read when the dialog
  opens (`getSocMeterSync`) and applied to the connector then, as the former
  Meter & SoC dialog did; a toggle is staged until **Save**, which saves it
  (`saveSocMeterSync`) and applies it (`setConnectorSocMeterSync`). Until the
  preference is read the switch is disabled; if it cannot be read, the dialog
  says so.
- **Auto meter** (#418): **Enabled**, `every [n] s`, **Stop at target SoC**,
  the presets **Constant 7.4 kW**, **Ramp and hold** and **Taper (DC-like)**
  (under the EV's max power), and the **curve editor**: power (kW) over the
  session (minutes) as an SVG, points dragged with the pointer (kept between
  their neighbours, at whole minutes and 0.1 kW, and under the EV's max power,
  drawn as a dashed red line), a points table (minute, kW, ✕; at least two
  points) with **+ Add point**, and a summary (duration, energy over the curve
  and its share of the battery, peak, the number of MeterValues at the
  interval). It starts on the connector's live configuration, else the one
  saved for it, else the default; when the saved one cannot be read, the tab
  says so and offers no editor (it would start on the default). **Save**
  applies the configuration (`setAutoMeterValueConfig`; a running transaction
  picks it up at once) and stores it (`saveAutoMeterConfig`), reported apart.
  The saved copy is only read back by this dialog: a restart does not restore
  it into the connector.

The connector's `AutoMeterValueConfig.curvePoints` is **cumulative energy**
(kWh over seconds) that the simulator evaluates as one Bézier over all its
control points, not power samples, so the editor converts at the boundary
([`powerCurve.ts`](../../src/console/pages/cp/powerCurve.ts)): a constant power
is written as the exact two-point line; any other shape as its energy integral
sampled once a minute (at most 240 points, uniform times), which the Bézier
follows within a few percent, smoothed over a couple of minutes around a
corner. Reading, 12 or more uniform samples are read as samples; any other
curve is evaluated as the simulator evaluates it and turned back into the
fewest power points that draw it. An untouched curve is saved as it was. The
scenario editor's meter node keeps its own Bézier editor
(`MeterValueCurveModal`).

#### Simulator controls

**Controls ▾** unfolds, inside the card, _Simulator controls — what a real
charger would not do by itself_, three groups that each report their own
failure (`role="alert"`) and wait for their own call:

- **Readings**: SoC `[n] %` **Set** / **Clear** (`setConnectorSoc`; Clear
  means the next MeterValues carries no SoC; with sync on, Set also moves the
  meter), Meter `[kWh]` **Set** (`setMeterValue`, in Wh), **Send MeterValues
  now** (`sendMeterValue`). Until edited, the fields follow the live readings.
- **Status and faults**: a status and **Send status** (`sendStatusNotification`),
  an error code and **Send Faulted**: Faulted with that code (#434), any code but
  `NoError`, `InternalError` by default (before #434 the console sent none, so
  the charge point reported the connector's current error code). The
  availability line says the CSMS sets it with ChangeAvailability.
- **Connector**: **Plug in** / **Unplug** (the stepper's calls) and **Remove
  connector** (#419), which asks first. The removal is not saved: the
  connector comes back when the charge point is created again (a reload in
  Local mode, a daemon restart).

#### Scenario card

Under each connector card, its **scenario card**
([`ScenarioCard.tsx`](../../src/console/pages/cp/ScenarioCard.tsx)) shows the
scenario run executing or parked on that connector, else its
[Library](#scenario-library) scenario:

- **A run is live**: its name as the title, a link (`›`) to
  `/cp/<id>?connector=<n>&run=<scenarioId>` (the full charge point page with the
  [run panel](#scenario-runs-panel-and-page) beside it; from the list's side
  panel it switches to the full page), its state, `step k of N · <current
step> · <elapsed>`, **Open run** (straight to the
  [run page](#scenario-runs-panel-and-page)) and **Stop**; a 3 px progress bar
  under it; while the run waits, what it waits for with the wait controls (see
  [Scenario editor](#scenario-editor-steps-and-graph)). The runs are read once
  for the whole page and filtered by connector. The
  [Scenarios page](#scenarios-page) lists the runs of every charge point.
- **No run**: **No scenario running** — _Pick one from the Library to run on
  this connector._ — then a select (`aria-label="Scenario for connector <n>"`)
  of the Library scenarios, **None** first, showing the one the connector's
  copy came from (its `libraryId`). Changing it assigns at once: the
  connector's persisted definition set becomes exactly one copy of that
  scenario (or empty with **None**), and **Scenario set** shows for 2 s. A
  connector holding a definition that is not a Library copy shows it as a
  disabled `<name> (not in the Library)` entry. **▶ Run** (primary; disabled
  with **None**) starts the connector's copy (`runScenario`); should the
  runtime answer "not found", the copy is loaded into it and run again. **Edit
  in Library** opens the scenario in the Library editor
  (`/scenarios?tab=library&edit=<libraryId>`; for a definition that is not a
  copy, the per-connector editor). **Use on all N connectors** (on a charge
  point with more than one) assigns the same Library scenario to every
  connector, after a confirmation naming the connectors whose different
  scenario it replaces. A failed call is shown under the card.

#### Message log tab

The lower half's **Message log** tab (#421) is the
[Message Log page](#message-log-page)'s viewer (`LogViewer`) on this charge
point's lines, oldest first: the filter sidebar (Level, Type, Connector,
Direction, Action; no Charge point group, the lines are all this one's), the
toolbar (`<n> total / <m> filtered`, Auto-scroll, Download, Clear screen,
Clear screen + DB; it wraps, #405), the search box and the table. A heading row
above it has **Open in Message Log →**, a link to `/logs?cp=<id>` (the id
URL-encoded). It fills what is left of the side panel (at least 360 px) and is
480 px tall on the full page.

- **Download** saves every persisted log row of the charge point as JSON
  Lines (`ocpp-logs-<cp>-<timestamp>.jsonl`, the
  [log format](../concepts/log-format.md));
- **Clear screen** hides the lines on screen;
- **Clear screen + DB** also deletes the persisted rows (`logs.clear` in
  Remote mode). Before #421 the console's **Clear screen + DB** left the
  persisted rows in place.

The viewer replaced the compact one-line-per-message list the charge point
page used since the redesign. The run page shows no message log, so a run's
traffic is read here or on the Message Log page.

### Message Log page

The global **Message Log** (`/logs`) is the old log screen's shape, restyled
with the console's tokens: the `LogViewer`
([`log-viewer.tsx`](../../src/components/ui/log-viewer.tsx)) fills the window
under a header that keeps **Pause** / **Resume** (it stops the console's log
buffer from taking new lines, so it belongs to the page, not to the view).
The viewer has three parts:

- **Filter sidebar.** Groups with a checkbox and a count per value, a
  _Filter values_ box in each, folded by their uppercase heading: **Charge
  point** (shown once a line has arrived), **Level** (a status dot per level),
  **Type**, **Connector** (the ids a message names, `(none)` for the rest),
  **Direction** (Sent / Received, parsed from the OCPP frame) and **Action**
  (the OCPP action; a response takes the action of the call it answers). Ticking
  several values of one group matches any of them; groups combine with AND, and
  the counts are over all lines, not the filtered ones.
- **Toolbar** (wraps in a narrow window, #405): `<n> total / <m> filtered`,
  **Auto-scroll** (keeps the table at the newest line), **Download**,
  **Clear screen** and **Clear screen + DB**; under it a **search** box over the
  message text.
- **Table**: Timestamp (UTC, `HH:mm:ss.SSS`, mono), Charge point (with the
  group), Level, Type, Direction, Action (mono) and Message, one line each. A
  level, type and direction is a colored dot and its text, not a filled badge.
  A long message scrolls sideways instead of wrapping; the chevron at the start
  of the row expands it to the whole message with the first JSON object
  pretty-printed.

The newest line is at the bottom. The charge point group is `?cp=<id>`,
repeated for several (`?cp=CP-A&cp=CP-B`): the page opens with them ticked (the
**Open in Message Log →** link of the charge point page sets one, and an id no
line has yet stays listed), ticking writes the parameter back by replacing the
history entry, and unticking the last one removes it. **Download**,
**Clear screen** and **Clear screen + DB** act on the ticked charge points, on
all of them when none is ticked:

- **Download** saves the persisted rows, not the filtered lines on screen, as
  one JSON Lines file: `ocpp-logs-<cp>-<timestamp>.jsonl` for one charge point,
  `ocpp-logs-selected-…` for several, `ocpp-logs-all-…` for none ticked;
- **Clear screen** drops those charge points' lines from the console's buffer
  and leaves the persisted rows;
- **Clear screen + DB** also deletes their persisted rows (`logs.clear`, once
  per charge point); a failure is shown in an alert.

### Scenarios page

The Scenarios page (`/scenarios`) has the header **Scenarios** with the
Library's `<n> total` (Library scenarios, not the connectors' copies), the
**Import JSON** and **+ New scenario** actions, and two tabs under it. `?tab=library` opens the **Library**; without it (or with
any other value) the page opens on **Active runs**. Switching tabs replaces the
history entry and keeps the other parameters.

**Active runs** lists the live scenario runs (`running`, `waiting`, `paused`
or `stepping`) of every charge point, read per charge point like the scenario card
and re-read when a scenario event arrives on that charge point. It has:

- **State tiles**: **All** and one tile per state (running, waiting, paused,
  stepping) with its count. The tiles are the state filter: the pressed one
  sets `?state=<state>`, **All** clears it. The counts always cover every run,
  not the filtered list.
- Two comboboxes: **Scenario** (`?q=`, a substring of the scenario name; the
  options are the names of the live runs) and **Charge point** (`?cp=`, a
  substring of the id; the options are every charge point, with its status dot
  and OCPP version), and a `<shown> / <total>` counter. The filters replace the
  history entry, so a reload or a shared link shows the same list.
- One row per run: the state, the scenario name over `<charge point> #<connector>`,
  the current step with `k/N · <elapsed>` and a thin progress bar (left out
  while the scenario's node count is unknown), and the controls: **Skip** on a
  `waiting` run (continue past the parked wait, #240), **Next** on a `stepping`
  run (one step), and **Stop** on every run. A failed control is logged and
  shown under its row. There is no **Pause** or **Resume**: the service has no
  method for either, so a `paused` run only offers **Stop**.

The tab says **No scenario is running.** when no charge point has a live run,
and **No active run matches the current filters.** when the filters leave
none.

**Library** is where scenarios are kept and edited — see
[Scenario Library](#scenario-library) below.

Clicking a row of either tab opens the scenario in a **side panel** beside the
list (the same panel shell as the [Charge Points list](#dashboard): resize,
**Esc**, a click on the page's background, or the **Close side panel** button
closes it). The panel is in `?open=`, so a reload or a shared link reopens it;
each part is URI-encoded:

| `?open=`                            | Panel                                                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run:<cp>/<connector>/<scenarioId>` | An active run's row: the [run panel](#scenario-runs-panel-and-page).                                                                                                                                    |
| `def:<cp>/<connector>/<scenarioId>` | A Library row: the definition panel, `def:__library__/cp/<id>`. An older link naming a charge point's own scope (`cp` in place of the connector is its charge-point scope) still opens that definition. |

`&edit=1` beside `?open=` shows the panel's **edit mode** (see
[Editing in the side panel](#editing-in-the-side-panel)), so a reload keeps it;
with `?open=` the `edit` parameter is always this flag, never the Library
tab's inline editor (`edit=<id>`, which has no panel).

Opening from a closed page adds one history entry; clicking another row swaps
the panel and replaces it; clicking the open row again closes the panel.
Closing replaces the entry and keeps the tab and the filters; opening,
swapping and closing leave the edit mode. A click on the page background does
not close a panel in edit mode (its unsaved changes would be lost). A row's own
controls (**Skip**, **Next**, **Stop**, **Edit**, the enabled box, the
`…` menu) keep their job and do not open the panel. The open row is highlighted
(`data-selected="true"`).

The **definition panel** shows the scenario's name, `Library`, its step count
(and branch count), **Edit scenario** (the panel's
[edit mode](#editing-in-the-side-panel)), **Used by** — the
connectors assigned a copy of it, as chips linking to
`/cp/<id>?connector=<n>`, a running one marked with its run state's dot, or "no
connector uses it" — and its steps in the Steps view without any run state.

#### Scenario Library

Scenarios are edited in one place, the Library; each connector picks which
Library scenario it uses on the [charge point page](#charge-point-page).

**Storage.** There is no new table or schema change. A Library scenario is an
ordinary scenario definition stored through the per-scope definition API
(`scenario.definitions.*` in Remote mode) under the reserved charge point id
`__library__` with no connector; it keeps `targetType: "connector"` and no
`targetId`. No charge point is ever instantiated for that id, `state.reset`
wipes it with everything else, and `cp.delete` never touches it
([State persistence](../concepts/state-persistence.md)). A connector **uses**
a Library scenario when its own scope holds a copy of it: the scenario
retargeted to the connector, with `libraryId` naming the Library scenario
([scenario format](../concepts/scenario-format.md), v1.4) and the id
`<libraryId>@<cpId>#<connector>`, so assigning the same scenario again replaces
the copy rather than adding one. That copy is what the runtime, auto-start and
`listScenarios` read. The data model is kept behind the helpers of
[`src/console/lib/scenarioLibrary.ts`](../../src/console/lib/scenarioLibrary.ts).

**The tab.** The template gallery, the **Charge point** filter (`?cp=`, an
exact id: the scenarios some connector of that charge point uses; the charge
point page's **Scenarios** menu item opens it with this set) and **Enabled
only**, then one row per Library scenario:

| Column   | Shows                                                                                                                |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| Scenario | The name, the description under it (muted).                                                                          |
| Steps    | The step count of the Steps view's layout; a scenario that view cannot draw shows its node count and a `graph` chip. |
| Used by  | `<n> connectors` (the connectors holding a copy; the tooltip names them), or —.                                      |
| Running  | One state pill per live run of a copy, or —.                                                                         |
| Enabled  | A checkbox; a change saves the Library scenario and re-pushes it to its users.                                       |
| Edit     | **Edit** (the inline editor) and the `…` menu: **Duplicate**, **Export JSON**, **Delete**.                           |

**+ New scenario** asks for a name only and **Use template** and **Import JSON**
ask nothing: each creates a Library scenario (a template instance or an
imported file loses its connector target; an imported id already in the
Library gets a fresh one) and opens it in the editor. **Delete** confirms,
naming the connectors that use the scenario; it removes the copy from each of
them (their other definitions stay), then the Library scenario.

**The editor.** `?edit=<id>` opens the [editor](#scenario-editor-steps-and-graph)
in place of the table, with the header `← Library`, the name, the trigger, the
enabled flag and **Save**, and under it **Used by** chips (a running one
marked). Saving writes the Library scenario, then re-pushes the copy to every
connector using it, in parallel (each connector's copy keeps its id; its other
definitions stay), so **Save** reads **Save and apply to <n> connectors** when
there are any. Re-pushing replaces the connector's definition set, which the
daemon answers by reloading the connector's runtime and discarding a run in
flight: when a copy is running, a confirmation says **A run of this scenario
is active on <n> connectors and will be stopped. Save?** first.

**Migration.** State written before the Library existed has definitions only
on the connectors. When the Library tab opens with an empty Library while
charge points hold definitions, each distinct definition (keyed by
`templateId`, else by name) is copied into the Library once, and every
connector definition is re-saved with `libraryId` set to its Library entry
(keeping its id). It runs once per page load and logs a summary line
(`[scenario library] migrated …`); a non-empty Library makes it a no-op. A
Library emptied later (every scenario deleted) is filled again the same way on
the next load from what connectors still hold.

**Charge points arriving late.** The Library is read and watched on its own,
independently of the charge point list; the connectors' copies (Used by,
Running) are re-read when the charge point list changes and whenever a scope's
definitions change, so in Local mode, where the registry fills in after the
page mounts, a hard reload of `/scenarios?tab=library` still shows the
Library and its users.

### Scenario runs: panel and page

A scenario run shows in two places with the same content: the **run panel**
(beside the Scenarios page's Active runs, or beside the full charge point page
at `/cp/<id>?connector=<n>&run=<scenarioId>`, whose **Close** removes `run`
and replaces the history entry) and the read-only **run page**
(`/scenarios/run?cp=…&connector=…&id=…[&run=<runId>][&view=graph]`). Both
show the scenario name, `<charge point> #<connector>`, the run state,
`k / N · <elapsed>` and a progress bar, **Start** or **Stop**, the wait
controls while the run is parked, and **Edit scenario**: in the panel it
switches the panel to its [edit mode](#editing-in-the-side-panel)
(`&edit=1`, on the charge point page `/cp/<id>?connector=<n>&run=<id>&edit=1`);
on the run page it links to the [editor](#scenario-editor-steps-and-graph).
Either way a copy of a [Library scenario](#scenario-library) edits the Library
entry (its `libraryId`), and a definition that is not a copy edits itself. The
panel's expand button goes to the run page (with `run=<runId>`); the page's **← Back**
returns to where it was opened from (the panel, still open), else to
`/scenarios`. **Start** is disabled for a charge-point-scope scenario (it
runs per connector when its trigger fires). A run of a charge-point-scope
scenario on a connector is found in the charge point's scope, and **Edit
scenario** opens it there (or in the Library, for a copy).

The run page has no message log (the charge point page and the Message log
page hold the traffic); its **Run history** stays under the steps, full width.
It also has a **Steps | Graph** switch, kept in `?view=` (replacing the
history entry; Steps is the default). The panel always shows Steps.

- **Steps** — one box per step, top to bottom, numbered: the step type's tile,
  its title and summary, the state pill on the current step and a check on a
  done one; steps not reached yet are dimmed. When the scenario forks, the
  steps after the fork node stand in side-by-side columns, one per branch,
  each under a lane tag (`A`, `B`, … in the lane colour, the branch name —
  the first step's label, unless it is the type's default, else
  `Branch A`, … — and `done/total`). The executor starts every branch at
  once after the fork node.
- **Graph** — the same order drawn as connected cards: the chain in one lane,
  each branch curving into a lane of its own below the fork node; a travelled
  path takes its lane's colour. It is drawn by the console itself, not the
  editor's graph library.

Both views draw a chain, then at most one fork whose branches each run to
their end (END, a step with no next step, or an edge to a missing node). A
scenario with a join (two branches reaching one step), a loop, a second fork,
or a step no path reaches is shown as a flat list in definition order instead,
marked "order approximate". The layout is a pure function,
[`deriveStepLayout`](../../src/console/lib/stepLayout.ts).

### Scenario editor: steps and graph

The editor shows one scenario in two views, switched by the **Steps | Graph**
toggle and kept in the URL (`&view=steps|graph`). It opens inline on the
Library tab for a [Library scenario](#scenario-library)
(`/scenarios?tab=library&edit=<id>`, header `← Library`, **Save and apply to
<n> connectors**, **Used by** chips), as the per-connector editor
(`/scenarios/edit?cp=…&connector=…&id=…`, header `← Back`, the target chip and
**▶ Run**) for a definition of a charge point's own scope that is not a
Library copy, and in a [side panel](#editing-in-the-side-panel). **Edit
scenario** everywhere edits the Library entry when the scenario is a Library
scenario or a copy of one (`libraryId`). All use the same content
([`ScenarioEditorContent`](../../src/console/pages/scenarios/edit/ScenarioEditorContent.tsx)):

- **Steps** — the step boxes of the run views' Steps view: the chain, then at
  most one fork with its branches side by side. A click selects a step: its
  form opens in the inspector (beside the steps, sticky, when the editor is
  wider than about 860 px; under them when it is narrower), whose header moves the step up or down **within its
  lane** (the chain or its branch — a move never crosses lanes) and deletes
  it. Hovering the gap between two boxes of a lane shows a small `+`
  (**Insert step between n and n+1**) that opens the step picker there (as the
  old step list did); **+ Add step** under the chain and under each branch
  appends a step (inserting at the end of the chain of a forked scenario makes
  the new step the fork node). Each box has a grab handle (**Drag to
  reorder**) on its left: dragging it up or down shows a drop line where the
  box will land, a release moves it there (only within its lane), and
  **Escape** cancels; a focused box takes **Alt+↑ / Alt+↓** to move one place
  and **Delete** to remove it (asked first, in the page). **+ Add parallel
  branch** adds a branch holding one Delay step — to a chain, it creates the
  fork at the chain's last step (its first branch is the chain's own, empty,
  continuation to END). Deleting a branch's last step drops the branch, and a
  single remaining branch folds into the chain. Steps is the default for any
  scenario this view can draw.
- **Graph** — the same layout drawn as on the [run page](#scenario-runs-panel-and-page):
  connected cards, the chain in lane 0 and each branch curving into a lane of
  its own. A click selects a card for the inspector (the selected card gets a
  small ✕ that removes it); a `+` disc on the path after the last card of the
  chain and of each branch (**Add step after step n**; on an empty branch
  **Add step to <branch>**) and a `+` shown on
  hover between two cards of a lane (**Insert step between n and n+1**) open
  the step picker at that place; **+ branch** beside the fork node (beside
  the chain's last card when there is no fork yet) adds a parallel branch.
  A card drags up or down within its lane like a Steps box (the card follows
  the pointer over a drop line; a press that moves less than 6 px is a click,
  so it still selects; **Escape** cancels), and a focused card takes
  **Alt+↑ / Alt+↓** and **Delete** the same way. A scenario the layout cannot
  draw (a join, a loop, a second fork, a node no path reaches) opens the full
  node graph editor (ReactFlow: nodes, edges, the node palette,
  auto-arrange, undo / redo, a node panel — double-click a node, then
  **Apply**) under the line "This scenario has joins or loops; the full graph
  editor is used", with **Steps** disabled. Once open, that editor stays for
  the visit even when an edit makes the scenario drawable again (picking
  **Steps** leaves it).

The two views share the drag
([`useLaneDrag`](../../src/console/lib/useLaneDrag.ts), pointer events, no
drag-and-drop library) and the insert picker, so they behave the same. The
edits rebuild the graph's edges and positions
([`scenarioSteps.ts`](../../src/console/lib/scenarioSteps.ts),
`insertLaneStep` / `moveLaneStep` / `removeLaneStep` / `addParallelBranch`).

Both views edit the same definition: unsaved changes survive a switch, and
nothing is written until **Save**. The per-connector editor's Save saves this
scenario only (the connector's other scenarios are kept); the Library editor's
re-pushes it to its users. The name, trigger and enabled
flag are edited in the header in both views, and under it the description and
the collapsed **Scenario EV Settings** (#424): the EV the scenario applies to
its connector when it starts, field by field (an empty field keeps the
connector's value; the placeholders show the Default EV Settings from
**Settings**); a scenario whose fields are all empty saves no EV settings.
Whether the inspector (and its empty **Select a step** box) sits beside the
steps or graph or under them follows the editor's own width, not the
window's (a container query: two columns above about 860 px), on the page and
in a side panel alike. The inspector lays its fields out in two columns when
it is wide enough itself (under the steps) and in one beside them.
The full graph editor does not rewrite the trigger from a **Status Trigger** node, as
the classic UI's graph editor did, so pick **On status change** in the header for a scenario that should start
on a status. Opening a scenario in the full graph editor is
not an edit: an edge to a missing node is hidden there, and leaves the saved
definition only with the first save after a graph edit. Before #411 a branching
scenario opened read-only, with a link to the classic UI's graph editor; before
the Library, the Steps view showed only a single chain; before this round the
Graph view was always the ReactFlow editor.

#### Editing in the side panel

**Edit scenario** in the Scenarios page's definition panel and in a run panel
(the Scenarios page's Active runs, or beside the charge point page) turns the
panel body into the editor (`&edit=1`, kept on reload) instead of leaving the
page. The panel's header holds the name, **Save** (**Save and apply to <n>
connectors** for a Library scenario with users), **Cancel**, the expand button
(**Open in the Library editor**, or **Open in the editor** for a definition
that is not a Library copy: the editor page on the same scenario) and close;
the trigger and **Enabled** sit under it, then **Used by**, the description
and EV settings, the **Steps | Graph** switch, and the steps or the graph
with the inspector under them — or beside them, sticky, once the panel is
dragged wider than about 860 px of editor. **Cancel** returns to the read view; with unsaved
changes it first asks in the panel (**Discard unsaved changes?** —
**Keep editing** / **Discard**), not in a browser dialog. **Esc** in edit mode is the same
Cancel, on both the Scenarios page and the charge point page's run panel: it
returns to the read view at once when nothing changed, otherwise it shows
the same question and the panel stays open until it is answered (Esc no
longer closes an editing panel and drops its edits). The header's close
button asks the same way: a clean editor closes the panel at once; with
unsaved changes **Discard** closes it and **Keep editing** keeps it open
with the edits. Save behaves as on
the page: a Library scenario is saved to the Library and re-pushed to every
connector using it (with the same confirmation when a copy is running), a
definition that is not a copy is saved in its own scope. Leaving the edit
mode re-reads the run panel's definition.

In the console, a connector's [scenario card](#scenario-card) (under its card on the
[charge point page](#charge-point-page)) shows the run executing or parked on
it, and its **Open run** link opens the scenario's
[run page](#scenario-runs-panel-and-page)
(`/scenarios/run?cp=…&connector=…&id=…&run=<runId>`). The run panel and the
run page **attach** to a run that is already live in the runtime rather than
showing a fresh idle state: it hydrates the state (`running` / `waiting` / …),
current and already-executed nodes, the waiting expectation with its timeout
countdown, and the runId from `scenario_status`, and **Stop** acts on that
run. Opening or reloading them never starts a run; a run of the scenario
started elsewhere while the page is open (for example an auto-start trigger)
is attached the same way. When the run page's `run=` names a run that has ended or been
superseded, a banner says so (daemon only — local mode mints no runId) (#366).

While a run is `waiting`, the scenario card, the run panel and the run page offer **+30 s**
(only when the wait has a timeout), **Retry** and **Continue** beside the
waiting expectation ([Controls on a parked wait](../concepts/scenario-format.md#controls-on-a-parked-wait),
#240). The countdown follows the runtime's `waitDeadlineAt`, so an extension
shows at once, and a control the runtime refuses is shown inline instead of
being dropped. In Remote mode every open console re-reads the run on
`scenario_wait_changed`, not only the one that acted.

A charge point's **Expert** tab (the lower half's **Expert**) sends an
[expert OCPP call](../concepts/expert-ocpp-calls.md) (#389): pick any
station-initiated action of the CP's OCPP-J version, edit the JSON payload —
pre-filled with the smallest schema-valid one, **Reset to default** restores
it — and **Send**. The schema check runs as you type; a schema-invalid payload
is sent only with **Skip schema validation** ticked, and text that is not a
JSON object never is. **Apply the answer to the station's state** is off by
default. The section shows the frame as sent and the CALLRESULT or CALLERROR, or
why the call was refused; a SOAP CP gets a notice instead of the form. It
works in both modes.

The run page's **Run history** lists the daemon's recorded runs of that
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
In Local mode the run page keeps a history of this page view only, and the
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
