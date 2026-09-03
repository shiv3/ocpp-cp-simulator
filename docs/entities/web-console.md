---
title: Web console (browser UI)
type: entity
summary: The React + TypeScript browser UI — classic console at `/`, redesigned console at `/v3`, legacy at `/v1` — served from GitHub Pages (Local mode) or by the daemon / Docker image / desktop app (Remote mode).
sources:
  - src/ (React app)
  - index.html
  - vite.config.ts
related:
  - desktop-app.md
  - legacy-v1-ui.md
  - daemon.md
  - ../concepts/local-vs-remote-mode.md
  - ../concepts/state-persistence.md
updated: 2026-09-03
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
  a linear step editor and a separate run console (`/v3/scenarios`), a global
  **Message log** (`/v3/logs`), and **Settings** (`/v3/settings`, where
  global [network simulation](../concepts/network-simulation.md) and the
  **Reset all simulator data** button live).
- **`/v1`** — the original single-page UI (maintenance only) — see
  [Legacy v1 UI](legacy-v1-ui.md).

The two consoles link to each other with a design switcher (the classic
navbar's **New design** button ↔ the redesigned sidebar's **Switch to classic
design** button).

The redesign reuses the existing data layer, scenario engine, and per-step
forms unchanged; scenarios, charge points, and logs are simply promoted to
first-class routes instead of nested panels.

## What the console can do

- Create charge points and connectors, connect to a CSMS over OCPP-J
  (1.6J / 2.0.1 / 2.1) or — in Local mode, send-only — the SOAP versions
  (see [OCPP versions & transports](../concepts/ocpp-versions-and-transports.md)).
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
