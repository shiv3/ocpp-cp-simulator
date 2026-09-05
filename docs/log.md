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

## [2026-09-05] ingest | "It may have succeeded and we cannot tell", and a page that stated the invariant backwards (#320, #321)

Sixth review pass on PR #325.

- [CLI → "If this dies here…"](entities/cli.md#if-this-dies-here-what-does-the-install-url-serve):
  a third class of partial failure, distinct from "it failed" and "it failed
  partway". A retry loop cannot distinguish a lost request from a lost
  response, so an exhausted retry does not mean the mutation was not applied.
  The asset rename assumed it had failed and ran the destructive `--clobber`
  fallback, which deletes first — so a PATCH that had actually been applied,
  with only its reply lost, had its own successful result deleted, and one more
  upload failure left the install URL 404. The rule is now stated and applied
  everywhere: after an exhausted retry of a mutation, **query** the state,
  never assume it. The page carries the table of where each exhausted call
  lands. Checked the other retried mutations while there: the marker write and
  the `.incoming` upload are safe under either answer and still fail loudly;
  the live-asset delete already queried; the fallback re-upload, the pointer
  creation and the git-tag move now query too, so a lost response is no longer
  reported as a dead URL or a stale tag.
- [CLI](entities/cli.md#why-cli-latest-and-not-releaseslatest): the page said
  the asset is uploaded before the marker is written. Round 5 deliberately made
  it the other way round, because a marker that lags the bytes is what permits
  a rollback. The ordering **is** the safety invariant, so a page describing it
  backwards would have talked a future maintainer into restoring the bug. Now
  stated as the invariant, with a pointer to the reasoning and an explicit "do
  not reverse it".
- [CLI](entities/cli.md#why-cli-latest-and-not-releaseslatest): the outcome
  table lumped "marker missing", "marker unparseable" and "marker higher than
  the target" into one row that said all three are warned about and
  overwritten. Only the first two are; a marker naming something higher goes
  through the point lookup. Split into separate rows.
- Two more disagreements found by re-reading the whole section against the
  script rather than only the rows under review, both the same class as the one
  above. The paragraph explaining why the original design failed ended
  "reversing the two calls only swaps which direction is wrong", which is no
  longer true and directly contradicted the code; it is now scoped to the
  period when the marker was trusted unverified. And "a stale or hand-edited
  marker cannot authorise anything" contradicted the section two paragraphs
  later that makes the marker load-bearing in one narrow way; it now says the
  marker cannot authorise anything _by itself_ and names the lookup that gates
  it. This is the third round in which this page needed correcting after the
  code moved — the correction pass is now part of the work, not a follow-up.
- Raw sources changed in the same commit: `scripts/roll-cli-latest.sh` only.
## [2026-09-04] ingest | Charging-curve EV model (#301)

- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): new section, and **schema v1.2**. `evSettings` gains `chargingCurve`, `rampShape`, `currentType`, `phases`, `voltageV` and `powerFactor`. All optional and absence keeps the pre-1.2 behaviour — flat acceptance at `maxChargingPowerKw`, 230 V, single phase — so every file written before this produces identical MeterValues. Purely additive, so `1.1` and `1.0` files remain valid.
- [Scenario format](concepts/scenario-format.md#charging-curve-v12): records two rules. Current is derived **by type**: DC is `I = P / V`, AC is `I = P / (V × phases × cos φ)` with `voltageV` read as phase-to-neutral — one shared formula would report a DC current the hardware could not draw. And effective power is **`min(curve, ChargingScheduleResolver limit)`**, so a curve lowers demand and can never let a session exceed a `SetChargingProfile` the CSMS set.
- [Scenario format](concepts/scenario-format.md#charging-curve-v12): a curve is clamped to its first and last point rather than extrapolated — a curve that starts at 20% says nothing about 10%. On 3-phase AC, `Current.Import` and `Power.Active.Import` are also reported per phase; energy registers are not split, because a meter has one.
- [GitHub issues](sources/github-issues.md): #301 row.

## [2026-09-04] ingest | Charging-curve EV model review fixes (#301)

- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): six PR-review findings against the initial #301 landing, fixed together. The curve previously only changed the _reported_ `Power.Active.Import`; `Connector`'s meter scheduler now accumulates the energy register (and derived SoC) against the same effective power via one shared `effectiveChargingPowerW` — a `powerFraction: 0` point now stops delivery, not just the number. Without a curve, accumulation is unchanged (schedule-limit-only, as before v1.2) — `maxChargingPowerKw` still does not gate a curve-less scenario's own increment/bezier trajectory.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): `chargingCurve` is now normalized (sorted by `socPercent`, invalid points dropped) at the one place every write to `Connector.evSettings` passes through, so a curve given out of order — `normalizeChargingCurve` existed but nothing called it — no longer returns the wrong fraction below its first point.
- `src/cp/application/scenario/ScenarioTypes.ts`: `SCENARIO_SCHEMA_VERSION` corrected from `"1.1"` to `"1.2"` — the v1.2 fields shipped in #301 but the exported-file stamp had not been bumped to match.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): `rampShape` **removed** from `EVSettings`, the JSON schema and the changelog entry — it was never wired into any power computation (dead since #301 landed), and wiring it in-PR would need a ramp-duration setting `EVSettings` doesn't have. Shipping an advertised field that does nothing was judged worse than not shipping it.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): `Power.Factor` now reports the configured value (1 on DC always, the configured `powerFactor` on AC, default 1) instead of a hardcoded `"1.0"` — it disagreed with the `Current.Import` an AC `powerFactor` actually produced in the same MeterValue.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): `Power.Offered` / `Current.Offered` now derive from the EVSE/profile limit (`min(maxChargingPowerKw, schedule)`), independent of the curve — they describe what the charger offers, not what the battery accepts, so a 100 kW charger no longer reports offering 10 kW to a nearly-full battery.
- `docs/index.md`: `Scenario file format` row corrected from `(v1.1)` to `(v1.2)`, matching the page's own title (stale since the #301 ingest).

## [2026-09-04] ingest | Charging-curve transport, SoC-fallback and browser-UI fixes (#301)

- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): documents that `phase` (L1/L2/L3) survives onto the wire on 1.6-J, 1.6-S SOAP, 2.0.1 and 2.1, but is dropped on OCPP 1.5 SOAP — its `SampledValue` has no `phase` attribute, so sending the per-phase samples there would be indistinguishable duplicates of the aggregate. `OCPPMessageHandlerV201.sendMeterValue` now carries `phase` through (it previously copied only value/measurand/unit); the 1.5 SOAP mapper now drops phased samples explicitly.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): the curve is now evaluated at the transaction's, then the EV settings', `initialSoc` before the first synced SoC (`connector.soc` is `null` then) instead of 0% — affects both the reported sample (`MeterValueBuilder`) and the register accumulation (`Connector.effectiveMeterCapWatts`), via a new shared `resolveSocForCurve` helper.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): the v1.2 `evSettings` fields (`chargingCurve`, `currentType`, `phases`, `voltageV`, `powerFactor`) are now reachable from the browser — `Settings.tsx`'s "Default EV Settings" panel and `ScenarioEditor.tsx`'s "Scenario EV Settings" panel, matching [the roadmap's 4a fan-out item](analyses/fleet-load-and-observability-roadmap.md#4a-charging-curve-ev-model).

## [2026-09-04] ingest | Charging-curve review fixes: 1.5 Offered samples, Power.Factor precision, powerFactor 0 (#301)

- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): a new "never" guarantee — an OCPP 1.5 MeterValues.req never carries two samples with the same measurand. 1.5 has no Offered measurand, and `Power.Offered` / `Current.Offered` used to be relabelled onto `Power.Active.Import` / `Current.Import`. That was indistinguishable from correct only while offered and accepted power were the same number; #301's curve makes them differ, so a 1.5 connector sampling both would have sent two identically labelled, contradictory samples in one message. `toOcpp15Measurand` now drops them like every other unsupported measurand. The documented tradeoff: a 1.5 connector sampling _only_ the Offered measurands now gets no power sample at all.
- [OCPP versions & transports → SOAP limitations](concepts/ocpp-versions-and-transports.md#soap-limitations-elsewhere-in-the-simulator): the per-version measurand gap restated as a limitation bullet, pointing at the canonical statement in Scenario format; `scenario-format.md` added to `related:` both ways.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): a `Power.Factor` sample is never rounded. `MeterValueBuilder` reported `toFixed(2)` while `currentAmpsFor` divided by the full value, so `powerFactor: 0.004` put `Power.Factor = 0.00` next to a current derived from 0.004 — one MeterValue contradicting itself, and the opposite of what `effectivePowerFactor`'s own doc comment promised. Rounding the derivation to match would divide by zero, so the sample stopped rounding instead.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): `powerFactor` is `(0, 1]`, not `[0, 1]`. cos φ = 0 means no real power flows, so the AC current derivation has no finite answer; `schema/scenario.schema.json` now says `exclusiveMinimum: 0` and both browser panels clamp to `0.01` (their input `step` — the smallest value the control expresses) rather than to 0. Schema validation is advisory by design, so a file carrying a 0 still loads past the warning, and raw RPC validates no `evSettings` field at all; on both of those paths the domain treats it as unity, and because the sample reports exactly what the derivation used, the wire shows that `1`. The old `clamp01(x) || 1` accepted 0 and silently reported 1.
- [Fleet/load roadmap → 4a](analyses/fleet-load-and-observability-roadmap.md#4a-charging-curve-ev-model): the shipped-shape note records the `(0, 1]` range.
- Deliberately left alone: `src/protocol/methods.ts` types `evSettings` as an opaque object and validates none of its fields, so a lone `powerFactor` rule there would be arbitrary rather than consistent — the domain fallback plus the visible `Power.Factor` sample is the RPC path's answer.

## [2026-09-04] ingest | Charging-curve review fixes: amp-limit round trip, sub-watt-hour carry (#301)

- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): a new contract sentence — an amp-based charging profile is not violated by the report, for a connector that declares an electrical model. `ChargingScheduleResolver` converted `ChargingRateUnit=A` with a fixed `A × 230 V × numberPhases` while `currentAmpsFor` converted back with the connector's configured `voltageV`, `phases` and `powerFactor`, so the round trip was lossy in the dangerous direction: a 3-phase 10 A profile on a `powerFactor: 0.5` connector resolved to 6900 W and reported 20 A, twice what the CSMS set. Both halves now go through one pair of inverse functions in `ChargingCurve.ts` (`currentAmpsFor` / the new `powerWattsForCurrent`), with the phase count taken as `min(connector phases, the period's numberPhases)`. Scoped deliberately: a connector declaring none of `currentType` / `phases` / `voltageV` / `powerFactor` (which is every pre-v1.2 scenario, and `defaultEVSettings`) keeps the 230 V reference conversion untouched, and `GetCompositeSchedule` keeps it too — that response restates the CSMS's own profiles, and its W → A half has to stay the inverse of the same reference conversion.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): a second contract sentence — a tapering curve slows the energy register, it never freezes it. The register is integer watt-hours (a fractional `meterStop` draws a `FormationViolation` from a strict CSMS and strands the transaction in Charging), and `Connector.applyMeterValue` rounds, so the rounded value was what the next tick read back as "current". Any per-tick delta under 0.5 Wh was therefore destroyed rather than deferred — and #301's curve-derived cap newly makes that reachable: tapering below 1800 W with a 1-second interval delivers under 0.5 Wh a tick, so the register and the SoC derived from it stopped moving while `Power.Active.Import` kept reporting real power. `MeterValueScheduler` now carries the sub-watt-hour remainder between ticks (both the increment and the bezier-curve strategies, reset on start/stop); what it reports and persists stays integral.
- Deliberately left alone: a connector that declares no electrical model still reports a `Current.Import` up to three times an amp limit (`A × 230 × 3` in, `÷ 230` out). That asymmetry predates #301 — it is the pre-curve behaviour of every scenario that never mentions volts or phases — and moving it would change MeterValues for files this PR promises are byte-identical.

## [2026-09-04] ingest | Charging-curve review fixes: malformed-curve guard, Voltage sample, control labels (#301)

- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): a new contract sentence — a malformed `chargingCurve` is discarded, never thrown on. `normalizeChargingCurve` assumed an array of point objects, so `{ chargingCurve: {} }` threw on `.filter` and `[null]` threw on `p.socPercent`. Those shapes genuinely arrive: `src/protocol/methods.ts` types `evSettings` as an opaque object and validates none of its fields (noted in the previous round and still true), and scenario schema validation is advisory, so the file loads past the warning. The function now takes `unknown`, drops anything it cannot interpolate, and returns an empty curve — which is flat acceptance, the same as no curve.
- One validator, four call sites: a new `withNormalizedChargingCurve` runs on `Connector`'s `evSettings` setter (and therefore `applyEvSettingsOverride` / `applyDefaultEvSettings`), on `setUserDefaultEVSettings` — `getDefaultEVSettings()` is read straight into a fresh connector's field initializer and bypasses that setter, so a curve restored from `localStorage` used to reach `powerFractionAtSoc` on the first meter tick — on the Settings panel's Apply, and on the five points where `ScenarioEditor` hydrates `evSettings` from an imported or persisted scenario, which is where a `[null]` crashed the settings dialog on render.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): a `Voltage` sample names the volts that produced `Current.Import`. `currentAmpsFor` falls back to 230 V for a `voltageV` that is zero, negative or non-finite, while the sample reported the raw configured value — `Voltage = 0` beside a current divided by 230, one MeterValue contradicting itself. The same defect and the same answer as the `Power.Factor` rule two rounds ago: a new exported `effectiveVoltageV` is the single source of truth for both the derivation and the sample.
- `src/components/Settings.tsx`: the four electrical controls this PR added to the Default EV Settings panel (`Current Type`, `Phases`, `Voltage`, `Power Factor`) had labels with no `htmlFor`, so a screen reader announced unnamed controls. Each now carries an `id`/`htmlFor` pair, matching the file's existing `default-ev-preset` pattern.
- Reported, not fixed: the five pre-1.2 fields above them in the same panel have the same missing association, and `ScenarioEditor`'s equivalent four controls do too — that file uses `aria-label` rather than `htmlFor` throughout. Both are a general accessibility pass, not this PR's change.

## [2026-09-04] ingest | Charging-curve review fixes: the second transaction, and the browser's copy of the stored default (#301)

- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): the "a tapering curve never freezes the register" guarantee now states that it holds **across transactions**. `Energy.Active.Import.Register` is cumulative for the life of a connector — `StartTransaction` records `meterStart` as whatever it already reads, and nothing resets it — while the bezier auto-meter curve starts at zero. Read as an absolute value, the curve was behind the register from the first tick of every session after the first: the uncapped branch assigned a value _below_ `meterStart` (a register running backwards, and a `meterStop < meterStart`), and the capped branch saw a negative delta, clamped it away and delivered nothing until the trajectory climbed back past the old register — forever, once the register had passed the curve's maximum. `MeterValueScheduler` now offsets the trajectory by the register captured when the strategy starts, so the curve means "energy delivered in this session", which is what `meterStop − meterStart` already means. A first session from an empty register is unchanged, and the sub-watt-hour carry accounting is untouched.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): the "without a curve, accumulation is unchanged" sentence gained the same qualifier — a scenario's increment/bezier trajectory is still its own contract, but it describes energy delivered in the session, added to the register the session starts from.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): the malformed-curve paragraph now names the stored browser default as **one** guarded load serving two consumers. Last round guarded `setUserDefaultEVSettings`, the connector-domain copy; `loadDefaultEvFromStorage` still returned the raw parsed object as the React `defaultEvSettings`, which the Settings page maps over to render the curve editor — so a `{}` or `[null]` left in `ocpp-cp.default-ev-settings` still made the page throw, for exactly the input the guard exists to tolerate. Normalization moved into a new exported `parseStoredDefaultEv` in `DataProvider.tsx`, which both the module-level seed and the React state read through.
- Checked while there: the only readers of the stored blob are those two, and the only consumers of the `defaultEvSettings` context value are `Settings.tsx` (the curve editor), `ScenarioEditor.tsx` (placeholder text for `modelName` / capacity / power / SoC / `voltageV` / `powerFactor` — it never touches `chargingCurve`) and `DataProvider`'s own propagation memo. No third unguarded reader.

## [2026-09-04] ingest | Charging-curve review fixes: per-phase samples under a phase restriction, fractional maxValue (#301)

- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): a new contract sentence — per-phase samples are emitted only when all three phases are actually in use. The resolver already lowered the watt cap for an amp limit by `min(connector phases, the period's numberPhases)`, but `MeterValueBuilder` still read the connector's wiring alone, so a 3-phase connector under a single-phase 16 A profile reported ~5.3 A on each of L1, L2 and L3 — claiming consumption on two phases the CSMS excluded, the same "one half of the pipeline honours the resolved value and the other does not" shape as the amp-limit round itself. `resolveActivePhases` is now the single place that rule lives; `ResolvedScheduleLimit` carries the period's `numberPhases` out of the resolver, `Connector.activePhaseCount()` applies it, and the sampling loop reads that. Under a restriction only the aggregate is reported: OCPP's `numberPhases` says how many phases, never which, so naming a subset would invent an allocation the profile never expressed.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): the per-phase sentence also corrected. It claimed both measurands sum to the aggregate; that is true of the three power legs, but each current leg carries the same value as the aggregate — `I = P / (V × phases × cos φ)` already computes a per-phase line current, and the existing test asserted exactly that while the page said otherwise. `Voltage`, `Power.Offered` and `Current.Offered` are not emitted per phase and stay that way, with the reason recorded.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): an auto-meter's `maxValue` stop condition is judged on delivered energy, not on the published integer. This falls out of the rounding work earlier in this PR: with a fractional cap below the next half-watt-hour boundary — 10.4 Wh from a direct caller or an imported scenario — the delivered value reaches the cap but publishes as 10, so both stop checks read false and every later tick capped and rounded to the same 10 forever. The register stays integral; only the condition looks at the fraction.

## [2026-09-05] ingest | Charging-curve review fixes: form/model drift, phase composition, empty 1.5 request, duplicate-SoC step (#301)

- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): the Settings page now saves the electrical model it displays. Its four electrical controls always render a value (`AC`, single-phase, 230 V, cos φ 1 when nothing is set) while `currentType` and `phases` stayed `undefined` in the model, so `electricalModelOf` saw no model, the A → W conversion took the pre-1.2 three-phase path, and metering derived single-phase current — a 16 A profile reported as 48 A on a page claiming single-phase. Apply materializes the displayed values. The scenario editor's panel is deliberately the opposite and is documented as such: an empty field there means "inherit", and it displays empty rather than a value the model does not hold.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): the per-phase rule now says the phase restriction is composed across **both** applicable profiles, independently of the watt cap. `ResolvedScheduleLimit.limitNumberPhases` came from whichever profile won on watts, so a Tx profile restricting a connector to one phase was silently dropped whenever a three-phase `ChargePointMaxProfile` named the lower wattage — and L1/L2/L3 went out while the Tx restriction was still in force. A new `resolveEffectivePhaseLimit` takes the tightest `numberPhases` across the Tx profile and the `ChargePointMaxProfile`; the watt cap and the phase restriction are independent constraints and are now combined independently.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): a new guarantee — a MeterValues request with no samples is never sent. Round four made the 1.5 mapper drop `Power.Offered` / `Current.Offered` rather than alias them onto the Import measurands; a 1.5 connector configured to sample only those then produced a request whose value list was empty, and it went out anyway. OCPP 1.5 requires at least one sample, so a conforming CSMS rejects it — an empty request is worse than none. The 1.5 wire profile returns `null` for that case and `sendMeterValue` skips the send with a warning naming the version and the configured measurands. Recorded there too: a "supported fallback" (relabelling an Offered sample onto `Power.Active.Import`) would be worse, since it is exactly the aliasing that was removed and would report the EVSE's offer as consumption with nothing on the wire to reveal it.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): a new sentence — a curve may repeat a SoC to step, and at that SoC the **last** point wins. `powerFractionAtSoc` documented that behaviour but never delivered it: interpolation reached the first point at the repeated SoC and landed on `t = 1` there, returning the value _before_ the step, so a battery pinned exactly on a cliff down to `powerFraction: 0` charged at full power instead of pausing. Duplicates are deliberately not coalesced at normalization — both points carry meaning, one ending the ramp in and one beginning the run after — so an exact match now selects the final point at that SoC. The existing unit test had encoded the defect as its expectation and was corrected.

## [2026-09-05] ingest | Charging-curve review fixes: joint-phase conversion order, opening SoC, legacy Power.Factor string (#301)

- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): every amp-based limit is now converted on the **joint** phase count rather than on its own `numberPhases`. The previous round made `resolveEffectivePhaseLimit` take the tightest restriction across both profiles, which was right, but each limit was still converted to watts before those restrictions were combined — so a 10 A three-phase `TxProfile` became 6900 W beside a 3000 W single-phase `ChargePointMaxProfile`, the 3000 W won, and delivery on the one permitted phase was about 13 A, over a 10 A limit still in force. Ordering, not composition: the cap and the restriction are independent constraints, but the conversion depends on both, so it has to run after both are known. `resolveEffectiveLimitWatts` resolves the joint count first and passes it into every conversion — including the no-electrical-model branch, where it can only ever narrow the cap and where leaving it out would keep the violation alive for the connectors that say least about their electrics.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): a new contract sentence — a transaction opens on its own SoC, never the previous session's. `stopTransaction` deliberately leaves `socPercent` in place, so the curve was evaluated against the last car's SoC for the first scheduler interval of the next session, and for the whole session with meter/SoC sync off. `beginTransaction` now replaces a **meter-derived** SoC with `transaction.initialSoc ?? evSettings.initialSoc` — the value `socFromMeterValue` computes on the first tick anyway, so this is the same reset one tick earlier. An explicitly set SoC (side panel, a MeterValue SoC sample, or `initialSoc` on `StartTransaction`) is kept, because it describes the car plugged in now. This also explains the live verification's observation that SoC reset 82.3 → 20.0 at the second `StartTransaction`: that steady state was right, and the window this closes is the one tick before it.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): `Power.Factor` writes unity as `"1.0"` again. Round five stopped rounding the sample so it could never name a cos φ that did not produce the `Current.Import` beside it; a side effect was that the unconfigured case went from the historical `"1.0"` to `"1"`, breaking this PR's own byte-identical promise, which is about the strings a raw-payload or snapshot consumer compares. Exact configured values are unchanged. Checked once across all of them rather than one measurand at a time: a new test pins the full sample set for a connector with no electrical fields against the pre-#301 builder's output, and `Power.Factor` was the only string that had moved — `Current.Offered` and `Power.Offered` now derive from the offered power rather than the accepted power, but with no curve those are the same number, and no per-phase sample is emitted for such a connector.

## [2026-09-05] ingest | Charging-curve review fixes: the current derivation reads the active phase count, and the derived-SoC marker is persisted (#301)

- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): the amp-limit guarantee tightens from "at most the amperage the CSMS set" to **exactly** it, because both halves of the conversion now divide by the phases actually in use. The watt cap had been converted on the resolved active count since the previous rounds, but `currentAmpsFor` still divided by the connector's wiring, so a 10 A single-phase profile capped a 3-phase connector at 2300 W and reported 3.3 A for a line genuinely carrying 10. The round-one statement that the aggregate is "a third of the per-phase limit — under it, never over" described that contradiction and is replaced.
- Asked and answered rather than fixed one call site at a time: the domain has exactly **one** legitimate consumer of `EVSettings.phases`, the helper that resolves the active count. The other three hits are form controls in `Settings.tsx` and `ScenarioEditor.tsx`, which edit the wiring and rightly read it. Both conversions — `currentAmpsFor` and `powerWattsForCurrent` — now take the phase count as a **required, nullable** parameter, so a new call site cannot divide by the wiring merely by forgetting to say which phases are live; `MeterValueBuilder` passes `Connector.activePhaseCount()` for both `Current.Import` and `Current.Offered`.
- [State persistence](concepts/state-persistence.md): `connector_runtime` gains `soc_is_meter_derived` at **schema v11**. The marker added last round distinguishes "synchronised during this transaction" from "left over from the last one", and it lived only in memory — so after a daemon restart a restored meter-derived SoC came back looking explicit, and the next transaction opened on the previous battery's charge again. Rows written before v11 carry no value and read as "set explicitly", which is what those builds did. The fresh `CREATE TABLE` declares the column nullable to match what `ALTER TABLE ADD COLUMN` produces, so a fresh database and a migrated one do not differ.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): the audit that prompted it is recorded too — of everything #301 added to connector state, only this marker needed persisting. The auto-meter's sub-watt-hour carry is worth at most half a watt-hour and resets when a scheduler starts, and the curve baseline is re-captured from the restored register when the strategy restarts, so storing it would be worse than recomputing it. Both are now named in `ConnectorRuntimeRepository`'s "notable exclusions" comment rather than only in a review reply.

## [2026-09-05] ingest | Charging-curve review fixes: numberPhases 0 divides by zero, Apply unreachable from the default state (#301)

- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): `numberPhases` is honoured for any **positive** integer, not any non-negative one — the page's previous wording promised the latter and was wrong. Zero looks legal (the bundled OCPP schemas ask only for an integer, and the profile handlers do not reject it) but a station cannot deliver on zero phases, and taking it literally divided by zero: the active count became 0 and a positive `W`-based limit reported `Current.Import` / `Current.Offered` as `Infinity`, or `null` once serialised on 2.x. It is also not how OCPP expresses a pause; that is `limit: 0`. One predicate, `isPhaseRestriction`, is now the single rule, used where the restriction is collected, where it is applied, and in the no-model conversion's fallback — so a rejected value cannot narrow anything in one branch while being ignored in another. The resolved active count is never below 1.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): the divisor audit that finding prompted is recorded with it. The electrical model divides by three things — voltage, phases and power factor. `effectiveVoltageV` already rejected non-positive and non-finite volts, `effectivePowerFactor` already rejected anything outside `(0, 1]`, and phases was the one hole; it is now closed. The curve's own interpolation divides by a SoC span, which is guarded and, since the duplicate-SoC fix, unreachable for an exact match. Nothing else in the sampling path divides by a value an input can drive to zero.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): the Settings page's Apply is now reachable from the default state. Materializing the displayed model on save (two rounds ago) only helped someone who first changed an unrelated field: with no stored override — and straight after Reset — the draft equalled the built-in defaults, the dirty check said there was nothing to apply, and the button was disabled, leaving the page showing AC / single-phase while the connector kept the legacy no-model conversion that reads a 16 A limit as 48 A. The draft is seeded with the displayed model as well as saved with it, so Apply is enabled exactly when the screen and the stored settings disagree.
- Found while testing the above, in this PR's own test code rather than in the product: the `ampProfile` helper built its period with `...(numberPhases ? { numberPhases } : {})`, so a `numberPhases` of **0** — the value under test — was silently dropped and the case exercised "absent" instead. Corrected to an `undefined` check; the mutation that reintroduces the zero handling now fails as it should.

## [2026-09-05] ingest | Charging-curve architectural-review follow-ups: a limitation recorded as one, and a side-effecting getter pinned (#301)

- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): the pre-1.2 conversion mismatch is now written as a **known limitation**, not folded into the byte-identity guarantee. A connector declaring none of the four electrical fields still converts an amp limit at three phases and reports the current back at one — a 10 A profile caps at 6900 W and reads 30 A — which is the same contradiction the electrical model removes. Preserving it is deliberate, because every scenario written before v1.2 has no electrical fields and changing it would change their MeterValues; but `CLAUDE.md` makes these sentences contracts, so the page had turned a defect into a promise. The guarantee is the byte-identity of that path; the 30 A is a defect inside it, and correcting it later is a deliberate behaviour change rather than a regression. Declaring any one of `currentType`, `phases`, `voltageV` or `powerFactor` opts a connector into the corrected conversion today. The test pinning the byte-identical output carries the same note, so it breaks on purpose when someone does correct it.
- `src/cp/domain/connector/Connector.ts`: `currentScheduleLimitWatts()` emits `scheduleLimitChange`, and this PR's `Power.Offered` support made `MeterValueBuilder` call it twice per sample build where `main` called it once. Checked rather than assumed: the emission is edge-triggered and idempotent — `lastSchedulePaused` is written before the emit, so a second call at the same boundary state emits nothing, and an uncapped second call finds the latch already reset. A subscriber counting Charging/SuspendedEVSE transitions sees one event per real crossing, not one per sample. No code change was needed; the reasoning is now recorded next to the note explaining why the sibling `activePhaseCount()` is side-effect-free, since that note is what made the double call look wrong. Four tests pin the property — one event per build, one across five builds, one per genuine crossing in and out of paused, none while no profile is active — and removing the latch makes a single build emit twice.

## [2026-09-05] ingest | Charging-curve review fixes: bounded sample formatting, duplicate log frontmatter key (#301)

- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): the "never above the limit" guarantee now covers the _printed_ value, not only the derivation. `Current.Import` is reported to one decimal and `Power.Active.Import` to a whole watt; rounding to nearest rounds up, so a binding 16.06 A limit derived 16.06 A correctly and then sent `"16.1"` — the station reporting more than the CSMS allowed, which falsified the contract sentence tightened one round earlier. A sample a profile bounds is now rounded **down** instead, and only when rounding to nearest would cross the bound. That conditional matters: flooring every sample would move `22000 / 230 = 95.652…` from `"95.7"` to `"95.6"` and break the byte-identity the pre-v1.2 path depends on, so the two guarantees coexist precisely because the bound bites only where a limit binds. Applied to `Current.Import`, `Current.Offered`, `Power.Active.Import` and `Power.Offered`, and to a per-phase leg against its own third of the cap. Checked rather than assumed for the rest: `Voltage`, `Power.Factor`, `SoC` and the energy register are not bounded by a charging profile, and `SoC` is already clamped to 100 upstream.
- `src/cp/domain/connector/MeterValueBuilder.ts`: the schedule limit is now resolved **once** per sample set and passed into both power derivations, where it had been resolved twice. Needed anyway to express the bound in the sample's own units, and it makes every sample in one MeterValue describe the same instant — as well as reducing the calls to the one getter that can emit `scheduleLimitChange` from two to one, so the previous round's idempotence note is now belt rather than braces.
- `docs/log.md`: removed a duplicate `updated:` key left in the frontmatter by a rebase that resolved this file as "append-only, keep both sides" — right for the entries, wrong for the frontmatter. Strict YAML parsers reject duplicate keys and permissive ones take the last, so the page was reporting the older date despite carrying the newer entries. [Conventions](conventions.md) specifies one field.

## [2026-09-05] ingest | Charging-curve review fixes: one instant per sample set, and an explicit SoC that belongs to one session (#301)

- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): a new contract sentence — every sample in one MeterValue describes one instant. The watt cap and the active phase count are both derived from the charging schedule, and each resolved against its own `new Date()`, so a schedule period boundary falling between the two calls took the cap from one period and the divisor from the next: a 10 A three-phase period capped at 6900 W, was divided as one phase, and reported 30 A. `Connector.scheduleConstraints()` resolves both from a single timestamp and is what the sample builder calls; `currentScheduleLimitWatts()` and `activePhaseCount()` remain for their other callers and now share the same private resolve. This is the seam [#327](https://github.com/shiv3/ocpp-cp-simulator/issues/327) describes — two consumers re-deriving from connector primitives — fixed locally by threading one resolve rather than by that refactor.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): the SoC-ownership sentence corrected. Round 8's marker recorded whether a value was meter-derived, and treated every explicit one as a statement about the car plugged in now — but an explicit SoC from a _previous_ transaction is a leftover too. `ChargePoint.startTransaction` writes `initialSoc` through the `soc` setter, so with no meter-derived update afterwards (auto-metering off, or SoC sync disabled) the next transaction kept the previous one's SoC for its whole session, curve and reported power included. The marker is now three-state and records **whose** the value is rather than where it came from: derived from the meter, set while a session was running, or set while the connector was idle. Only the last survives `beginTransaction`, and it is claimed there, so it cannot be claimed twice. What tells the preserved case (type an SoC into the side panel, then press Start) apart from the leak is simply whether a transaction was active at the moment of the write — available at the one place every SoC write passes through.
- The persisted `connector_runtime.soc_is_meter_derived` column is unchanged and `SCHEMA_VERSION` stays 11: the boolean still means "was it meter-derived", and the idle/session distinction is reconstructed on restore from whether the snapshot carries an active transaction — which is how the value would have been treated had the daemon never stopped.

## [2026-09-05] ingest | Charging-curve review fix: SoC ownership persisted rather than reconstructed, schema v12 (#301)

- [State persistence](concepts/state-persistence.md): `connector_runtime` carries `soc_awaits_next_transaction` at **schema v12**, replacing the `soc_is_meter_derived` column v11 added earlier in this same PR. The previous round reconstructed ownership on restore from whether the snapshot carried an active transaction, which is right for every case but the one that matters: a session that has _ended_ leaves an SoC that is session-owned and transaction-less, and no rule reading the rest of the row can tell it from one a user set while the connector was idle — so a restart handed the previous car's charge to the next transaction. The bit is now persisted with the value it describes.
- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): the SoC sentence records that the "still waiting" bit crosses the disk rather than being inferred there.
- The three-state ownership model introduced last round collapsed to one bit in the process, and that is the actual fix rather than a side effect. `"meter"` and `"session"` never differed in what happened to the value — only `"pending"` did — so the model carried a distinction that drove nothing and could not be represented at the boundary. Asking the one question that decides the behaviour ("is this waiting for the transaction that starts next?") makes the in-memory state and the persisted state the same shape, which is why no reconstruction rule is needed any more.
- Version numbering: v11 was introduced by this PR and never released, so its block is replaced rather than appended to; a database stamped 11 by an earlier build of this branch migrates forward through the v12 block and simply carries the unused old column. This is the third instance this run of an in-memory invariant not surviving persistence, the class tracked in [#326](https://github.com/shiv3/ocpp-cp-simulator/issues/326).

## [2026-09-05] ingest | Charging-curve review fix: the k6 export is a second implementation, and had drifted (#301)

- `src/cli/exportK6/runtime/interpreter.ts`: the exported k6 runtime still assigned its auto-meter curve value to the register outright, which is the pre-#301 daemon behaviour — so the **same scenario** rewound its meter under k6 on any session after the first and could send a `meterStop` below its own `meterStart`. It already had the session's starting register to hand; the curve is now added to it, exactly as `MeterValueScheduler`'s curve baseline does.
- `src/cli/exportK6/runtime/wire/v16.ts`: the register is rounded to a whole watt-hour at the wire — `meterStart`, `meterStop` and the `Energy.Active.Import.Register` sample — while the interpreter keeps the unrounded value. That closes the other half of the same contract: a fractional `meterStop` draws a FormationViolation from a strict CSMS, and keeping the fraction internally reproduces the daemon's sub-watt-hour carry, so a step smaller than the register can express accumulates instead of being discarded.
- [CLI → export-k6](entities/cli.md#export-k6): a new "What the exported runtime models" table. The export is a second implementation of the scenario semantics, not the daemon retargeted, and it models a deliberately reduced subset — a line drawn when the charging curve landed, where [the roadmap chose to keep the k6 export on a flat rate](analyses/fleet-load-and-observability-roadmap.md#4a-charging-curve-ev-model) rather than porting the model. What it implements and agrees on: the session-relative time curve, the integral register, and the stop conditions. What it does not implement at all: the battery charging curve, the electrical model (it sends one measurand, so no current, voltage, power or per-phase samples), `SetChargingProfile` limits, tracked SoC, and persistence. Stating the boundary once means the next difference is looked up rather than discovered.
- Audited each #301 change against the runtime rather than only fixing the reported one. The two above were the only divergences; every other item was in a row the runtime does not implement. Noted and not fixed: `interpolateCurveKwh` returns the _earlier_ point when a curve repeats a `time`, the same shape as the duplicate-SoC defect fixed in the domain — but that interpolation is k6's own linear one against the daemon's bezier, a pre-existing difference rather than a #301 semantic.

## [2026-09-05] ingest | Charging-curve review fix: a curve is offset by its own start, not by the register (#301)

- [Scenario format → Charging curve](concepts/scenario-format.md#charging-curve-v12): "session-relative" now says what it has to mean — the curve is shifted so its **own first point** lands on the register the session starts from, not simply added to that register. Adding the register alone assumed every curve begins at zero, which every curve written so far happens to do; a curve is free not to, and a connector at 50 kWh running a 50→60 kWh curve jumped to 100 kWh and delivered twice what the curve describes. What a curve fixes is the shape of a session's delivery, and where its ordinates start says nothing about where the register is.
- `src/cp/domain/connector/MeterValueScheduler.ts` and `src/cli/exportK6/runtime/interpreter.ts`: the same one-term correction in both. The k6 runtime had inherited the incomplete form when the session-relative fix was propagated to it, so the error briefly existed in two places; the exported runtime and the daemon agree again.
- [CLI → export-k6](entities/cli.md#export-k6): the subset table's curve row restated for the corrected semantics.
- Offsetting was chosen over requiring zero-based curves: existing scenario files keep working whatever their ordinates, and a requirement would need validation plus a migration story while changing the meaning of files that load today — and scenario schema validation is [advisory](concepts/scenario-format.md#status--scope) anyway, so it would warn rather than enforce and leave the same ambiguity in the domain.
- Checked while there: the stop conditions still mean what they say. The daemon's curve path has never consulted `maxValue` — that is the increment path, and its round-11 tests were re-run against their own mutation and still discriminate. The k6 curve path stops on elapsed time, which the ordinate shift cannot affect, and its target-SoC stop mode compares `meterWh − startWh`, which the shift turns into genuinely delivered energy rather than the curve's absolute ordinate.
