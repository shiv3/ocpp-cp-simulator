---
title: Log
type: log
summary: Append-only, chronological record of wiki operations (ingest / query / lint / restructure). Newest entries at the bottom.
updated: 2026-09-05
---

# Log

Format: `## [YYYY-MM-DD] <op> | <title>` then bullets of pages touched.
`grep "^## \[" docs/log.md | tail -5` shows the latest entries.

Entries before 2026-09-03 are backfilled from git history and record when
knowledge first entered the documentation, not wiki operations.

## [2026-06-01] ingest | SQLite persistence, log format, runtime-mode detection (d20ae64)

- Origin of what is now [State persistence](concepts/state-persistence.md), [Log format](concepts/log-format.md), [Local vs Remote mode](concepts/local-vs-remote-mode.md); `docs/docker.md` added (00331d5).

## [2026-06-17] ingest | CORS / reverse proxy, semver Docker tags, nginx + Authelia example (c61b67b, cdf6112, ce3f0d5)

- Origin of [Access control](concepts/access-control.md), [Reverse-proxy SSO example](sources/reverse-proxy-sso-example.md), the tag table in [Docker image](entities/docker-image.md).

## [2026-06-26] ingest | Socket.IO control-plane contract + REST/Unix migration guide (492c9c8)

- Origin of [Control plane](concepts/control-plane.md) and [REST → Socket.IO migration](analyses/rest-to-socketio-migration.md).

## [2026-06-30] ingest | OCPP 1.6 security profiles (#94) and OCPP 1.5 SOAP (#91)

- Origin of [Security profiles](concepts/security-profiles.md) and the SOAP section of [OCPP versions & transports](concepts/ocpp-versions-and-transports.md).

## [2026-07-14] ingest | Trace format PoC (#188), Testcontainers example (#111), web console redesign (#191)

- Origin of [Trace format](concepts/trace-format.md), [Testcontainers README](sources/testcontainers-java-readme.md), the `/v3` layout in [Web console](entities/web-console.md).

## [2026-07-21] ingest | analyze subcommand (#188), scenario JSON Schema (#214), Bun coverage (#215)

- Origin of [analyze](entities/analyze.md), [Scenario format](concepts/scenario-format.md), [Scenario JSON Schema](sources/scenario-json-schema.md), [Testing strategy](analyses/testing-strategy.md).

## [2026-07-22] ingest | MCP endpoint (#234), analyze --from-daemon (#235)

- Origin of [MCP endpoint](entities/mcp-endpoint.md); `--from-daemon` section of [analyze](entities/analyze.md).

## [2026-07-25] ingest | Network condition simulation Phase 1 (#242)

- Origin of [Network simulation](concepts/network-simulation.md).

## [2026-07-29] ingest | Certificate quirks / OCTT preset (#249), assertion severity + two-axis verdict (#250)

- Scenario format: `certQuirks`, `inboundPolicy`, severity, strict mode, OCTT strictness probe.

## [2026-07-30] ingest | export-k6 (#251), connect re-arm (#253), loaded-scenario validation + logs.get tail (#254), idempotent templates + real version (#255)

- CLI `export-k6`; scenario-format notes; control-plane `load_scenario` gate and `scenario_status` terminal state; log windowing; template instances; health `version`.

## [2026-08-04] ingest | connectionTrigger + payload-conditioned csmsCallTrigger + assertion frameRefs (#240)

- Scenario format v1.1 changelog.

## [2026-09-03] restructure | Rebuilt docs/ as an LLM Wiki

- Adopted the three-layer LLM Wiki pattern: raw sources (code, `schema/`, `vendor/`, `docs/examples`, `docs/images`, sibling READMEs, issues) → wiki (`docs/`) → schema (`CLAUDE.md`).
- Moved (with `git mv`, history preserved): `cli.md` → `entities/cli.md`, `server.md` → `entities/daemon.md`, `browser.md` → `entities/web-console.md`, `v1.md` → `entities/legacy-v1-ui.md`, `docker.md` → `entities/docker-image.md`, `scenario-format.md` / `trace-format.md` → `concepts/`, `migration.md` → `analyses/rest-to-socketio-migration.md`, `testing.md` → `analyses/testing-strategy.md`.
- Split `server.md` into [Daemon](entities/daemon.md), [Control plane](concepts/control-plane.md), [MCP endpoint](entities/mcp-endpoint.md), [State persistence](concepts/state-persistence.md), [Log format](concepts/log-format.md), [Network simulation](concepts/network-simulation.md), [Access control](concepts/access-control.md). Split `cli.md`'s `analyze` section into [analyze](entities/analyze.md); its JSON-command table now points at the single canonical table in Control plane.
- Split `browser.md` into [Web console](entities/web-console.md) and [Desktop app](entities/desktop-app.md).
- Moved README deep-dives into the wiki: SOAP → [OCPP versions & transports](concepts/ocpp-versions-and-transports.md); security profiles → [Security profiles](concepts/security-profiles.md); network simulation, persistence, web-console layout, Local/Remote → their concept pages; AI-agent section → [Driving from an AI agent](analyses/driving-from-an-ai-agent.md). README is now a landing page linking into the wiki.
- New pages: [Overview](overview.md), [Index](index.md), this log, [Conventions](conventions.md), [Scenario templates](entities/scenario-templates.md), [CSMS peers](entities/csms-peers.md), [OCPP DebugKit](entities/ocpp-debugkit.md), [Local vs Remote mode](concepts/local-vs-remote-mode.md), [Choosing an interface](analyses/choosing-an-interface.md), all ten `sources/` pages.
- Fixed while restructuring: `--scenario-template basic-charging` example used a non-existent template id (now `full-charging-cycle`); the three `network_sim_*` MCP tools were listed as header-less table rows (now their own table); the stray `state.reset` row inside the log-windowing note is now in the related-methods table; the README's "Contributing" pointed at a missing `AGENTS.md`.
- Updated path references in `src/cli/main.ts` (`--help` text), `src/cli/types.ts`, `src/trace/OcppTraceRecord.ts`, `src/cli/trace/TraceWriter.ts`, `src/cp/application/scenario/ScenarioTypes.ts`, `src/cli/analyze/__tests__/toolkitMeterAnomaly.test.ts`, `schema/scenario.schema.json`, `docker-compose.yml`, `examples/testcontainers-java/README.md`. `docs/examples/` and `docs/images/` stayed in place (Dockerfile / compose / e2e depend on the paths). The trace schema `$id` is kept verbatim.

## [2026-09-03] lint | Address CodeRabbit review on PR #279

- Security wording: Basic Auth over a non-loopback daemon needs a TLS-terminating proxy ([Access control](concepts/access-control.md)); Profile 1 sends `AuthorizationKey` in cleartext ([Security profiles](concepts/security-profiles.md)); use `wss://` whenever CSMS credentials are configured ([CSMS peers](entities/csms-peers.md)); SOAP `http://` examples marked local-only ([OCPP versions & transports](concepts/ocpp-versions-and-transports.md)); shared-network trust boundary documented for the SSO example ([Reverse-proxy SSO example](sources/reverse-proxy-sso-example.md)).
- Correctness: MCP described as a separate transport, not a Socket.IO client ([Overview](overview.md)); MCP example port matches the setup ([Driving from an AI agent](analyses/driving-from-an-ai-agent.md)); `-p` container-side port must match `HTTP_PORT` ([Docker image](entities/docker-image.md)); e2e suite filenames spelled out; steve-verify `--group` example made shell-safe; the link check in `CLAUDE.md` now covers bare relative links and `#fragments`.

## [2026-09-03] lint | Self-review against the code

- Template count corrected everywhere from 44 to 47 `cert16-*` test-case templates (+ OCTT probe); the raw steve-verify README still says 44 — flagged on its sources page.
- `bun run test:e2e` runs five suites, not three ([e2e README](sources/e2e-readme.md)).
- Network simulation also runs in browser Local mode (`LocalChargePointService`); RPC / MCP methods remain daemon-only ([Network simulation](concepts/network-simulation.md), [Local vs Remote](concepts/local-vs-remote-mode.md), [Choosing an interface](analyses/choosing-an-interface.md)).
- [Control plane](concepts/control-plane.md): documented the CP methods `reset` and `scenario_reset` and the browser-oriented daemon methods (`config.*`, `scenario.templates`, `scenario.definitions.*`, `connector_settings.*`, `ev_settings.apply_default`) that `src/protocol/methods.ts` defines but the old docs never listed.
- Verified against code: every CLI flag in `entities/cli.md` has a `case` in `src/cli/main.ts`; MCP tool names match `src/cli/server/mcp/tools.ts`; general-purpose template ids / names match `src/utils/scenarios/`; network-sim layers live in the `kv` table; RPC limits (30 s deadline, 64 in-flight, 100 calls/s) match `src/protocol/limits.ts`.

## [2026-09-03] ingest | Security profile 1 no longer forces `ws://` (#277)

- [Security profiles](concepts/security-profiles.md): transport column now reads "as configured" for Profile 1 and "`wss://` (upgraded)" for 2/3; new "Transport scheme rule" section (upgrade-only, warnings, pre-#277 behaviour, A00.FR.206 rationale); Profile-1-behind-a-TLS-proxy example added.
- [GitHub issues](sources/github-issues.md): #178 §1.2 / #277 row.
- Code: `src/cp/infrastructure/transport/wsUrlWithBasic.ts` (scheme rule + warnings), `src/components/ChargePointConfigModal.tsx` (form mirrors the rule), `src/cli/main.ts` (`--help`).

## [2026-09-04] ingest | `--tls-ca` semantics and the CSMS's vote on profile 2 (#289)

- [Security profiles](concepts/security-profiles.md): two new sections. `--tls-ca` is optional — without it the runtime's own bundled Mozilla root set verifies the CSMS — not the OS trust store, so a private root installed only in the OS keychain still needs `--tls-ca` — and passing it **replaces** the default roots rather than adding to them (verified on the daemon runtime: an unrelated CA fails a public `wss://` handshake). Separately, profiles 2/3 bind the station, not the CSMS: a CSMS behind a TLS-terminating proxy sees cleartext and may refuse a correct profile-2 station with `401`, so configure the CSMS before switching the station over.
- Profile 2 example split into a public-certificate form (no TLS flag) and a private-CA form.
- [GitHub issues](sources/github-issues.md): #289 row.

## [2026-09-04] ingest | A tag build verifies its own publish (#281, #287)

- [Docker image](entities/docker-image.md): the release-tag build now asks the registry for every tag it pushed and fails when one is missing, so a release note's image line cannot outlive the image. Context: `0.7.6` published notes for an image whose build had failed, and `0.7.1` was never republished.
- [GitHub issues](sources/github-issues.md): #281 / #287 row.

## [2026-09-04] ingest | The MCP charge-point tool stops being narrower than the method (#284)

- [Control plane](concepts/control-plane.md#cpcreate-parameters): the full `cp.create` parameter set is now a table of its own — the SOAP and security-profile fields were working, documented nowhere, and effectively undocumented public API. Records that unknown properties are stripped rather than rejected.
- [MCP endpoint](entities/mcp-endpoint.md): `cp_create` accepts every `cp.create` parameter, and its row says the schema is derived rather than restated.
- [GitHub issues](sources/github-issues.md): #284 row.

## [2026-09-04] ingest | Naming a refused handshake, and the error it reports (#288, #286)

- [Log format](concepts/log-format.md#websocket-handshake-failures): new section. A refused upgrade now logs the HTTP status behind it — measured, because Bun's native WebSocket reports 401, 404 and 301 identically and the daemon runs under Bun, so the status is fetched by replaying the handshake as one `GET`. Records the gating (once a minute per CP, only on a refused upgrade, never follows a redirect) and that browser local mode cannot do this.
- [Control plane](concepts/control-plane.md#rpc): the error codes get a table, `connect_failed` joins the closed union, and `connect` documents its semantics — resolves on open, rejects on the first close, reconnect loop continues afterwards.
- [MCP endpoint](entities/mcp-endpoint.md): error list points at the canonical table rather than restating a stale copy.
- [GitHub issues](sources/github-issues.md): #286 and #288 rows.

## [2026-09-04] ingest | Inbound SOAP requests are checked before they are answered (#285)

- [OCPP versions & transports](concepts/ocpp-versions-and-transports.md#inbound-cscp-request-validation): new section. A CS→CP request on a 1.6-S charge point is validated against its vendored schema and a malformed one gets a Fault naming the missing element, where six operations previously answered a plausible OCPP status and one leaked a JavaScript TypeError. Records the 1.6-S scope and why coercion stays on every dialect.
- [GitHub issues](sources/github-issues.md): #285 row.

## [2026-09-04] query | Sequencing the fleet-scale, load and observability work

- [Fleet, load and observability roadmap](analyses/fleet-load-and-observability-roadmap.md): new page. Twelve items in six dependency-ordered phases — bulk CP creation and blueprints, multiple supervision URLs, a `/metrics` endpoint, an idTag pool and seeded background traffic, a charging-curve EV model, a measured scale ceiling, file hot-reload — each with the files and RPCs it touches, acceptance criteria and a size. Two design calls recorded: background traffic is a per-connector runtime behavior configured by RPC (mirroring `AutoMeterValueConfig` / `connector_settings.auto_meter.*`), not a scenario node type, because scenarios are deterministic and end in a verdict; and the worker/thread model is conditional on the ceiling phase 5a measures rather than assumed. `/metrics` defaults behind the Basic Auth gate (unlike `/v1/healthz`) and never labels by `cpId`. The charging-curve EV model needs a scenario-format version bump, and effective power is `min(curve, ChargingScheduleResolver limit)`. Records what is explicitly not planned: config-file-first operation, a performance-statistics storage backend, and any unseeded randomness.
- [Index](index.md): analyses row.
- [Daemon](entities/daemon.md#limits--roadmap): the Limits section points at the roadmap; `related:` both ways.

## [2026-09-04] ingest | Bulk charge-point creation (#295)

- [Control plane](concepts/control-plane.md#cpcreate_many--the-batch-fields): new `cp.create_many` section. The batch shares every `cp.create` field but the generated id; `count` is capped at `CP_CREATE_MANY_MAX` (200) **in the schema**, because this is the one method that allocates unbounded resources per request. Two contracts recorded: partial success is a normal `ok: true` result (`{ created, failed }`) rather than a rollback, and creation is sequential so registry events arrive in id order. Notes that a `failed[].reason` falls back to the error code, since the daemon blanks the message for an "already exists" collision whose text could carry a CSMS URL.
- [Control plane](concepts/control-plane.md#cpcreate-parameters): `autoConnect` is now declared on `cp.create`'s schema. The handler had always honoured it by reading it off the raw params, which is why the MCP tool had to re-add it by hand; there is now one description of what the method accepts.
- [CLI](entities/cli.md): `--cp-count` / `--cp-id-pattern` bootstrap a fleet from the flags, and the multi-CP section leads with that instead of only pointing at the RPC.
- [CLI](entities/cli.md): the fleet registers before it dials, so `cp.list` answers against an unreachable CSMS instead of waiting out one 30s connect per charge point; connecting then runs 8 at a time. SOAP callbacks are derived per generated id from `--soap-public-base-url`, and an explicit `--soap-callback-url` must carry `{n}` — one address cannot route a fleet, and every create would have reported success while doing it.
- [MCP endpoint](entities/mcp-endpoint.md#curated-tools): `cp_create_many` joins the curated table; the count goes 16 → 17 here and in [Index](index.md).
- [Daemon](entities/daemon.md#starting-the-server): `--cp-count` / `--cp-id-pattern` repeated in the operator flag table, per the CLAUDE.md rule that daemon-only flags live on both pages.
- [Control plane](concepts/control-plane.md#cpcreate_many--the-batch-fields): each **expanded** id is capped at 256 characters — a pattern may repeat the placeholder, so the pad-width cap bounds nothing on its own — and each expanded `soapCallbackUrl` must contain `/<generated cpId>/`, since `SOAP{n}` against `SOAP{n:03}` ids advertises a route that does not exist while every create reports success. Both are checked before the first charge point is created.
- [GitHub issues](sources/github-issues.md): #295 row.

## [2026-09-04] ingest | Multiple supervision URLs (#296)

- [Control plane](concepts/control-plane.md#multiple-supervision-urls): new section. `wsUrl` accepts a list plus `urlDistribution` (`round-robin` default, `random`, `cp-affinity`). The list stays in the CP's config and one URL is resolved **per connection attempt**, so `cp.list`, `charge_points.ws_url` and the log lines keep seeing a single string — no DB schema or restore-path change. Records that `cp-affinity` is sticky with a failover threshold of 3 and that any success resets it to the primary, because "always return the primary" and "rotate like round-robin" are both wrong on their own; and that only an unrequested close counts as a failure, so a manual `disconnect` cannot push a CP off its primary. A list is OCPP-J only — SOAP has no reconnect loop to rotate, so it is refused rather than silently ignored.
- [State persistence](concepts/state-persistence.md): schema v7 adds `charge_points.supervision_urls` / `url_distribution`. Without them a charge point created with a list came back from `--state-db` on `ws_url` alone, with failover silently disabled and nothing to say so.
- [Control plane](concepts/control-plane.md#multiple-supervision-urls): every URL in the list is validated at creation, not just the first — a later entry is only reached on reconnect, where it is parsed inside a timer callback, so a malformed one would take the daemon down rather than fail over. Only genuine transport failures move the pool: a `disconnect`, a `reset` and an injected network-sim disconnect all leave it on its primary. An unrecognised `urlDistribution` is refused rather than defaulted.
- [GitHub issues](sources/github-issues.md): #296 row.

## [2026-09-04] ingest | Prometheus metrics on the daemon (#298)

- [Daemon → Metrics](entities/daemon.md#metrics): new section. `--metrics` serves `GET /metrics` as Prometheus text exposition; opt-in, so the path 404s without the flag. Eight metrics, catalogued. Records two decisions: **no `cpId` label** (unbounded once a daemon holds a fleet, and Prometheus pays for every series it has seen — per-CP detail stays in `cp.list` and the event stream), and gauges are read from the live registry **at scrape time** rather than tracked incrementally, because a charge point's state changes through many paths and a decrement-everywhere counter would drift.
- [Access control](concepts/access-control.md#basic-auth-gate): `/metrics` joins the Basic Auth gate and is explicitly **not** exempt the way `/v1/healthz` is — health says almost nothing and container probes need it unprompted, while `/metrics` exposes fleet size and traffic shape. `--metrics-no-auth` lifts the gate for that one path and nothing else.
- [Daemon → Metrics](entities/daemon.md#metrics): `ocppcp_transactions_active` counts a transaction _start time_, not a transaction id — the numeric id is `0` until the CSMS answers `StartTransaction` on 1.6 and is never set on 2.x. Message counters cover SOAP (the operation name is in the log line); the duration histogram is OCPP-J only, since a SOAP log line carries no message id to correlate on. Duration correlation is scoped by charge point, because OCPP message ids are unique only within a connection.
- [CLI](entities/cli.md): `--metrics` / `--metrics-no-auth` rows.
- [Daemon → Metrics](entities/daemon.md#metrics): `/metrics` is a reserved path — it answers 404 when disabled rather than falling through to the SPA fallback, which would hand a scraper `index.html` with status 200. `--health-path /metrics` with `--metrics` is refused at startup, since the health route matches first. Both metrics flags are in the operator flag table.
- [Daemon → Metrics](entities/daemon.md#metrics): `action` labels are bounded — the value comes off the wire, so a CSMS sending fuzzed actions would mint a permanent series each, the same unbounded-cardinality failure `cpId` is forbidden for. Anything that is not an OCPP-shaped name, or arrives past 128 distinct actions, is counted as `other`.
- [Daemon → Metrics](entities/daemon.md#metrics): `ocppcp_rpc_requests_total` is counted at the two boundaries that produce a final ack — socket.io's `handleRpc` and `runRpc` for the MCP tools and CLI client — not inside the dispatch they wrap. Parameter validation, the deadline and result validation all sit outside that dispatch, so counting there dropped every rejected request and recorded a failed result validation as `ok`. An unparseable or unknown method counts as `unknown` rather than minting a series per garbage value.
- [Daemon → Metrics](entities/daemon.md#metrics): SOAP Faults are counted as answers, the way a JSON `CALLERROR` is. Both the inbound server and the outbound handler returned faults without logging a reply line, so every failed SOAP exchange appeared as a request with no response.
- [GitHub issues](sources/github-issues.md): #298 row.

## [2026-09-04] ingest | Charge point blueprints (#297)

- [Control plane → Blueprints](concepts/control-plane.md#blueprints): new section. `blueprint.list` / `.save` / `.delete`, plus `cp.create_many { blueprintId }`. A blueprint is the **hardware** half (what a charge point is) where a scenario is the **behaviour** half; the two compose and neither knows about the other. Records three decisions: `wsUrl` is optional on a blueprint and required at instantiation (the CSMS is a property of the run, not of the hardware — the built-ins carry no URL), a parameter given alongside `blueprintId` overrides the blueprint's, and saving or deleting a built-in id is refused because `blueprint.delete` could never restore it.
- [Control plane → Blueprints](concepts/control-plane.md#blueprints): `cp.create_many`'s params are one object with a refinement rather than a union. A union's first matching branch wins and strips unknown keys, so `{ blueprintId, wsUrl, … }` matched the explicit branch and lost `blueprintId` silently — the batch came up with the caller's URL and none of the blueprint's hardware, reporting success.
- [State persistence](concepts/state-persistence.md): `blueprints` table, schema v8. Without `--state-db` the repository keeps blueprints in memory instead of dropping the save — the daemon's default is no database, and the common CI case saves a blueprint and instantiates it in the same run.
- [MCP endpoint](entities/mcp-endpoint.md): `blueprint_list` / `blueprint_save` tools; `cp_create_many` exposes `blueprintId`.
- [Control plane → Blueprints](concepts/control-plane.md#blueprints): a blueprint's `evSettings` reach every connector and its `scenarioTemplateId` is loaded onto each; copying only `params` left both silently unapplied, including for every built-in, where the EV settings are the point of picking a 150 kW profile. A charge point whose defaults fail is reported in `failed` rather than left half-configured in `created`. Blueprint ids and names must be non-empty, since an empty id stored a blueprint `blueprint.delete` refused to accept. One repository instance is shared by socket.io and MCP, or a blueprint saved over one transport was `not_found` over the other without `--state-db`.
- [Control plane → Blueprints](concepts/control-plane.md#blueprints): `idPattern` is optional for a blueprint batch and defaults to `<blueprintId>-{n:03}` — `{ blueprintId, count }` used to fail validation before the handler could default anything. A charge point whose blueprint defaults fail is **rolled back**, since it is registered and persisted before they run and leaving it behind would poison the retry. The blueprint's EV settings are passed to `loadScenarioTemplate` as the override, or the template's own settings would quietly undo them. At most 995 blueprints can be stored, because `blueprint.list` returns the built-ins under the same result cap; a stored row that no longer matches the schema is skipped rather than returned unchecked. The built-in catalogue is handed out deep-copied — `cp.create_many` passes a built-in's `evSettings` straight to `setEVSettings`, so a shared object would let one caller change what every later one gets.
- [GitHub issues](sources/github-issues.md): #297 row.

## [2026-09-04] ingest | idTag pool (#299)

- [Control plane → idTag pool](concepts/control-plane.md#idtag-pool): new section. `idTagPool` gives a charge point tags to draw from when a call names none, with `round-robin` (default), `random` (seeded by the `cpId`, so a run replays and a fleet does not draw in lockstep) or `connector-affinity`. Records that an explicit `tagId` always wins — `start_transaction` and `authorize` take it as optional now, and a charge point with no pool keeps the historical `123456`, named as `DEFAULT_ID_TAG` so its two call sites cannot drift. Exactly one of `tags` or `file`; an unrecognised `distribution` is refused rather than defaulted.
- [Control plane → idTag pool](concepts/control-plane.md#idtag-pool): `file` is resolved **once, at creation** — the list is what gets stored and persisted, so a file edited later cannot silently change a running charge point and a bad path fails the create rather than the first transaction.
- [State persistence](concepts/state-persistence.md): `charge_points.id_tags` / `id_tag_distribution`, schema v9. Without them a charge point created with a pool came back drawing nothing.
- [Control plane → idTag pool](concepts/control-plane.md#idtag-pool): the pool is carried through `CreateChargePointParams` and `toInitOptions` — the facade is exactly where #296's pool feature was silently dropped, and this one would have gone the same way. `cp.update` fully specifies the pool, so omitting `idTagPool` clears it. `start_transaction` / `authorize` forward an absent `tagId` instead of requiring one at the dispatcher, or the call was rejected before the pool could be consulted. A scenario reaches the pool through an `onResolveIdTag` callback the runtime binds to its connector — the executor has no charge point of its own. A `file` tag is bounded to 256 characters like the inline form, so the file is not a way around the identifier cap.
- [GitHub issues](sources/github-issues.md): #299 row.

## [2026-09-04] ingest | Seeded background traffic (#300)

- [Control plane → Background traffic](concepts/control-plane.md#background-traffic): new section. A per-connector runtime behaviour set by RPC (`connector_settings.auto_traffic.*`, `set_auto_traffic_config`), modelled on auto-meter — **not** a scenario node type, because scenarios are deterministic graphs that terminate in a verdict and a non-terminating random construct does not belong in them. The loop draws a gap, rolls `probabilityOfStart`, optionally authorizes, runs a session of drawn length, and repeats.
- [Control plane → Background traffic](concepts/control-plane.md#background-traffic): every draw is seeded on `seed:cpId:connectorId`, so two connectors and two charge points do not step in lockstep and a run replays. Records that the seed fixes the **draws, not the clock** — assert on drawn values or a tolerance, never exact timestamps — and that the duration is drawn before the probability roll, so the sequence does not depend on which attempts fired.
- [Control plane → Background traffic](concepts/control-plane.md#background-traffic): a scenario taking control **skips** the attempt rather than queuing it, since queuing would burst the moment the scenario ended. Per-connector counters (attempted / started / skipped / rejected / completed) are the assertion surface; a refused Authorize or failed start is counted and the loop continues.
- [State persistence](concepts/state-persistence.md): `connector_settings.auto_traffic`, schema v10.
- [Control plane → Background traffic](concepts/control-plane.md#background-traffic): the wiring, not just the loop — the config reaches the running charge point through `SingleCpCommandOps`, the registry facade and the remote adapter, an enabled config is **resumed on restart** (it lives in `connector_settings`, not the connector row, so it needs its own restore), and `stop()` ends a session this runner started rather than leaving it charging. Runners are stopped on every cleanup, not only a permanent one: `CPRegistry.update` cleans up non-permanently and then replaces the service, so a surviving runner would generate wire work from a discarded instance alongside its replacement. Validation checks that every required field is present and finite — a partial config validated, produced NaN gaps, and `setTimeout(NaN)` turned the loop into a hot spin.
- [GitHub issues](sources/github-issues.md): #300 row.

## [2026-09-04] lint | Cross-page consistency after #295–#300

Ran the CLAUDE.md lint workflow after the six fleet/load/observability PRs
(#295–#300) plus the roadmap page landed in quick succession. Findings and
fixes:

- [Control plane](concepts/control-plane.md): the CP command table still
  showed `start_transaction` / `authorize` requiring `tagId`, contradicting
  the idTag-pool section's own claim (#299) that it is optional; marked both
  `tagId?`. Added the `set_auto_traffic_config` / `get_auto_traffic_config`
  CP commands (#300) and the `blueprint.list/.save/.delete` and
  `connector_settings.auto_traffic.get/.save` daemon methods (#297, #300) to
  their canonical tables — they existed in `EXPLICIT_METHODS` / `METHODS` and
  in dedicated subsections, but not in the summary tables the other daemon
  methods are listed in. Corrected the `cp.create_many` batch-fields table:
  `idPattern` is required only when `blueprintId` is absent, not
  unconditionally. Linked the bare `src/utils/blueprints/README.md` path.
- [State persistence](concepts/state-persistence.md): the `## Tables` section
  had two copies of the same table pasted back to back (a rebase artifact),
  disagreeing with each other — only the second copy's `charge_points` row
  mentioned the idTag-pool columns (v9, #299), and only the first copy had a
  `blueprints` row at all. Merged into one table, folding in both facts, and
  added a `connector_runtime` row that neither copy had (pre-existing table
  the catalog had never listed). Updated the `.tables` example output to
  match the current 12 tables.
- [GitHub issues](sources/github-issues.md): `#298` was listed twice with
  different link sets (once linking only the roadmap, once linking
  `daemon.md#metrics` / `access-control.md#basic-auth-gate`); merged into one
  row carrying all three links, at its numeric position. Added the roadmap
  link to the `#295` row and a pointer from it to `daemon.md`'s `--cp-count`.
- [Driving from an AI agent](analyses/driving-from-an-ai-agent.md): "16
  curated tools" was stale — `cp_create_many`, `blueprint_list` and
  `blueprint_save` shipped since that count was written; the daemon and MCP
  pages already said 19. Corrected to match.
- [Daemon](entities/daemon.md#limits--roadmap): "Planned: fleet-scale
  creation, a metrics endpoint, seeded background traffic…" was stale — all
  three (plus supervision URLs and the idTag pool) have shipped. Reworded to
  Shipped/Planned, matching the roadmap page's status column (left untouched,
  per instructions).
- This log: the idTag-pool ingest entry (`## [2026-09-04] ingest | idTag pool
(#299)`) had the same schema-version bullet twice, once correctly saying
  `schema v9` and once (a rebase artifact, same cause as the state-persistence
  duplication above) saying `schema v8`. Deleted the incorrect duplicate
  rather than leaving self-contradictory history; noted here since `log.md`
  is otherwise append-only.
- Clean: MCP tool count (19 curated + 3 network-sim, code / `mcp-endpoint.md`
  / `index.md` agree); CLI flag table in `entities/cli.md` against every flag
  parsed by `src/cli/main.ts` and against the daemon-only table in
  `entities/daemon.md`; `SCHEMA_VERSION` (10) against every schema-version
  claim once the above was fixed; scenario node types (23, `scenario-format.md`
  vs `schema/scenario.schema.json`); template counts (6 general + 47 `cert16-*`
  - 1 OCTT probe); Prometheus metric names (`entities/daemon.md` vs
    `metrics/render.ts`); `--cp-id-pattern` default; broken links / anchors (the
    CLAUDE.md checker script, 0 problems); orphans (every page has an inbound
    link besides `index.md`); `index.md` catalog (bijective with pages on disk);
    missing pages (no cross-cutting concept mentioned on 3+ pages without a
    home).
- Left alone: `analyses/fleet-load-and-observability-roadmap.md` status rows
  (#301/#302 are in flight and own them); `src/utils/blueprints/README.md`
  has no `docs/sources/` summary page yet, which is an ingest gap from #297
  rather than a lint-fixable inconsistency — flagged for a human/ingest pass,
  not created here.

## [2026-09-04] lint | Curated MCP tools narrower than their methods (#284-class); `--help` gaps (#295, #298)

- [MCP endpoint](entities/mcp-endpoint.md): `start_transaction` / `authorize` tools declared `tagId` required after #299 made it optional on the RPC methods, rejecting the call at the schema level before the idTag pool could ever be consulted. `set_connector_status` and `run_scenario_template` were missing optional fields their methods already accept (`info` / `vendorErrorCode` / `vendorId` / `timestamp` / `suppressChargingStateTransactionEvent`, and `evSettings` / `strict`). All four fixed in `src/cli/server/mcp/tools.ts`; the tool/param table updated to match.
- [MCP endpoint](entities/mcp-endpoint.md): generalised `mcpToolSchemaParity.test.ts` to check every curated tool (field presence + requiredness) against the method it wraps, not just `cp_create` / `cp_create_many`. `network_sim_get` / `network_sim_set` (dispatch to one of two methods) and `call_method` / `list_methods` (generic by design) get targeted assertions instead; `cp_create_many`'s schema intentionally omits `cp.create_many`'s cross-field refinement, not any field, and is asserted as such.
- [Control plane → idTag pool](concepts/control-plane.md#idtag-pool): the CP command methods table still showed `start_transaction` / `authorize`'s `tagId` as required, contradicting this same page's own prose. Corrected to `tagId?`.
- [CLI](entities/cli.md): `--cp-count` / `--cp-id-pattern` (#295) and `--metrics` / `--metrics-no-auth` (#298) were listed in `docs/entities/cli.md`'s flag table and in `--help`'s terse "Server modes" summary, but had no entry in `--help`'s detailed `Options:` section like every other flag. Added.
- [CLI](entities/cli.md): `--header` and `--ws-subprotocol` were in the flag table but appeared nowhere in `--help` at all, not even in a mode summary. Added, and the help test generalised from a list of four known-missing flags to the property itself: every flag `src/cli/main.ts` parses must have its own `Options:` entry, except the six mode selectors (`--daemon`, `--send`, `--stop`, `--events`, `--json`, `--help`), which choose what the process does and are asserted to appear in a mode summary instead. Three of these gaps had survived several releases precisely because the check was a hand-comparison.
- Checked and left open (report only): `docs/concepts/control-plane.md`'s `update_connector_status` row lists only `connector`/`status`, omitting the same optional fields the RPC method (and now the MCP tool) accepts — pre-existing understatement, not something #299 or this pass changed.

## [2026-09-05] ingest | Desktop sidecar could not find the web console (#319)

- [Desktop app](entities/desktop-app.md): new section "How the sidecar finds the web console" — `frontendDist` is embedded in the Rust binary and serves only `splash.html`, so the bundle now ships `dist/` a second time as the `bundle.resources` entry `{"../dist/": "web-console/"}`, and `src-tauri/src/lib.rs` hands the sidecar `--web-console-dist <resource-dir>/web-console` resolved with Tauri's `resource_dir()`. Records why v0.3.2 through v0.7.8 (~30 releases) shipped a daemon that exited 1: `resolveBundledDist()` walked up from `import.meta.dir`, which inside a `bun build --compile` binary is `/$bunfs/root`, so it resolved to `/dist`.
- [CLI](entities/cli.md), [Daemon](entities/daemon.md): new `--web-console-dist <dir>` row in both flag tables (kept in sync deliberately, per CLAUDE.md). `--web-console`'s row no longer says only "requires built `dist/`" — it lists the four places a console can come from and notes that the failure names every path searched.
- [Testing strategy](analyses/testing-strategy.md): new section "Does anything actually launch the desktop daemon?". CI compiled the sidecar but never ran it, which is precisely why #319 survived 30 releases. `src/build/__tests__/tauriSidecarWebConsole.bun.test.ts` now compiles and launches it on every PR under `test:bun`, parsing the arguments out of `lib.rs`'s `DAEMON_ARGS` and the readiness budget out of `splash.html` so neither copy can drift.
- [GitHub issues](sources/github-issues.md): #319 indexed.
- Left as-is, reported not fixed: `dist/` is now bundled twice on the desktop (embedded in the Rust binary for `splash.html`, and as a resource for the daemon). Deduplicating it would mean serving the console over `tauri://` instead of HTTP, which is a different architecture, not a doc fix.

## [2026-09-05] ingest | The CLI distribution was broken twice over (#320, #321)

Both defects are the same surface — how the CLI reaches a user — so they were
fixed and ingested together.

- [CLI → What the package ships](entities/cli.md#what-the-package-ships): new
  section. `package.json#files` had drifted to a mix of directories and
  individual files and was missing `src/data`, `src/ocpp`, `src/trace` and
  `vendor/`; `src/cli/main.ts` statically imports `../data/sqlite/…`, so the
  published tarball died on its first import and even `--help` exited 1
  (#320). Broken since 8a0fda5 (2026-07-01); the last actual CLI release,
  `cli-v0.3.1` (2026-06-02), predates it, so no published artifact was ever
  affected — the next one would have been. `files` is now eleven directories,
  each one mutation-proven load-bearing (drop any single entry and `--help`
  fails), and the same set the `Dockerfile` COPY list carries.
- [CLI → Why `cli-latest` and not `releases/latest`](entities/cli.md#why-cli-latest-and-not-releaseslatest):
  new section. The documented install URL used `releases/latest/download/…`,
  which GitHub resolves across both tag trains (`v*` desktop, `cli-v*` CLI);
  with `v0.7.8` newest it redirected to a release carrying no `.tgz` and
  404'd — the steady state for half of any release cycle, not a transient
  (#321). Replaced everywhere by `releases/download/cli-latest/…`, a rolling
  pre-release `cli-release.yml` re-points on every CLI release. Pre-release
  status is deliberate: GitHub never resolves `releases/latest` to one, so the
  pointer cannot hijack the desktop train's badge. Chosen over pinning the
  docs to a `cli-v*` tag (needs a human to remember) and over attaching the
  `.tgz` to desktop releases (couples the two trains and ships CLI tarballs
  under desktop version numbers).
- [Docker image → Image details](entities/docker-image.md#image-details): notes
  that the runtime `COPY` list and `package.json#files` are the same set and
  links to the CLI page's canonical table rather than repeating it.
- [`README.md`](../README.md): the quick-start install commands (pnpm and bun)
  and the pinned example (`cli-v0.1.0` → `cli-v0.3.1`) updated to match.
- [GitHub issues](sources/github-issues.md): #320 and #321 added.
- Raw sources changed in the same commit: `package.json#files`; new
  `scripts/verify-cli-tarball.sh` (installs the tarball into a throwaway
  global prefix and boots it — `--help`, `bun build --compile` over the
  installed tree, daemon `/v1/healthz` with a CP bootstrapped, web-console
  shell when `dist/` ships); `.github/workflows/cli-release.yml` (the three
  `tar -tf | grep` verify steps replaced by that script, rolling `cli-latest`
  pointer, post-publish install from the documented URL, release-notes body);
  `.github/workflows/ci.yml` (the packaging smoke and an install-URL
  consistency guard now run on every pull request — previously no CI job
  touched the tarball at all, which is why a July regression would only have
  surfaced at the next release).

## [2026-09-05] ingest | The install URL must resolve, and the pointer must not roll back (#320, #321)

Follow-up to the same-day ingest above, from review on PR #325.

- [CLI → Why `cli-latest` and not `releases/latest`](entities/cli.md#why-cli-latest-and-not-releaseslatest):
  rewritten. The previous revision documented
  `releases/download/cli-latest/ocpp-cp-simulator.tgz` as the primary install
  command, but the rolling release it names is created by `cli-release.yml` on
  the next `cli-v*` push and does not exist yet — so a change whose purpose was
  fixing a 404 in the quick start would have merged with the quick start still
  404ing, for a new reason. The pinned `cli-v0.3.1` URL (verified HTTP 200) is
  primary until then; the page carries a **Rollout status** paragraph saying
  who can close the gap (a maintainer with release rights, by cutting a
  `cli-v*` release) and that the CLI release which first creates the pointer is
  the one that swaps the URLs.
- [CLI](entities/cli.md#why-cli-latest-and-not-releaseslatest): documents that
  the pointer only ever moves forward. The move was an unconditional
  force-push plus `gh release upload --clobber`, so re-running an older tag's
  workflow — or two release jobs finishing out of order — would have left
  `cli-latest` serving an older package under the URL the docs call the newest.
- [`README.md`](../README.md): the two quick-start commands now use the pinned
  URL, with the rolling form named in prose rather than advertised as a
  runnable command.
- Raw sources changed in the same commit: new `scripts/verify-install-urls.sh`
  (**fetches** every advertised install command and fails on anything but 200;
  the previous guard only checked that the places restating the URL agreed with
  each other, which is no guard at all — several places agreeing on a broken
  URL is precisely the reported defect); new `scripts/roll-cli-latest.sh`
  (reads the version the pointer holds from a machine-readable marker in its
  release body and refuses to move backwards, re-running the same version still
  allowed so a failed upload can be retried); `.github/workflows/cli-release.yml`
  (calls the roll script, and a workflow-level `concurrency:` group serialises
  release runs because the read-then-write is not atomic on its own);
  `.github/workflows/ci.yml` (runs the URL guard on every pull request).

## [2026-09-05] ingest | Guards that fail open, abort, or cancel what they protect (#320, #321)

Second review pass on PR #325. Four findings, all in the machinery added by
the previous two commits rather than in the original defects — three of them
about the guard's own failure modes rather than its happy path.

- [CLI → Why `cli-latest` and not `releases/latest`](entities/cli.md#why-cli-latest-and-not-releaseslatest):
  the "only moves forward" paragraph is now a table of every way the pointer
  move can fail and which direction each one points. The rules that changed:
  a pointer lookup that fails as anything other than a confirmed 404 fails the
  release instead of being read as "does not exist yet" (which skipped the
  roll-back check and force-moved the tag); a pointer release carrying no
  version marker initialises the marker with a `::warning::` instead of
  aborting the script, which is the state the first hand-created pointer would
  be in; a malformed marker fails the release rather than guessing an
  ordering; and prerelease / build-metadata versions are refused outright,
  because `sort -V` is not SemVer-aware — it orders `1.0.0-rc.1` after
  `1.0.0`, so re-running a prerelease after the stable release would have
  rolled the pointer backwards, the exact bug the check exists for. Versions
  are now compared numerically field by field. The asset is uploaded before
  the marker is written and before the tag moves, so a partial failure leaves
  the marker naming the version the pointer really serves.
- [CLI](entities/cli.md#why-cli-latest-and-not-releaseslatest): new paragraph
  on why only the pointer move is serialised. The previous commit put a
  workflow-level `concurrency:` group on `cli-release.yml`, which was a
  regression: GitHub cancels the _pending_ run when a newer one joins a group,
  and `cancel-in-progress: false` protects only the run already executing — so
  with several CLI releases queued the middle tag would have been cancelled and
  would never have published its own `cli-v*` assets, which are the release.
  The cure was worse than the race.
- Raw sources changed in the same commit: `scripts/roll-cli-latest.sh`
  (rewritten around the failure-direction rules above); `scripts/
verify-install-urls.sh` (also asserts that `cli-release.yml` carries no
  workflow-level `concurrency:` and still serialises the pointer job, so the
  group cannot migrate back up); `.github/workflows/cli-release.yml` (split
  into an uncancellable `release` job and a serialised `roll-pointer` job that
  downloads the tarball back off the release it just published, so the bytes
  the pointer serves are provably the bytes that release published).

## [2026-09-05] ingest | `cli-latest` converges on the highest published release (#320, #321)

Third review pass on PR #325, two P1s, one answer.

- [CLI → Why `cli-latest` and not `releases/latest`](entities/cli.md#why-cli-latest-and-not-releaseslatest):
  the pointer's rule is now stated as a contract — **`cli-latest` always serves
  the highest published `cli-vX.Y.Z` release, and never a lower one, whatever
  order the pointer jobs run in or fail in** — with its two carve-outs
  (prerelease-tagged CLI releases are ineligible; a deleted highest release
  makes the pointer follow the new highest down, warned) written down rather
  than left implicit.
- The design that contract replaced moved the pointer to the version that
  triggered the run and used a marker in the pointer's body to refuse
  roll-backs. Two ways that failed, both real: GitHub keeps one pending job per
  concurrency group and replaces it with the most recently **queued** one, and
  queue order is release-completion order, so a slow rerun of 1.2 evicts 1.3's
  pending job, 1.2 advances the pointer from 1.1, and the published 1.3 is
  never served; and because uploading the asset and writing the marker are two
  API calls, an upload that lands with a failed write leaves the URL serving
  new bytes under an old marker, which a later older run then passes its
  comparison against and rolls the bytes backwards. Reversing the two calls
  only swaps which direction is wrong — it was the mirror of the ordering bug
  fixed in the previous pass.
- Every pointer run now asks which `cli-v*` release is highest and rolls to
  that. Queue order stops mattering, a cancelled job costs nothing because the
  next one reaches the same state, and the marker is demoted to a record of
  what is served. One hole the rewrite had to close on its own: the release
  listing is eventually consistent, so the triggering version is used as a
  floor and the listing is retried until it shows the triggering tag —
  otherwise a lagging listing could strand the newest release with no later job
  to correct it.
- Raw sources changed in the same commit: `scripts/roll-cli-latest.sh`
  (rewritten around the contract; also fails closed on an unreadable listing,
  excludes drafts, and refuses a target release whose asset is missing or
  empty); `.github/workflows/cli-release.yml` (the pointer job no longer
  pre-fetches a tarball — the script downloads the target release's own asset).

## [2026-09-05] ingest | Partial failures in the pointer swap, and a listing that omits someone newer (#320, #321)

Fourth review pass on PR #325. All three findings were about a step failing
partway rather than about the logic, which is the fourth round running.

- [CLI → "If this dies here, what does the install URL serve?"](entities/cli.md#if-this-dies-here-what-does-the-install-url-serve):
  new section, and the question was asked of every mutating call rather than
  only the ones review flagged. `gh release upload --clobber` deletes the
  same-named asset **before** uploading — its own help says "If the upload
  fails, the original assets will be lost" — so a transient failure left the
  install URL `README.md` advertises 404ing indefinitely. Every other guard in
  the script fails toward "the old thing keeps working"; that one could not,
  because its first act was destructive. The replacement bytes now go up under
  a temporary asset name first, so the destructive step never runs until the
  new asset is already on the server, and the swap is then a delete plus a
  rename — two fast metadata calls, both retried, with a recovery that
  re-uploads under the live name if the rename cannot be completed. GitHub has
  no atomic asset replacement, so a window remains; it is bounded by two
  metadata calls instead of a 2 MB upload, and an exhausted recovery exits
  saying the URL is 404 and how to restore it rather than exiting silently.
- [CLI → The marker is load-bearing, narrowly](entities/cli.md#the-marker-is-load-bearing-narrowly):
  new section. Waiting for the release listing to show the triggering tag
  closed "the listing has not caught up with me" but not "…with someone
  newer" — an older rerun could see a listing that looked complete, omit a
  higher release, and overwrite the pointer downwards, recreating the very
  rollback the convergence design exists to prevent. The marker, demoted to a
  record in the previous pass, is the only evidence of that release, so it is
  now consulted in exactly one way: as a lower bound that can trigger a point
  lookup of the single release it names. Published means the listing was stale
  and the run converges _up_; a confirmed 404 or a draft means the release is
  genuinely not published and the run may converge down, warned; any other
  error fails closed. A hand-edited marker still cannot move the pointer
  anywhere — it can only ask a question whose answer decides. The contract
  paragraph now states this dependency instead of quietly relying on it.
- [CLI](entities/cli.md#why-cli-latest-and-not-releaseslatest): the `cli-latest`
  git tag is moved to the commit behind the _target_ release rather than to the
  checkout's `HEAD`. An older run that converges upward is checked out at its
  own older tag, so the previous code left the tag disagreeing with the asset
  and the release body — contradicting the comment that said the tag must not
  mislead. It is moved through the refs API so the checkout's fetch depth does
  not matter, and a failure there is a warning rather than an error, because
  the tag is cosmetic and the URL is already correct by that point.
- Raw sources changed in the same commit: `scripts/roll-cli-latest.sh` only.

## [2026-09-05] ingest | What the next run concludes, not just what the URL serves (#320, #321)

Fifth review pass on PR #325. Both findings were on transient-failure paths in
the code written in the fourth pass to handle transient failures, and the
second one is the lesson worth keeping: a decision that was correct when it was
made became incorrect when a later change in the same round moved the ground
under it.

- [CLI → "If this dies here, what does the install URL serve?"](entities/cli.md#if-this-dies-here-what-does-the-install-url-serve):
  the table gains a third column — what the **next** run may conclude from the
  state left behind. Both of this round's findings lived there, and neither is
  visible from the "what does the URL serve" column alone.
- The version marker is now written **before** the asset swap, and failing to
  write it is fatal rather than a warning. Round 4 made a failed marker write a
  warning on the explicit grounds that a marker naming an older version was
  provably inert; that was true when written and stopped being true later in
  the same round, when the stale-listing fix made the marker a lower bound. A
  marker that under-claims lets a later run on a stale listing find nothing
  higher to verify and replace newer bytes with an older tarball. Under the
  point-lookup semantics the two directions are not symmetric: a marker that
  over-claims is self-healing, because the next run verifies the claim, finds
  the release published and converges up, finishing the interrupted swap.
  Writing the marker first also makes its failure free — nothing else has been
  touched at that point, so the run exits with the URL still serving the
  previous release.
- Asset lookups on the recovery path preserve their status and are retried.
  They previously suppressed errors and returned empty, so a transient failure
  after a failed deletion read as "the asset is gone" and let the destructive
  `--clobber` fallback run against a live, working asset — the fail-open class
  closed elsewhere in this script, reintroduced inside the recovery path built
  to prevent that very outcome.
- Harness note: the stubbed `gh` did not model `--clobber`'s delete-then-upload
  semantics, which is the exact behaviour the round-4 fix exists for, so the
  first run of one mutation understated the damage. With the stub corrected,
  both the round-4 and round-5 mutations leave the install URL 404ing while
  their controls keep serving. A harness that quietly does the guard's work for
  it makes a mutation look like a pass — the second time that has happened in
  this PR.
- Raw sources changed in the same commit: `scripts/roll-cli-latest.sh` only.
