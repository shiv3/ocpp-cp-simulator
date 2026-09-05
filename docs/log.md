---
title: Log
type: log
summary: Append-only, chronological record of wiki operations (ingest / query / lint / restructure). Newest entries at the bottom.
updated: 2026-09-06
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

## [2026-09-04] ingest | Fleet scale benchmark (#302)

- [scripts/bench/README.md](sources/bench-readme.md): new source page. `scripts/bench/fleet-bench.ts` grows a fleet against a real CSMS via `cp.create_many`, drives heartbeats and, optionally, a start/stop transaction cycle (the idle vs. active axes the issue asked for), and diffs two `/metrics` scrapes bracketing a measurement window to isolate one step's `ocppcp_ocpp_call_duration_seconds` histogram from the daemon's whole-lifetime cumulative counters, reporting p50/p95 by linear bucket interpolation plus watchdog timeouts / CALLERRORs / reconnects as sharper knee signals than latency alone.
- [scripts/bench/README.md](sources/bench-readme.md): records why the fleet is **grown in place** rather than recreated or `state.reset` between steps — recreating would put boot traffic inside every measurement window, and `state.reset` is daemon-wide destructive. Records why the benchmark opens a **pool of control-plane sockets** (one per ~200 planned CPs, capped at 10) rather than one: the daemon's own per-socket `RPC_RATE_PER_SEC`/`INFLIGHT_CAP` (`src/protocol/limits.ts`) would otherwise throttle the benchmark's own arming traffic long before the daemon's OCPP-handling capacity became the bottleneck being measured.
- [Daemon → Measured scale ceiling](entities/daemon.md#measured-scale-ceiling): new section, replacing silence on "how many charge points can one daemon hold" with the benchmark and what to record once it is run (machine, CSMS, N vs. p50/p95 for both axes, the knee). No number is recorded — this repository's CI and review sandboxes have no real CSMS to run it against, so producing one is a manual follow-up.
- [Fleet, load and observability roadmap → 5a](analyses/fleet-load-and-observability-roadmap.md#5a-measured-scale-ceiling): marked shipped. The benchmark tool is built per the agreed shape; the number that gates [5b, a worker model](analyses/fleet-load-and-observability-roadmap.md#5b-worker-model-conditional) is still pending an actual run.
- [GitHub issues](sources/github-issues.md): #302 row.

## [2026-09-04] ingest | Review fixes on the fleet scale benchmark (#302)

- [Daemon → Metrics](entities/daemon.md#metrics): new `ocppcp_ocpp_call_timeouts_total{action}` counter in the canonical table, and the paragraph explaining why it cannot be read off the duration histogram — a duration is only observed when the CALLRESULT/CALLERROR arrives, so a CSMS that never answers produces no observation at all and a saturated CSMS reported zero slow calls and zero errors. Fed by the OCPP-1.6J per-CALL watchdog log line plus the `MAX_PENDING_CALLS` eviction path; `OCPPMessageHandlerV201` has no watchdog, so 2.x calls reach it only through eviction. A call answered _after_ the watchdog fired is counted here **and** in the histogram's `+Inf` bucket — two different facts, neither double-counted as the other.
- [scripts/bench/README.md](sources/bench-readme.md): settling is now read off the `ocppcp_charge_points` gauge instead of polling `cp.list`, whose _result_ schema is `ARRAY_1000` — past 1000 charge points the response failed validation and the RPC answered `internal`, so the advertised 2000-CP sweep could never run. New `--allow-existing` flag and the preflight that refuses a daemon which already holds charge points (`/metrics` has no `cpId` label, so their traffic would sit inside the same histogram while `N` counted only the bench's own fleet). `--csms-url` now rejects `http(s)://` rather than silently running a 1.6J WebSocket fleet against it — SOAP has no duration histogram to benchmark. `--out` redacts the daemon Basic Auth password and any URL userinfo. The `>30s` column is split into `timeouts` (the new counter, the real knee signal) and `late>30s` (the histogram overflow: calls that _were_ answered, late).
- [Fleet, load and observability roadmap → phase 2](analyses/fleet-load-and-observability-roadmap.md#phase-2--metrics-endpoint): the planned metric table is replaced by a pointer to the canonical one in [Daemon → Metrics](entities/daemon.md#metrics), which it had drifted from (`outcome` on the message counter was never needed; `ocppcp_ocpp_call_errors_total` and now `ocppcp_ocpp_call_timeouts_total` were added). Duplicate table removed rather than a second one added.

## [2026-09-04] ingest | Second review round on the fleet scale benchmark (#302)

- [scripts/bench/README.md](sources/bench-readme.md): the **measurement window now opens after a warmup**, not immediately after the load is armed. `ocppcp_ocpp_call_timeouts_total` increments 30s after the CALL, when the watchdog fires, so a step's scrape-to-scrape delta used to carry expirations for calls issued during the previous step or during this step's boot and stagger ramp — moving the first non-zero timeout, the headline knee signal, to a larger `N` than the one that produced it. Each step now holds the new `N` and its load for `--warmup` seconds (default `30 + --tx-interval`: one watchdog interval plus the ramp) before the `before` scrape, and the README states exactly which calls a row's `timeouts` covers. The old "keep `--duration` at 60s or more" caveat is superseded and removed.
- [scripts/bench/README.md](sources/bench-readme.md): new `--ocpp-version` flag (`OCPP-1.6J` default, `OCPP-2.0.1`, `OCPP-2.1`; the three SOAP versions rejected as `--csms-url` rejects `http(s)://`), passed through to `cp.create_many` — which defaults to 1.6J on its own, so against a 2.x-only CSMS every handshake was rejected and the run reported an unsettled fleet with no data. Recorded with it: on 2.x the `timeouts` column counts only pending-call-map evictions, because only the OCPP-1.6J handler has the per-CALL watchdog ([Daemon → Metrics](entities/daemon.md#metrics)).
- [scripts/bench/README.md](sources/bench-readme.md): the transaction stagger is **evenly spaced rather than `Math.random()`** — charge point `i` of a step's `count` starts `i/count` of an interval in. Two runs with the same flags now issue the same traffic pattern, so a knee is reproducible from the options recorded in `--out`, per the roadmap's "every random behavior added here is seeded, so a CI failure can be replayed".
- [scripts/bench/README.md](sources/bench-readme.md): **cleanup is bounded** — 32 concurrent `cp.delete`s inside a 60s budget, skipped outright when no control-plane socket is connected (socket.io buffers an emit issued while disconnected rather than failing it). Deleting sequentially at the full 35s RPC timeout each turned teardown of a 2000-CP fleet against a dead daemon into hours of blocked failure handling and an unresponsive Ctrl-C; anything left behind is now named on stderr, since the next run's preflight refuses a daemon that still holds it.
- [Daemon → Measured scale ceiling](entities/daemon.md#measured-scale-ceiling): the method summary names the warmup and `--ocpp-version`, so this page does not describe a method the script no longer runs.
- Not a wiki fact, recorded for provenance: the transaction cycle's timers are now tracked as live handles only (a fired handle removes itself) and re-check `stopped` after every await, the way `AutoTrafficRunner` does since #300 — a 2000-CP run used to retain a timer object per transaction per charge point for the lifetime of the process, and a cycle whose RPC was in flight when cleanup ran could install a fresh timer after the list had been cleared.

## [2026-09-04] ingest | Third review round on the fleet scale benchmark (#302)

- [Daemon → Metrics](entities/daemon.md#metrics): **contract change.** `ocppcp_ocpp_call_timeouts_total` is now incremented by the OCPP-1.6J per-CALL watchdog and by **nothing else**; the `MAX_PENDING_CALLS` (4096) correlation-cache eviction path no longer touches it and is counted separately as the new unlabelled `ocppcp_ocpp_pending_calls_evicted_total`. An eviction is a capacity event in the recorder, not a protocol event on the wire — the transport still holds the CALL and the CSMS may answer it a millisecond later — so counting it as a timeout made the counter report load rather than failure, and did so worst at exactly the fleet sizes a scale run exists to characterise, since 4096 concurrent pending CALLs is a big-fleet condition. It also double-counted any CALL whose watchdog fired after its eviction. This supersedes the entry of [2026-09-04 | Review fixes on the fleet scale benchmark](#2026-09-04-ingest--review-fixes-on-the-fleet-scale-benchmark-302), which recorded the old two-source semantics. Consequence recorded on the same page: on OCPP 2.x, where `OCPPMessageHandlerV201` has no watchdog, an abandoned CALL is now counted nowhere, so a zero there means "not measured" and the bench prints `n/a`.
- [scripts/bench/README.md](sources/bench-readme.md): the socket pool's **sustainable load ceiling** is now stated and enforced. The control plane rate-limits per connection, the active axis issues two RPCs per charge point per cycle, and `cycle` awaits each RPC before scheduling the next phase — so a required rate above the pool's budget did not queue, it stretched the cycle, and the run applied less OCPP load than configured while reporting that smaller load's latency as the configured one's. Ten sockets × 80 RPC/s × 0.8 headroom = 640 RPC/s, i.e. **N ≤ 320 × `--tx-interval`**; the pool is now sized by rate as well as by fleet, and `validateOptions` refuses a sweep past the ceiling with the required rate, the ceiling and the two ways out.
- [scripts/bench/README.md](sources/bench-readme.md): the transaction **hold now starts when the transaction does**. `start_transaction`'s control-plane ack returns while `ChargePoint.startTransaction` is still awaiting `Authorize.conf` (`AuthorizeBeforeLocalStart` defaults to true), so the hold was shortened by the authorization latency and, past one hold of it, the stop was a no-op that left the transaction running into later cycles — the generated load varying with the CSMS latency being measured. The active axis now opens one dedicated event socket (`events.subscribe`, scope `"*"`, outside the RPC pool, opened before the first charge point exists because the subscribe ack carries a whole-fleet snapshot through an `ARRAY_1000` schema) and waits for `transaction_started` — its first emission, the one carrying the placeholder id `0`, because 1.6 re-emits the event with the real id once `StartTransaction.conf` lands and a late conf would otherwise confirm the next cycle's start. Unconfirmed starts are reported in a new `unconf.tx` column. The subscription is itself a small load on the daemon, recorded in the README's known limitations; it is still cheaper than polling each charge point's `status`, which would add a third RPC per cycle to the rationed budget.
- [scripts/bench/README.md](sources/bench-readme.md): a row is now **labelled with the fleet it describes**, not the size it asked for. `cp.create_many` succeeds partially, so 10 requested / 8 created used to print `N=10, connected=8, unsettled=0`; the table now prints `N=8` with the shortfall in a new `uncreated` column. Cleanup now sweeps every id the run _offered_ to `cp.create_many`, recorded before the call is awaited — an RPC deadline or a dropped connection rejects the call without cancelling the server-side creation, and ids that never reached the client were left registered for the next run's preflight to refuse.
- [Fleet, load and observability roadmap](analyses/fleet-load-and-observability-roadmap.md#phase-2--metrics-endpoint): notes the new eviction counter and, under [5a](analyses/fleet-load-and-observability-roadmap.md#5a-measured-scale-ceiling), the benchmark's active-axis ceiling.

## [2026-09-04] ingest | Fourth review round on the fleet scale benchmark (#302)

- [scripts/bench/README.md](sources/bench-readme.md): **a lost event socket now aborts the run** rather than degrading it. With `reconnection` off a drop is terminal, and the previous handler failed only the waiters that were already armed — so every later `arm` burned a full hold waiting for a confirmation that could never arrive and the cycle then waited the real hold on top, roughly doubling each transaction's occupancy and collapsing the rest period. Later rows would have carried about twice the configured load while still being labelled with it, the same class of quiet mismeasurement as running past the pool's rate ceiling. The sweep now stops, prints `Aborted:` with the reason, writes no table and no `--out` file, and exits at once: every long wait in the step loop is raced against the loss, and since `Promise.race` does not cancel the loser, the failure path calls `process.exit` the way the SIGINT handler already did — otherwise the message printed immediately and the process then sat on an armed measurement timer for up to an hour, which is not a stop. A deliberate teardown closes the socket without triggering it — a run that finished is not a run that was aborted.
- [scripts/bench/README.md](sources/bench-readme.md): the event socket is **opened inside the run's cleanup scope**. It used to be opened between the control-plane pool's connect and the `try`/`finally` that closes it, so a failure to connect or subscribe left the pooled sockets open and retrying (`reconnection: true`) and the process alive indefinitely after the top-level catch printed the error — the same never-exits shape as the timer leak fixed in the second round.
- Not a wiki fact, recorded for provenance: the arm/confirm/lose state machine moved out of `fleet-bench.ts` into `lib.ts` as `TransactionStarts`, leaving only the socket in the bench script. `fleet-bench.ts` calls `main()` on import and so cannot be unit-tested; `lib.ts` can, and both of this round's guards are invariants rather than socket plumbing.

## [2026-09-04] ingest | Fifth review round on the fleet scale benchmark (#302)

Both findings are the same shape: a fix that was correct in isolation stopped being correct once it composed with **grow-in-place**, and the row went on claiming a cadence the traffic no longer had.

- [scripts/bench/README.md](sources/bench-readme.md): the transaction stagger is now phased off each charge point's **global fleet index**, not its index within the step that created it. The load is armed once per step with only that step's new charge points, so the previous per-cohort even spacing restarted the phase at 0 every step — with `--counts 1,2,3` and step durations that are multiples of the period, all three landed in nearly the same phase. That is a burst rather than a stagger and a latency knee belonging to the script rather than to the daemon, which is the worst answer available to a tool whose entire output is a knee. Exact even spacing cannot survive growth without re-phasing the running fleet (clearing in-flight transaction timers and re-issuing `start_transaction` mid-session), so phases come from the van der Corput sequence in base 2, whose defining property is that _every prefix_ is near-uniform: the fleet is well spread at every step and a later cohort never disturbs one already running. Worst-case gap `2/n` of a period at fleet size `n`, against `1/n` for a perfect ring.
- [scripts/bench/README.md](sources/bench-readme.md): a cycle now waits for its `transaction_started` for **15s — the daemon's own 10s authorization timeout plus slack — never for one hold**. At `--tx-interval 2` the hold is 1s while `authorizeAndWait` may legitimately take 10s, so a hold-length wait declared the start dead while it was still pending: the stop fired against a transaction that did not exist, the next cycle began immediately, and the original start landed after that ineffective stop, leaving a transaction active or letting its event confirm a newer cycle's waiter. Because `authorizeAndWait` never rejects — on timeout it warns and resolves `"Accepted"` — a start unconfirmed past that bound was genuinely denied, so the wait ends on a definitive answer rather than a guess, and no second cycle for a charge point begins until the outstanding one is answered, held and stopped. Recorded with it: the drift a denial causes is one-way and permanent — that cycle occupies 15s plus a hold and the next is anchored one period after its start, so a charge point stretches from a 2s cycle to roughly 16s and never catches up. A non-zero `unconf.tx` means those charge points' cadence is their own rather than the flag's, which is the honest trade against beginning a new cycle while the old start is still outstanding.
- [scripts/bench/README.md](sources/bench-readme.md): the `--warmup` default's ramp is one **cycle period**, not one raw `--tx-interval` — they differ at `--tx-interval 1`, where a hold is floored at 1s and the real period is 2s — and it is **zero on the idle axis**, which starts no transactions and so has nothing to ramp. The documented default is unchanged for every interval of 2s or more.

## [2026-09-04] ingest | Sixth review round on the fleet scale benchmark (#302)

- [scripts/bench/README.md](sources/bench-readme.md): the transaction stagger is now anchored to a **run-wide epoch**, not to each cohort's own arming. Last round's global indices fixed _which_ fraction of the period a charge point gets and said nothing about what that fraction is measured from: creation, settling and heartbeat arming all take variable time, so every cohort was rotated by an arbitrary amount and two well-separated indices could still collide in wall-clock phase — the artificial-knee failure reached by another route. Each first cycle is rebased modulo the period against one epoch fixed before the first charge point exists, so an index means the same instant whichever step created it. The lesson is the previous round's one level up: a global _sequence_ is not enough if its _origin_ is not.
- [scripts/bench/README.md](sources/bench-readme.md): a row's **connectivity is read from the final scrape**, with a new `dropped` column for charge points that had settled and were gone by the end. The settle-time count was taken before the warmup, so a charge point lost during the warmup or the window still counted as connected and the row attributed its latency to a fleet larger than the one that produced it — the partial-fleet mislabelling fixed in the third round, at a different point in the step. A warmup disconnect was the worst case: its reconnect attempts land before the `before` scrape, so the `reconnects` column stayed 0 and nothing else in the row hinted at it. `--out` carries both ends (`connectedAtSettle` and `connected`), and a non-zero drop is warned about on stderr.
- [scripts/bench/README.md](sources/bench-readme.md): the **hardware block now says whose hardware it is**. `os.cpus()`, `os.totalmem()` and `Bun.version` describe the process running the script, which is the machine under test only when `--daemon-url` is local; labelling it `machine:` regardless meant a remote run recorded the wrong host entirely. A local run prints `machine (daemon host, and this runner):`, a remote one `benchmark client, NOT the daemon host:` plus `daemon host: UNKNOWN` and an instruction to record the daemon host by hand, and `--out` carries `daemonHostIsRunner`. Since the acceptance criteria require a published ceiling to name the machine it was measured on, a wrong attribution is quotable and false — worse than a missing one, which is why this is reported rather than guessed.

## [2026-09-04] ingest | Seventh review round on the fleet scale benchmark (#302)

- [scripts/bench/README.md](sources/bench-readme.md): **the benchmark no longer deletes charge points it did not create, and the collision that let it is now unrepresentable.** Every run mints a **run id** and creates its charge points as `BENCH-<runid>-000001`, printed on stderr and recorded in `--out`, so a pre-existing charge point cannot be sitting on an id this run offers — the failure stops being a case that has to be reasoned about correctly. The shared `BENCH-` root still identifies a crashed run's leftovers, which is what the preflight's refusal asks an operator to clear, and the randomness in a run id is identity rather than behaviour, so the stagger and every other observable stay deterministic and replayable. Second line of defence, kept: An id enters the teardown list when it is offered to `cp.create_many`, and now **leaves it again when the ack names that id as a failure**. The two rules cover two different cases, and the third round's fix conflated them: recording offered ids before awaiting is right while the outcome is unknown, because an RPC deadline does not tell the daemon to stop and it may hold charge points whose ids never reached the client — but once the ack names an id, we know the daemon did not register it (`createOneCp` throws before creating anything on an id collision, and the blueprint-defaults path rolls the charge point back with `removeChargePoint` before reporting it). Keeping failed ids was destructive: under `--allow-existing`, a charge point somebody else created that already holds an offered id such as `BENCH000001` is reported as failed _because it already exists_, and teardown then deleted it. Verified end to end against a real daemon: on the previous commit a pre-existing `BENCH000001` was gone after the run; with the fix it survives and the sweep covers only the two charge points the run created. The asymmetry is deliberate and recorded — a kept id leaks, which an operator can recover from; a deleted charge point cannot be recovered — so an id leaves the list only on positive evidence that it was never ours.
- [scripts/bench/README.md](sources/bench-readme.md): **every HTTP request now carries a 30s deadline.** `fetch` has none of its own, so a daemon that accepted the connection and then stalled while serving `/metrics` — the condition at the top of a sweep, which is exactly what this tool exists to reach — hung the run forever: `--settle-timeout` never fired, the measurement never finished, and the cleanup in the `finally` never ran. The deadline covers the response body, not only the headers, which a stalling-body test confirms. This was the third never-exits path found in this work (after the timer leak and the uncancelled `Promise.race` loser); a sweep of every remaining `await` found the rest already bounded — RPC calls by their own timeout, socket connects and `events.subscribe` by 10s timers, the delete sweep by its 60s budget, the token bucket and semaphore by the bounded operations they gate.
- [scripts/bench/README.md](sources/bench-readme.md): **credentials are redacted from stderr, not only from `--out`.** Userinfo in `--daemon-url` was printed raw on the preflight progress line, and stderr commonly ends up in a CI log; the same `redactUrlUserinfo` the result file uses now applies to the progress lines, the hardware block's fallback host and the HTTP error messages.

## [2026-09-04] ingest | An end-to-end smoke test for the fleet benchmark (#302)

Seven review rounds on [`scripts/bench/README.md`](sources/bench-readme.md) did not converge, and sorting the findings by the _kind_ of invariant that broke says why. Two classes account for most of them and neither tailed off:

- **"The process never exits"** — a socket pool left connected on a setup failure, a timer set that grew without bound, a sequential 35s cleanup, the uncancelled loser of a `Promise.race`, an unbounded `fetch`. Five findings.
- **Sweep-level composition** — a function that is correct in isolation but breaks across sweep steps, against grow-in-place, or against pre-existing daemon state: the stagger, the transaction watcher, the id/cleanup bookkeeping, connectivity read at settle time rather than at the end. Around ten findings, at least one in every round.

Both classes share a property that explains the recurrence: **the invariant is about the whole run, not about any function.** The unit tests in `lib.bun.test.ts` are good and check functions; nothing checked the run. The stagger is the proof — a _tested_ `lib.ts` function recurred twice because the defect was in how `main()` called it. "Extract the decidable part and unit-test it", the recipe every round used, cannot close either class.

- New `scripts/bench/fleetBench.smoke.bun.test.ts` spawns the real script as a subprocess against a real daemon subprocess and a real mock CSMS that answers BootNotification, Heartbeat, Authorize, StartTransaction and StopTransaction. It asserts that a two-step sweep exits 0 inside a hard wall-clock bound, that both steps appear in the table and in `--out` labelled with the fleet they describe, that the daemon holds nothing afterwards, that a pre-existing charge point survives an `--allow-existing` run, and that a CSMS which black-holes responses still lets the run end. The bound is deliberately generous: the assertion is "it terminates at all", and a tight bound would produce flakes indistinguishable from the hang it exists to catch. It runs under `bun run test:bun`, so CI gates on it, and roughly doubles that suite's wall time.
- `fleet-bench.ts` gained an `import.meta.main` guard, matching `src/cli/main.ts` and `scripts/steve-verify/runner/main.ts`, so importing the module no longer starts a run.

## [2026-09-04] ingest | Eighth review round on the fleet scale benchmark (#302)

All three findings were in the control-plane socket pool, and two of them are the "quietly stops doing what it says" shape the earlier rounds kept producing.

- [scripts/bench/README.md](sources/bench-readme.md): **a timed-out RPC could still execute.** Socket.IO buffers an emit issued on a disconnected socket and flushes it on reconnect, and the pool's own timer rejects the caller's promise without cancelling the buffered packet or its ack — so a stale `start_transaction` or `stop_transaction` could run long after the caller handled it as failed, corrupting the cadence and able to confirm a later cycle's waiter. Nothing is emitted on a socket that is not connected now: the round-robin skips disconnected sockets, and a call fails immediately with a `disconnected` code when none is live rather than being queued for an unknowable future. A late ack for an already-rejected call is dropped rather than settling a promise nobody holds.
- [scripts/bench/README.md](sources/bench-readme.md): **the RPC deadline covers admission, not just acknowledgement.** A call could wait through several token-bucket refills and semaphore permits before its timer was even created, so `RPC_TIMEOUT_MS` bounded only the last stage and both step setup and the documented 60s cleanup budget could overrun by multiples — and a documented bound is the contract. One deadline is now taken at entry and only the remaining time is passed to the ack timer, with an explicit timeout if admission alone consumed it.
- [scripts/bench/README.md](sources/bench-readme.md): **the in-flight semaphore over-admitted.** `release()` published the permit (`available++`) and only then woke a waiter, whose continuation runs a microtask later; an `acquire()` arriving in that gap took the published permit and the woken waiter decremented as well, so both ran, `available` went negative and stayed wrong. That defeated the cap that keeps this script under the daemon's `INFLIGHT_CAP`, precisely under the contention the tool exists to create. The permit is now handed straight to the next waiter and never published, which also makes the queue FIFO, which it silently was not.
- A `cp.create_many` failure line now names the candidate causes when the daemon answers with a bare error code. `createFailureReason` returns `err.message || err.code` and the already-exists collision carries no message, so an operator saw `invalid_params` beside "this run did not create it" and read it as a collision even when it was a bad `--csms-url` or `--ocpp-version`.
- [scripts/bench/README.md](sources/bench-readme.md): the end-to-end smoke test gained an **active-axis case** (`--tx-interval 2`, covering the dedicated event socket, the transaction cycle, the epoch-anchored stagger and `unconf.tx`, none of which the idle-only cases touched) and a **daemon-death case** that kills the control plane mid-run and requires the run to end rather than hang. Its mock CSMS is now documented as deliberately permissive — no subprotocol negotiation, no schema validation, never a CALLERROR, unknown actions acked — because a live comparison showed the same fleet reported `Unavailable` by gocpp and `Available` by the mock, which means the smoke test cannot reproduce the version-mismatch failure this page warns about hardest.

## [2026-09-04] ingest | Ninth review round on the fleet scale benchmark (#302)

- [scripts/bench/README.md](sources/bench-readme.md): **the transaction stop now waits for the CSMS-assigned id.** The round-three guard took only the first `transaction_started` emission, which correctly stopped a straggling `StartTransaction.conf` from confirming a _newer_ cycle — but also discarded the assigned id, so a conf slower than the hold (over 1s at `--tx-interval 2`) left `stop_transaction` carrying the placeholder `0`. `OCPPMessageHandler.sendStopTransaction` snapshots that id immediately, so the result was CALLERRORs and corrupted connector state, arising precisely near the latency knee the tool exists to measure. The two requirements are reconciled by binding each waiter to the cycle that armed it: a non-zero id is accepted only once that waiter has seen its own local start, so an earlier cycle's conf is ignored, and the wait then continues to this cycle's assigned id instead of stopping at the placeholder. Bounded at the authorization wait plus the per-CALL watchdog (45s), past which `StartTransaction` has been abandoned and no id is coming; OCPP 2.x never assigns a numeric id, so nothing is waited for there and the cadence is unchanged.
- [scripts/bench/README.md](sources/bench-readme.md): **SIGINT no longer leaks charge points.** An interrupt landing while `growFleet` awaited one batch of a multi-batch step snapshotted the cleanup id list immediately; the outstanding batch then completed and later batches were offered and created behind the snapshot, so the handler exited having deleted only the earlier ids. Cleanup now sets an abort flag that the sweep and `growFleet` check between steps and between batches, awaits the sweep's unwinding, and only then reads the list. A second Ctrl-C exits immediately and names the charge points that may remain, rather than appearing to hang.
- Recorded for the next reader, since this is the third route to "the sweep leaves charge points behind": two invariants cover all three, not one. **(A) The cleanup set must be written before a charge point can exist and read only after creation has stopped** — the timed-out batch broke the write-before half, SIGINT broke the read-after half. **(B) Cleanup must delete only what this run created** — the `--allow-existing` collision broke that one. (A) is still procedural, so a fourth route to it is conceivable; (B) is now structural, because the per-run id prefix means no other run's charge point can carry an id this run offers.

## [2026-09-05] ingest | Tenth review round on the fleet scale benchmark (#302)

Both P1s are consequences of the round-nine assigned-id fix, and both are the failure this work keeps producing: a locally correct change that silently alters the load being measured.

- [scripts/bench/README.md](sources/bench-readme.md): **the hold now runs from when the transaction began, not from when its id was confirmed.** Waiting for the CSMS-assigned id before starting the `holdMs` timer added the whole `StartTransaction.conf` latency to every transaction's on-time — near the knee, seconds on top of a configured one-second hold — so the generated duty cycle stopped matching the configuration and the active-axis numbers described a load nobody asked for. The local-start time is retained and only the _remaining_ hold is scheduled; a hold that has already elapsed stops at once and is counted in a new **`late hold`** column, because a row whose duty cycle slipped has to say so rather than imply the cadence held.
- [scripts/bench/README.md](sources/bench-readme.md): **a charge point whose transaction id never arrives is retired from the cycle**, counted in a new **`retired`** column. A conf arriving after `ASSIGNED_ID_TIMEOUT_MS` would land during a later cycle, after that cycle's own placeholder emission, and be accepted as that cycle's id — the simulator would then apply the stale id to the current connector transaction and both the next stop and the cadence would use the wrong one. Correlating by generation is not possible: `transaction_started` carries only a charge point id and a transaction id, so a stale conf is indistinguishable by content from a fresh one. Never arming that charge point again is what makes the confusion impossible rather than merely unlikely, and the column discloses the fleet's offered load falling.
- Recorded because three requirements now constrain the same few lines, and satisfying any two of them produced a finding: **R1** a straggling conf from the previous cycle must not confirm this one (round 3); **R2** the stop must not fire while the id is the placeholder (round 9); **R3** a conf arriving after this cycle's timeout must not confirm a later cycle (round 10). R1 holds by accepting a non-zero id only after this waiter has seen its own local start, R2 by continuing the wait past the placeholder, R3 by retiring the charge point so no later waiter exists. Each has its own test, and each test fails when its own rule is mutated away.
- [scripts/bench/README.md](sources/bench-readme.md): **an interrupt is no longer ignored for up to an hour.** Cleanup raised an abort flag and awaited the sweep, but the settle, warmup and measurement waits never observed it, so a SIGINT during a permitted 3600s duration delayed all deletion until that wait ended by itself — the only escape being a second Ctrl-C, which explicitly leaks the fleet. Those waits are now raced against the interrupt as well as against a dropped event socket, reusing the `untilLost` shape.
- Also corrected: the round-nine entry's README changes were never actually written (the edit's anchor did not match and the failure went unnoticed), so `scripts/bench/README.md` was missing the assigned-id and SIGINT paragraphs that [the wiki page](sources/bench-readme.md) already carried. Both are now in place.

## [2026-09-05] ingest | Eleventh review round on the fleet scale benchmark (#302)

Both P1s are new routes into families already closed elsewhere, which is the part worth recording.

- [scripts/bench/README.md](sources/bench-readme.md): **every charge point now presents its own idTag.** They all fell back to `DEFAULT_ID_TAG` (`123456`), so a CSMS enforcing per-idTag concurrency — conforming behaviour — answers `ConcurrentTx` to every concurrent start after the first and the active axis applies a fraction of the load it reports. That is the **fourth** distinct route to "the generated load is not the configured load", after the socket-pool throttle, the stagger rotation and the hold desync; the first three were inside the harness and this one is the CSMS legitimately refusing what was sent. The tag is `BT<run-id fragment><global index>`, deterministic and inside OCPP 1.6's `CiString20` `IdToken` limit. It is passed per `start_transaction` call rather than configured as an idTag pool (#299) at creation, because `cp.create_many` expands only the charge point id and the SOAP callback URL per index and shares every other field across the batch — a pool set at creation would be the same pool for all of them, which is the collision being removed.
- [scripts/bench/README.md](sources/bench-readme.md): **open transactions are closed before anything is deleted.** `stop()` only cancels timers, and on the active axis roughly half the fleet is inside its hold at any moment, so cancelling those callbacks and then deleting the charge points left the CSMS holding transactions that could never be ended. Teardown now waits briefly for cycles already in flight — so a start still travelling to the CSMS is not overtaken by the stop meant to close it — then issues and awaits a stop for every transaction it believes open, and only then deletes.
- Recorded in answer to the standing question: this is a **third invariant**, not a restatement. The two written down last round — record ids before creation and read them only after creation stops; delete only what this run created — both concern the daemon, whose state the run can enumerate with `cp.list` and reconcile against. A CSMS is a third-party system with no such listing, so "leave the CSMS as you found it" can only be satisfied _by construction_ (close what you opened, before the charge point that could close it is gone) and never repaired afterwards. When it is violated nothing here can detect it; the run can only warn.
- [scripts/bench/README.md](sources/bench-readme.md): the credential-redaction guarantee now holds for a URL **too malformed to parse**. `ws://user:secret@` is exactly the shape that makes `new URL` throw, and the resulting validation error interpolated the raw value to stderr — defeating the guarantee the README states. The redaction is a regex over the raw text, so it needs no valid URL; a sweep of every other place a user-supplied URL reaches a message found the rest already covered.

## [2026-09-05] ingest | Twelfth review round on the fleet scale benchmark (#302)

- [scripts/bench/README.md](sources/bench-readme.md): **teardown no longer treats an acknowledgement as a completion**, stated as an invariant because three separate findings were one violation of it: _teardown may not consider an operation finished before the bound that operation itself uses._ (1) A `stop_transaction` ack says the daemon **queued** `StopTransaction`, not that it sent it, so under a backlogged serializer — the condition this tool exists to create — deleting on the ack discarded the queued CALL and the CSMS kept an open transaction after an apparently clean teardown; teardown now watches `ocppcp_ocpp_messages_total` until the frames have actually left. (2) `untilLost` is a `Promise.race`, and a race rejecting on abort neither cancels nor awaits its loser, so the sweep looked finished while `cp.create_many` was still working through a sequential batch — cleanup deleted provisional ids whose charge points were registered afterwards, and those leaked; teardown now awaits the in-flight creation, bounded by the deadline that RPC already carries. (3) Teardown waited five seconds for in-flight starts while a cycle may legitimately wait the authorization timeout and, on 1.6, the assigned-id timeout on top; it now asks each load handle for its own bound instead of inventing a smaller one. All three are on the **preventable** side of the invariant split recorded last round, which is why they kept appearing: nothing can detect the violation afterwards, so only the ordering protects them.
- [scripts/bench/README.md](sources/bench-readme.md): **the two `transaction_started` emissions are told apart by order, not by the value they carry.** OCPP 1.6's `transactionId` is schema-valid for any integer, zero included, so testing `transactionId === 0` for "still the placeholder" — expedient when the round-three straggler rule was written — left a CSMS that assigns 0 unrecognised: the cycle waited its full timeout and retired the charge point despite a valid confirmation. The waiter now carries an explicit phase, and "no id arrived" is reported as `null`, which `0` could not express. Recorded with it: the round-three and round-ten properties no longer rest on inspecting the number. A straggling conf cannot reach a later cycle because a cycle whose id times out **retires** its charge point, so no later waiter is ever armed for it; it is the absence of a waiter, not a test on the value, that protects both.
- [scripts/bench/README.md](sources/bench-readme.md): the redaction guarantee now covers the **caught exception text**, not only the URL printed beside it. A failed `fetch` commonly quotes the original URL verbatim, so redacting the URL and then appending `String(err)` put the plaintext password straight back on the line. It is applied at every error sink, including the top-level one, because a socket.io connect error can carry the daemon URL.
- Not a wiki fact, recorded for provenance: bounding the in-flight-cycle wait by the cycle's own bound introduced a 46-second uncancelled `setTimeout` in the `Promise.race` that implements it — the never-exits shape again, arriving through this round's own fix. It showed up as the smoke suite going from 70s to 254s and is fixed by clearing the timer when the wait wins.

## [2026-09-05] ingest | Thirteenth review round on the fleet scale benchmark (#302)

Both P1s were the invariant recorded last round — _teardown may not consider an operation finished before the bound that operation itself uses_ — not yet applied everywhere it holds.

- [scripts/bench/README.md](sources/bench-readme.md): **the bookkeeping now answers "stopped" the same way the wait does.** The wait was fixed last round to watch `ocppcp_ocpp_messages_total` until the frames left, but the open-transaction set was still emptied when the `stop_transaction` RPC resolved — which is when the local service _queued_ the CALL. Under the backlog this benchmark exists to create, teardown therefore dropped a charge point from the set, omitted it from the wait, and could delete it and its serialized queue before the CSMS saw the stop. A charge point now moves to an "awaiting the wire" set on the ack and is reconciled at teardown against the daemon's sent counter, baselined at preflight; if the counter has not caught up, those charge points are closed again rather than deleted over a queued CALL.
- [scripts/bench/README.md](sources/bench-readme.md): **the teardown bound is now enumerated rather than incremented.** It covered the confirmation wait and the hold but not the RPC stages, and a cycle can sit in the pool for the whole 35s whole-call deadline _after_ its confirmation wait — so cleanup could stop waiting and delete the fleet while an already-emitted start or stop was still in flight, letting it take effect after the compensating stop. A cycle awaits in exactly four places — the `start_transaction` RPC, the confirmation wait, the hold, the `stop_transaction` RPC — and nowhere else, since arming is synchronous and the next cycle is scheduled after the body returns. That enumeration is what makes the bound complete rather than merely larger than last time; it is now a function in `lib.ts` with a test that fails if any stage is dropped, so the third increment is also the last.
- [scripts/bench/README.md](sources/bench-readme.md): the **zero-id limitation is documented rather than worked around**. Against a CSMS that assigns `transactionId: 0` the assigned-id emission never arrives, because `CLIChargePointService` suppresses the `transactionIdChange` it would come from; the cycle waits its full bound and retires the charge point despite a valid confirmation, so the offered load drops for the wrong reason. Recorded with the evidence that the daemon-side change is genuinely one line — the `transactionId` setter is reached only from the CALLRESULT handlers, so the placeholder its comment names never flows through it and removing the guard would add an emission solely in the assigned-zero case — but the change is left to [#328](https://github.com/shiv3/ocpp-cp-simulator/issues/328), because a script PR should not alter an event contract that `--events`, the web console and the registry service all read.

## [2026-09-05] ingest | Fourteenth review round on the fleet scale benchmark (#302)

- [scripts/bench/README.md](sources/bench-readme.md): **the wire check is now per charge point, because an aggregate could never have proved it.** The previous round reconciled acked-but-unsent stops by comparing the fleet-wide `ocppcp_ocpp_messages_total{action="StopTransaction"}` counter against a preflight baseline. That counter carries **no `cpId` label**, deliberately — #298 bounded its cardinality on purpose — so under `--allow-existing`, or whenever any other frame advanced it, the inequality could be satisfied while _this_ run's acked stop was still queued; teardown then omitted that charge point and deleted it over its own queued CALL. The check looked like proof and was not, which is worse than a documented limitation. Teardown now re-stops **every** charge point that may have an open transaction, acked or not, and confirms each one individually by reading its `transactionId` back through the `status` RPC — a field cleared only by the `StopTransaction` CALLRESULT handler, so a cleared value means the CSMS saw the stop and answered. The refuted helper and its tests are removed rather than left for someone to reuse.
- [scripts/bench/README.md](sources/bench-readme.md): **a `cp.create_many` whose client deadline expired keeps creating.** The 35s RPC deadline rejects on the client while the daemon's sequential handler goes on registering charge points, so the delete sweep answered `not_found` for ids that appeared moments later and those survived — the next run's preflight then refuses the daemon. Ids the sweep reports as `not_found` are re-swept once after a further RPC deadline, since "not there yet" and "already gone" are indistinguishable from the client. This is the acknowledgement-is-not-completion invariant in its strongest form: the acknowledgement never arrives at all and the operation continues regardless.
- [scripts/bench/README.md](sources/bench-readme.md): **credential redaction now scans the whole text.** `redactUrlUserinfo` is anchored to the start of its input, which is right for a bare URL and wrong for a message containing one, so a URL embedded in an exception (`TypeError: ... https://user:secret@host`) passed through with the password intact and reached stderr. A new `redactUrlsInText` scans for every URL anywhere in the text and is used at all five message sites; the anchored helper keeps the bare-URL sites and now carries a comment saying which is which, since the fault was the call site rather than the helper. Fourth redaction finding on this work, and the first where the helper itself was fine.

## [2026-09-05] ingest | Fifteenth review round on the fleet scale benchmark (#302)

- [scripts/bench/README.md](sources/bench-readme.md): **delivery of a closing stop is now a documented limitation rather than a check.** Two mechanisms were tried and both were refuted, which is worth recording so a third is not invented. The fleet-wide `StopTransaction` message counter carries **no `cpId` label** — deliberately, since #298 bounded its cardinality — so an unrelated frame could satisfy an aggregate inequality while this charge point's stop was still queued; an aggregate cannot establish a per-charge-point fact. Then `connector.transactionId` going `null` looked per-charge-point and conclusive, but `ChargePoint.stopTransaction` calls `connector.stopTransaction()` synchronously, clearing `transactionValue` _before_ the frame is queued — the predicate is already true while nothing has been sent, so it is cleared locally rather than on the answer. The wire _is_ observable in principle (`OCPPWebSocket.writeUpstreamPhysical` logs `Sent: …` immediately after `this._ws.send(raw)`, per charge point) but the only way to read it back is `logs.get`, and `RegistryChargePointService.listStoredLogs` returns nothing unless the daemon was started with a database — which this benchmark does not require. Teardown therefore does the thing needing no attribution: it re-stops every charge point that may have a transaction, acked or not, and says plainly on stderr how many stops were accepted and unverified. Under a backed-up outbound queue a queued stop can still be discarded with the charge point.
- Removed with it: a `status` check that read every non-`not_found` RPC failure as "cleared". Only `not_found` establishes that outcome; `disconnected`, `internal` or `invalid_params` mean "could not ask", which is not the same thing — the same fail-open shape as #325's `asset_id`, in the code written to make teardown safe. The predicate is gone, so the fail-open is gone with it.
- [scripts/bench/README.md](sources/bench-readme.md): **preflight now refuses a daemon whose `/metrics` predates this benchmark's counters.** A daemon old enough to serve `/metrics` but without the timeout and eviction families passed every other check and then reported zero for both, so on OCPP-1.6J the run said "no abandoned calls" — the headline knee signal — with nothing to indicate the counter simply was not there. The eviction counter is the probe because it is rendered unconditionally, so its absence means "too old" rather than "nothing has happened".

## [2026-09-06] ingest | Sixteenth review round on the fleet scale benchmark (#302)

Both findings are the PR's recurring failure mode again — the instrument perturbing or misreporting the thing it measures — and one of them is the silent version of it.

- [scripts/bench/README.md](sources/bench-readme.md): **`--heartbeat-interval` is now a contract that survives a reconnect.** `cp.start_heartbeat` sets `HeartbeatService._intervalSeconds` and nothing pins it there: every accepted boot runs `ChargePoint.onBootNotificationAccepted`, which calls `startHeartbeat(BootNotification.conf.interval)`, so the CSMS's value replaced the flag's the moment a charge point reconnected. Arming once per cohort was therefore only true until that charge point's first reconnect — and reconnects are exactly what begin to happen as the sweep approaches the knee, so the offered load changed at the precise point the benchmark exists to measure and every later step inherited the drift, with nothing in the table saying so. The run now watches for `status_change` → `Available` on its event socket — the charge-point boot gate opening, the same signal `src/cli/server/waitForBootAccepted.ts` treats as "boot accepted", emitted unconditionally by `ChargePoint`'s status setter so it fires on the first boot and every reboot alike — and reissues `start_heartbeat` on each. `connected` is deliberately **not** the hook: it fires before `BootNotification.conf` and would race the interval it exists to overwrite, while `status_change` is emitted one statement before `startHeartbeat(csms)` in the same synchronous frame, and the reapplication comes from another process, so it can only land afterwards. A boot seen while an earlier reapplication is in flight is re-issued rather than merged, because the daemon may run the in-flight handler before the second boot's frame. The event socket is consequently opened on **both** axes, not only the active one, and losing it aborts an idle run too.
- The evidence is deliberately off the wire rather than out of the fix: the smoke test's mock CSMS answers `BootNotification` with `interval: 300`, drops each charge point's socket once after its first Heartbeat, and counts Heartbeat **frames per connection**. A Heartbeat on connection #2 inside a 15s window cannot come from a 300s cadence. Reading back a value the fix itself set is what refuted both earlier "proof the stop reached the CSMS" mechanisms, so this reads what the CSMS received. What remains unverifiable from the bench: no control-plane method reports a charge point's live heartbeat interval, so "the interval in use is N" is inferred from frames rather than observed. Documented alongside it: a CSMS sending `ChangeConfiguration HeartbeatInterval` mid-run reaches `startHeartbeat` directly and emits no `status_change`, so the override is not put back; a boot answered `Pending`/`Rejected` never reaches `onBootNotificationAccepted` at all; and the reapplication RPCs share the socket pool with the transaction cycle — two per accepted boot, since `onBootNotificationAccepted` emits `statusChange` twice and an RPC follows every event by design, so a reconnect wave across a 2000-CP fleet is on the order of 4000 paced calls — which makes the instrument compete with the load at its busiest moment.
- [scripts/bench/README.md](sources/bench-readme.md): **the `not_found` reconciliation no longer treats its second answer as final.** A `cp.create_many` whose client deadline expired leaves the daemon creating sequentially, so `not_found` means "not yet" as often as "already gone" — and against a slow `--state-db` or a loaded daemon one retry can still run while the handler is working. The unresolved ids were then left in a local variable nothing read: the daemon registered them after the pool closed and the run said nothing, and the next run's preflight refused that daemon for no stated reason. A fail-open in cleanup, which is how this PR earned a P2 the previous round too. Reconciliation now makes up to `RECONCILE_MAX_PASSES` (3) passes, returns early rather than spending a 35s wait on a control plane that has gone away, and if anything is still unresolved it **names every id on stderr and exits 1** — the table and `--out` file still written, because the measurement happened and it is the teardown that could not be proved complete.
- [docs/entities/daemon.md](entities/daemon.md): the heartbeat contract restated where the operator reads about the benchmark, pointing at the source page for what it does and does not cover.
