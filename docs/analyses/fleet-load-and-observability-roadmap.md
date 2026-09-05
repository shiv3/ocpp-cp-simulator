---
title: Fleet, load and observability roadmap
type: analysis
summary: Sequenced plan for the capabilities this simulator does not yet have — bulk CP creation and blueprints, a metrics endpoint, seeded background traffic with an idTag pool, a charging-curve EV model, a measured scale ceiling, and file hot-reload — with the files and RPCs each phase touches, acceptance criteria, and dependencies.
sources:
  - src/protocol/methods.ts
  - src/cli/server/socketServer.ts
  - src/cli/server/httpServer.ts
  - src/cp/domain/connector/EVSettings.ts
  - src/cp/domain/connector/MeterValueBuilder.ts
  - src/cp/infrastructure/transport/network-sim/SeededRng.ts
  - scripts/bench/README.md
related:
  - ../concepts/control-plane.md
  - ../entities/daemon.md
  - choosing-an-interface.md
  - ../sources/github-issues.md
  - ../sources/bench-readme.md
updated: 2026-09-04
---

# Fleet, load and observability roadmap

This project can script one charge point precisely and say whether the CSMS
behaved. What it cannot do is stand up a _fleet_, run plausible traffic against
a CSMS for an hour, and hand back numbers. That is one coherent body of missing
work, and this page sequences it.

Everything here is motivated by what the project is for — AI-agent testing, CI
automation and CSMS development. Nothing on this list is here to fill out a
feature matrix; each item exists because a concrete CI or CSMS-development task
is currently impossible or has to be scripted by hand outside the daemon.

**How to use this page.** Each phase is shippable on its own and ordered by
dependency. Every item carries the files and RPCs it touches, its acceptance
criteria and a size. Per the [ingest rule](../../CLAUDE.md), the PR that ships
an item updates its row here — status and issue number — in the same commit, so
this page stays true as work lands.

Issue provenance for every row below is indexed in
[GitHub issues](../sources/github-issues.md).

**Size key:** S = a few files, one RPC. M = a new subsystem behind an existing
seam. L = crosses persistence, UI and the scenario schema, or changes the
runtime model.

## Status at a glance

| #   | Phase                                                        | Size | Depends on | Status      | Issue |
| --- | ------------------------------------------------------------ | ---- | ---------- | ----------- | ----- |
| 1a  | [Bulk CP creation](#1a-bulk-cp-creation)                     | S    | —          | shipped     | #295  |
| 1b  | [Multiple supervision URLs](#1b-multiple-supervision-urls)   | S    | —          | shipped     | #296  |
| 1c  | [CP blueprints](#1c-cp-blueprints)                           | M    | 1a         | shipped     | #297  |
| 1d  | [Built-in vendor blueprints](#1d-built-in-vendor-blueprints) | S    | 1c         | shipped     | #297  |
| 2   | [Metrics endpoint](#phase-2--metrics-endpoint)               | M    | —          | shipped     | #298  |
| 3a  | [idTag pool](#3a-idtag-pool)                                 | S    | —          | shipped     | #299  |
| 3b  | [Seeded background traffic](#3b-seeded-background-traffic)   | M    | 3a         | shipped     | #300  |
| 4a  | [Charging-curve EV model](#4a-charging-curve-ev-model)       | L    | —          | planned     | #301  |
| 4b  | [Signed meter values](#4b-signed-meter-values-optional)      | M    | 4a         | not filed   | —     |
| 5a  | [Measured scale ceiling](#5a-measured-scale-ceiling)         | S    | 1a, 2      | shipped     | #302  |
| 5b  | [Worker model](#5b-worker-model-conditional)                 | L    | 5a         | conditional | #302  |
| 6   | [File hot-reload](#phase-6--file-hot-reload)                 | S    | 1c, 3a     | not filed   | —     |

Two items are **not filed** as issues yet — 4b and 6 are the two whose payoff
is narrowest, and neither blocks anything else.

Two items are deliberately not unconditional. **5b** is gated on the number
that **5a** produces — building a worker model before knowing where the single
event loop actually breaks is speculative. **4b** serves only CSMS
implementations that validate German calibration-law (Eichrecht) meter data,
which few do.

## Phase 1 — Fleet shape

Today [`cp.create`](../concepts/control-plane.md#cpcreate-parameters) creates
exactly one CP from an explicit `cpId`. Everything fleet-shaped starts here.

### 1a. Bulk CP creation

**Goal.** One RPC creates N charge points that share a parameter block and
differ only by generated id.

**Shape.** Add `cp.create_many` rather than overloading `cp.create` — the
single-CP call returns one CP object and callers depend on that shape.

```
cp.create_many {
  count: number,              // 1..limit
  idPattern: string,          // e.g. "CP{n:03}" → CP001, CP002, …
  startIndex?: number,        // default 1
  ...cpParamsBase             // every existing cp.create field, shared
}
→ { created: string[], failed: { cpId, reason }[] }
```

Partial success is the honest result: one bad CSMS URL should not roll back 199
good CPs. Creation stays sequential so registry events fire in id order.

**Derive the schema — but from the right one.** `cpParamsBaseSchema` is not
it: it requires `cpId` (which bulk creation generates) and it does _not_ carry
`basicAuth`, which `createParamsSchema` adds by `.extend()`. So the bulk schema
is `createParamsSchema.omit({ cpId: true }).extend({ count, idPattern, startIndex })`.

One loose end to close while here: `autoConnect` is declared in no schema —
`createCp` reads it straight off the raw params
(`rawParamsAsRecord(rawParams).autoConnect`). Bulk creation should declare it
rather than copy that.

**Touches.** `src/protocol/methods.ts`, `src/cli/server/socketServer.ts`
(`dispatchRpcCore`), `src/cli/server/CPRegistry.ts`, a curated tool in
`src/cli/server/mcp/tools.ts`, and a CLI flag pair (`--cp-count`,
`--cp-id-pattern`) in `src/cli/main.ts`.

**Acceptance.**

- A `cp_create_many` tool is registered in `src/cli/server/mcp/tools.ts` — the
  curated tools are registered by hand there, so adding the method to `METHODS`
  alone would only reach it through the generic `call_method` — and its schema
  is _derived_, not restated (the lesson from #284).
- A documented, enforced `count` ceiling (`src/protocol/limits.ts`), and a row
  in [Control plane](../concepts/control-plane.md).
- e2e against gocpp: create 20 CPs, all reach BootNotification Accepted.

### 1b. Multiple supervision URLs

**Goal.** Point a fleet at a load-balanced CSMS.

**Shape.** `wsUrl` accepts `string | string[]`, plus
`urlDistribution: "round-robin" | "random" | "cp-affinity"` (default
`round-robin`).

**Failover semantics — state it, do not imply it.** `round-robin` and `random`
move to another URL on every reconnect attempt. `cp-affinity` hashes the `cpId`
to a **primary** and is sticky: it retries that primary and only falls over
after **three** consecutive failures — a fixed implementation constant
(`DEFAULT_AFFINITY_FAILOVER_THRESHOLD`), not a per-charge-point field — and
returns to the primary as soon as it is reachable again. "Sticky" and "always rotates" are contradictory, and
choosing between them silently is how an acceptance test ends up asserting the
opposite of the implementation.

**Scope it to OCPP-J, and resolve before persisting.** `wsUrl` is a `string`
well past the schema: `buildBaseUrl(wsUrl: string, cpId: string)` in
`src/cli/service.ts`, the `ChargePoint` init options, the status snapshot, and
`charge_points.ws_url TEXT NOT NULL` in `src/cp/domain/persistence/schema.ts`.
So:

- The list is an **OCPP-J** concept. SOAP takes `centralSystemUrl` and has no
  reconnect loop to rotate; reject an array there rather than half-supporting it.
- Resolve one URL at connect time, so the status snapshot and every log line
  keep reporting a single string.
- **Persist the list.** `charge_points` holds only `ws_url`, and
  `CPRegistry.restoreFromDatabase` restores only that, so a charge point
  created with a list would come back from `--state-db` with failover silently
  disabled — the one thing the list exists to provide. The list and the policy
  need columns of their own and a schema bump; `ws_url` keeps its meaning, so
  no existing reader changes.

**Touches.** `cpParamsBaseSchema` in `src/protocol/methods.ts`, the resolution
step in `src/cli/service.ts`, and URL selection in
`src/cp/infrastructure/transport/OCPPWebSocket.ts` beside the existing
exponential-backoff logic (~L820).

**Acceptance.** After a forced disconnect (reusing
[network simulation](../concepts/network-simulation.md)) `round-robin` lands on
the next URL while `cp-affinity` retries its primary; after the configured
three consecutive failures `cp-affinity` moves on, and returns to the primary
once it is reachable. A SOAP CP rejects an array `wsUrl` with a clear
error. The persisted `ws_url` and the status snapshot are unchanged in shape.

### 1c. CP blueprints

**Goal.** Name a CP configuration once, instantiate it many times. A
blueprint is a _hardware_ description (what this charge point is), where a
scenario is a _behaviour_ description (what it does) — the two compose.

**Shape.** Persist and address blueprints exactly like scenario definitions
already are (`scenario.definitions.*`):

```
blueprint.list   {}                       → Blueprint[]
blueprint.save   { blueprint }            → { id }
blueprint.delete { id }                   → {}
cp.create_many   { blueprintId, count, idPattern, overrides? }
```

A blueprint holds the `cp.create` parameter block plus connector count,
`vendor` / `model` / firmware / serial prefixes, default EV settings, an
optional startup scenario template id, and (after 3b) an auto-traffic config.

**Touches.** `src/protocol/methods.ts`, `src/cli/server/socketServer.ts`,
`src/cp/domain/persistence/schema.ts` (new table + migration — see
[State persistence](../concepts/state-persistence.md)), and a browser editor
alongside the scenario editor.

**Acceptance.** A blueprint round-trips through `--state-db` and survives a
daemon restart; `cp.create_many { blueprintId }` produces CPs indistinguishable
from the equivalent explicit call.

### 1d. Built-in vendor blueprints

**Goal.** `blueprint.list` returns useful defaults with no setup, the way
[scenario templates](../entities/scenario-templates.md) do today.

**Shape.** Ship a handful of realistic hardware profiles (AC 3-phase 22 kW, DC
50 kW, DC 150 kW+, single-connector, multi-connector) as read-only built-ins,
mirroring the instance semantics scenario templates already use: loading one
copies it, edits never mutate the built-in.

**Touches.** A new `src/utils/blueprints/` directory with a README that is the
authoritative id ↔ hardware mapping, exactly as `src/utils/scenarios/README.md`
is for cert16.

## Phase 2 — Metrics endpoint

**Goal.** A CI job or a Grafana board can answer "how many CPs are connected,
how many transactions are live, and what is p95 BootNotification round-trip?"
without parsing logs.

**Shape.** `GET /metrics`, Prometheus text exposition, hand-rolled — the format
is a few lines and this avoids a Bun-compatibility question on `prom-client`.

Series to start with: charge-point and connector gauges, an active-transaction
gauge, message and rpc counters, a CALL-duration histogram and a reconnect
counter. The **shipped** set is the canonical table in
[Daemon → Metrics](../entities/daemon.md#metrics) — it is not identical to what
this plan sketched: `outcome` turned out to be unnecessary on the message
counter (a CALLERROR is its own `ocppcp_ocpp_call_errors_total` series), and
#302 added `ocppcp_ocpp_call_timeouts_total` once it became clear the duration
histogram cannot see a CALL that is never answered, and then
`ocppcp_ocpp_pending_calls_evicted_total` beside it, because folding the
recorder's own correlation-cache overflows into the timeout counter made that
counter report load rather than failure — worst at exactly the fleet sizes 5a
below is trying to characterise.

**Cardinality.** Use only the bounded labels in the table above — `action`,
`direction`, `state`, `status`, `method`, `outcome` — and **never** `cpId` —
that is unbounded by construction once phase 1 lands. Per-CP numbers stay in
`cp.list` and the event stream.

**Latency source.** Both message handlers already track in-flight CALLs —
`_requests` / `_serialInFlight` in
`src/cp/infrastructure/transport/OCPPMessageHandler.ts` and `_pendingRequests`
in `OCPPMessageHandlerV201.ts`. Observe the histogram where those entries are
resolved. The [trace record](../concepts/trace-format.md) carries no duration
field, so this is a separate tap, not a trace consumer.

**Touches.** A route in `src/cli/server/httpServer.ts` beside the health probe
(~L483/565), a counter registry in `src/cli/server/`, and a CLI flag
(`--metrics` / `--no-metrics`).

**Access control — decide explicitly.** `/v1/healthz` is deliberately
unauthenticated so container probes work. `/metrics` is different: it exposes
fleet size and traffic shape. Default it **behind the existing Basic Auth
gate** — `--web-console-basic-auth-user` / `--web-console-basic-auth-pass`,
which already covers static assets, the Socket.IO handshake, `POST /mcp` and
the SOAP callback, and from which only the health path is exempt.
(`--basic-auth-user/pass` is the CSMS-facing credential and unrelated;
`--http-basic-auth-user/pass` is what `analyze --from-daemon` uses to
authenticate _to_ a daemon.) Add a documented opt-out flag for a trusted
network, and add the row to the policy table in
[Access control](../concepts/access-control.md#basic-auth-gate).

**Acceptance.** A scrape parses under `promtool check metrics`; the endpoint
returns 401 under `--web-console-basic-auth-user/pass` without credentials and
`/v1/healthz` stays exempt; counters survive a CP
reconnect.

## Phase 3 — Background load

Scenarios are deterministic graphs that end in a verdict, and they should stay
that way. "Run plausible traffic for an hour" is a different thing and needs a
different seam.

### 3a. idTag pool

**Goal.** Draw an idTag from a pool instead of hard-coding one.

**Shape.** A per-CP (or per-blueprint) pool — an inline list or a file path —
plus `distribution: "round-robin" | "random" | "connector-affinity"`. Random
draws come from the seeded RNG (below), so a seeded run replays exactly.

**Touches.** `src/protocol/methods.ts`, `CPRegistry`, and a `tagId` resolution
hook in the transaction path so both scenarios and auto-traffic can say "next
tag from the pool".

### 3b. Seeded background traffic

**Goal.** Endless plausible charging sessions in the background, so a CSMS
can be observed under continuous load — and **reproducible**, so a CI failure
under load can be replayed exactly.

**Design: this is a connector runtime behavior, not a scenario node.** The
precedent already exists in the codebase: auto-meter is a per-connector
behavior configured by RPC (`set_auto_meter_config`), persisted under
`connector_settings.auto_meter.*`, and independent of whether a scenario is
running (`AutoMeterValueConfig` in
`src/cp/domain/connector/Connector.ts`). Auto-traffic mirrors it exactly:

```
cp command:  set_auto_traffic_config { connector, config }
             get_auto_traffic_config { connector }
daemon:      connector_settings.auto_traffic.get / .save
```

```
AutoTrafficConfig {
  enabled: boolean,
  seed: number,                    // reproducibility
  minDurationSec, maxDurationSec: number,
  minGapSec, maxGapSec: number,
  probabilityOfStart: number,      // 0..1, gate per attempt
  requireAuthorize: boolean,
  stopAfterSec?: number,
}
```

Reuse `deriveSeed32` / the PRNG in
`src/cp/infrastructure/transport/network-sim/SeededRng.ts` — the same mechanism
that already makes [network simulation](../concepts/network-simulation.md)
replayable — deriving each connector's stream from `seed:cpId:connectorId` so
CPs do not correlate.

**Counters.** Expose per-connector attempted / started / rejected / skipped
authorize, start and stop counts on connector status — that is the assertion
surface. Phase 2 scrapes them **aggregated**, as
`ocppcp_auto_traffic_sessions_total{outcome}` and
`ocppcp_auto_traffic_skipped_total{reason}`: per-connector series would need a
`cpId` label, which the cardinality rule forbids.

**Interaction with scenarios — state the rule.** A scenario taking control of a
connector suspends auto-traffic for that connector and resumes it on scenario
end. A run's verdict must never depend on background traffic.

**Acceptance.** Two runs with the same seed produce the identical _sequence_ of
drawn gaps, durations and idTags. The seed fixes the draws, not the clock — the
timer path is `setTimeout` / `Date.now()`, so wall-clock timestamps still vary
between runs. Assert on the logical offsets the generator computed, or on
observed times within a stated tolerance; never on exact timestamps. Plus an
e2e against gocpp: 3 CPs for 60 s, session count within the expected band.

## Phase 4 — Meter realism

### 4a. Charging-curve EV model

**Goal.** MeterValues that a CSMS's load or billing logic can be validated
against. Today `MeterValueBuilder` derives everything from a flat auto-meter
rate with fixed 230 V / 25 °C / 50 Hz constants and no phase model.

**Shape.** Extend `EVSettings`
(`src/cp/domain/connector/EVSettings.ts`, currently `modelName`,
`batteryCapacityKwh`, `maxChargingPowerKw`, `initialSoc`, `targetSoc`):

```
chargingCurve?: { socPercent: number, powerFraction: number }[]  // piecewise linear, sorted
rampShape?: "linear" | "sigmoid"
currentType?: "AC" | "DC"
phases?: 1 | 3
voltageV?: number
powerFactor?: number        // AC only
```

`MeterValueBuilder` then derives `Power.Active.Import` from the curve at the
current SoC and current from the type-appropriate relation — DC has no
reactive component, so `I = P / V`; AC is `I = P / (V × phases × powerFactor)`
with `voltageV` read as **phase-to-neutral** — and emits per-phase values when
`phases: 3`. `P`, `I`, `V`, `SoC` and the energy register then agree with each
other rather than being independently plausible.

**Composition rule — state it in code and docs.** Effective power is
**`min(curve-derived power, ChargingScheduleResolver limit)`**. The smart
charging cap already works
(`src/cp/domain/connector/ChargingScheduleResolver.ts` →
`Connector.resolveEffectiveLimitWatts`) and must keep winning; the curve only
lowers demand, never raises it above a profile.

**This is the fan-out item.** It reaches `EVSettings.ts`,
`MeterValueBuilder.ts`, the `evSettings` block in the
[scenario format](../concepts/scenario-format.md) — which needs a **schema
version bump and a changelog entry** — `schema/scenario.schema.json`,
[state persistence](../concepts/state-persistence.md), the browser EV settings
UI, and `EvSettingsJson` in `src/cli/exportK6/runtime/types.ts`. Decide up
front: **the k6 export ignores the curve in v1** and keeps its flat rate,
rather than porting the model into the k6 runtime.

**Acceptance.** Old scenarios without a curve produce byte-identical
MeterValues (the curve is opt-in); a curved DC session shows power tapering
above the knee SoC; a SetChargingProfile below the curve still caps.

### 4b. Signed meter values (optional)

**Goal.** Serve CSMS implementations that validate German calibration-law
(Eichrecht) meter data.

**Shape.** The vendor-specific 1.6 configuration keys the ecosystem has
settled on — `SigningMethod`, `MeterPublicKey[ConnectorID]`, `SampledDataSign*`,
`AlignedDataSign*` — plus an OCMF-shaped payload emitted as
`format: "SignedData"`. The
`format: "SignedData"` enum member already exists in
`src/cp/domain/connector/MeterValueBuilder.ts`; nothing generates it.

**Do this only on demand.** It is niche, it is the one item with no CI or
agent-testing payoff, and signing keys add a key-management surface.

## Phase 5 — Scale

### 5a. Measured scale ceiling

**Goal.** Replace "no documented per-process limit" in
[Daemon → Limits](../entities/daemon.md#limits--roadmap) with a number.

**Shape.** A benchmark script (`scripts/bench/`) that uses 1a to create N CPs
against gocpp, drives heartbeats and transactions, and reads phase 2's
histograms to find where per-CP overhead starts distorting timing. Report the
knee for a stated machine.

**Acceptance.** The number, the method, and the machine are all in
`daemon.md`. This is the cheapest item on this page and it is what makes 5b a
decision rather than a guess.

**Shipped, number pending.** [`scripts/bench/fleet-bench.ts`](../../scripts/bench/README.md)
implements the shape above — it grows a fleet via `cp.create_many`, drives
both axes (idle heartbeat-only and active start/stop-transaction, staggered),
and diffs two `/metrics` scrapes to isolate one step's
`ocppcp_ocpp_call_duration_seconds` histogram, reporting p50/p95 plus
abandoned calls (`ocppcp_ocpp_call_timeouts_total`), errors and reconnects as
sharper knee signals. Its active axis is bounded by the control plane's
per-connection rate limit — ten pooled sockets sustain `N ≤ 320 ×
--tx-interval`, and a sweep past that is refused rather than run at less load
than configured. What is **not** done: no
real CSMS is available in this repository's CI or review sandboxes to
actually run it against, so
[Daemon → Measured scale ceiling](../entities/daemon.md#measured-scale-ceiling)
states the method and what to record rather than a number. Running it and
filling in that number is the remaining step before 5b can be decided.

### 5b. Worker model (conditional)

**Goal.** Push past the single-event-loop ceiling, if 5a shows the ceiling is
too low for real use.

**Shape.** Bun `Worker` threads, CPs sharded across them, the Socket.IO control
plane staying on the main thread and forwarding commands. The hard parts are
real and should be scoped before any code: `@socket.io/bun-engine` on the main
thread only, SQLite access from multiple threads
(`src/cp/domain/persistence/BunSqliteDatabase.ts` — one writer, or route all
writes through the main thread), and keeping the event stream ordered per CP.

**Decide after 5a.** If the ceiling is comfortably above what CI jobs ask for,
`export-k6` already covers the case where load must come from outside the
daemon, and this phase should be dropped rather than built.

## Phase 6 — File hot-reload

**Goal.** Edit a blueprint, scenario or idTag file and have running CPs pick it
up without a restart.

**Shape.** `fs.watch` with debounce on the files 1c and 3a make loadable, a
`--watch` flag to opt in, and an explicit rule for what a reload does to a CP
mid-transaction (answer: nothing — new settings apply to the next session).

**Last on purpose.** Only meaningful once blueprints and idTag pools are
file-loadable, and this project's agent-driven workflows go through RPCs rather
than files — so this serves the human editing a file by hand, which is the
narrower audience.

## What is explicitly not planned

- **Config-file-first operation.** The control plane is this project's
  primary interface. A config-file hierarchy that could also create and
  configure CPs would be a competing source of truth, and agent-driven and
  file-driven state would drift apart.
- **A performance-statistics storage backend** (MongoDB / ORM). Phase 2 exposes
  live metrics for a scraper to store; this project should not own a
  time-series store.
- **Dropping determinism.** Every random behavior added here is seeded, so a CI
  failure can be replayed.
