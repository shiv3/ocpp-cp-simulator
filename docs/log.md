---
title: Log
type: log
summary: Append-only, chronological record of wiki operations (ingest / query / lint / restructure). Newest entries at the bottom.
updated: 2026-09-03
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
