---
title: Built-in scenario templates
type: entity
summary: The scenario JSON files shipped inside the package — six general-purpose flows, six `dataflow-*` showcases of the schema 1.7 data-flow features and the 1.10 loop edge, six `resilience-*` failure / recovery scenarios, 32 OCPP 2.0.1 / 2.1 variants of the core flows, the CP-side certification-style cases and the resilience scenarios, the 47 `cert16-*` OCPP 1.6 certification test-case templates and the OCTT strictness probe — and how template instances behave.
sources:
  - packages/core/src/utils/scenarioTemplates.ts
  - packages/core/src/utils/scenarios/*.json
  - packages/core/src/utils/scenarios/README.md
  - packages/core/src/test/goldenWire/templateExpectations.bun.test.ts
  - packages/core/src/utils/tckContract.templateIds.test.ts
  - "issue #346"
related:
  - ../concepts/scenario-format.md
  - ../concepts/power-loss.md
  - ../concepts/network-simulation.md
  - ../concepts/web-console-i18n.md
  - ../sources/cert16-templates-readme.md
  - ../sources/steve-verify-readme.md
  - cli.md
updated: 2026-11-21
---

# Built-in scenario templates

> **The `cert16-*` ids are an external contract.** open-ocpp-tck addresses the
> templates by id, so the set of ids only grows: a rename or removal keeps the
> old id working as an alias for at least one minor release, and
> `tckContract.templateIds.test.ts` fails otherwise. See
> [CLI → TCK contract](cli.md#tck-contract) (#346).

Every built-in template is a flat `ScenarioDefinition` JSON file under
[`packages/core/src/utils/scenarios/`](../../packages/core/src/utils/scenarios/) — the same
[scenario format](../concepts/scenario-format.md) the editor exports and the
example files under `docs/examples/scenarios/` use — wrapped by
[`scenarioTemplates.ts`](../../packages/core/src/utils/scenarioTemplates.ts) into the
editor-facing `ScenarioTemplate` interface. Because they are plain files, the
daemon's `--scenario-template-file` can load any of them straight off disk
without going through the loader.

The web console displays each template's `name` and `description` through its
locale tables (`templates.<id>.name` / `.description`, see
[web console internationalization](../concepts/web-console-i18n.md)). The
English table must repeat the file's text word for word and every locale must
keep its OCPP message names, so a change to either field goes with a change to
`apps/web/src/i18n/locales/*/templates.json` in the same commit (#807). A
template may have no entry: no test requires one, and the console then shows
the file's own text in every language. The `resilience-*` templates got their
entries in #817.

## Where templates are used

| Surface                                                          | How                                                                                                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [Web console](web-console.md) Scenario Editor                    | Pick a template from the dropdown; `cert16-*` templates auto-start once the connector reaches `Available` (`triggerOn: "connect"`). |
| [CLI](cli.md#startup-scenarios) startup                          | `--scenario-template <id> --scenario-connector <list>`                                                                              |
| [Control plane](../concepts/control-plane.md#cp-command-methods) | `list_scenario_templates`, `load_scenario_template`, `run_scenario_template`                                                        |
| [MCP endpoint](mcp-endpoint.md)                                  | `scenario_templates`, `run_scenario_template`                                                                                       |

## What a template declares

Every template carries three things next to its graph, so a headless run (CLI `--json`, MCP, a CSMS test harness)
needs no knowledge of the graph and ends in a verdict (schema 1.12):

- **`ocppVersions`** — the OCPP versions its wire shapes are written for (`["1.6"]` for the `cert16-*` set,
  `["2.0.1", "2.1"]` for the `-201` ones, all three for the version-agnostic ones). Loading a template on a charge point
  that speaks another version still works but logs a warning.
- **`csmsExpectations`** — what the CSMS must do for the intended path: the CSMS-initiated `calls` in the order the
  scenario waits for them (action, example payload, the status the charge point answers with), the `answers` it must give
  to a call the charge point makes (an Authorize outcome, a DataTransfer status), and, for the status-triggered
  templates, the `simulatorSteps` that drive them. See
  [Scenario format → CSMS expectations](../concepts/scenario-format.md#csms-expectations-schema-112).
- **`assertions`** — the checks the run is judged by, so a run on the intended path reports `PASS` and a run that went
  elsewhere reports `FAIL` instead of `SKIPPED`. A template with a deliberate alternative path
  (`remote-start-timeout-fallback`, `dataflow-authorize-branch-*`) asserts the primary one; the others are reached by
  answering differently and then fail the primary assertions on purpose.

`list_scenario_templates` (and the daemon-level `scenario.templates`, the MCP `scenario_templates` tool) returns all of it
per template: `id`, `name`, `description`, `targetType`, `ocppVersions`, `csmsExpectations` and `assertions` (id, type,
description). The test `templateExpectations.bun.test.ts` runs every template against the fake CSMS driven by its
declaration alone and requires every assertion to pass, so the metadata cannot drift from the graph.

Assertions look at what the charge point and the CSMS exchange, not at meter registers: whether `MeterValues` frames go
out depends on the station's configuration, so no template asserts on them.

## Open-ended templates and their end

Five general-purpose templates have no end of their own that an unattended run can count on, so each carries a
`maxDurationSeconds` (schema 1.13) and says in its `csmsExpectations.note` what ends it. The bound is station-clock time
(it shrinks with [`--time-scale`](cli.md#time-scale)); when it passes the run ends **normally** (state `completed`,
`endedBy: "maxDuration"`, assertions evaluated), not as a stop.

| Template id                | Ends when                                                                                                       | Bound |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- | ----- |
| `status-triggered-actions` | never by itself: the Available trigger re-fires on every Available, so the Heartbeat loop repeats               | 60 s  |
| `multi-status-monitor`     | never by itself: three status triggers wait for the connector, the Charging branch meters up to 20 kWh          | 120 s |
| `smart-charging`           | the connector reaches Finishing (the Charging branch meters up to 30 kWh until then)                            | 120 s |
| `full-charging-cycle`      | its Auto MeterValue node has metered 25 kWh or 300 s (500 Wh per 5 s), then the transaction stops               | 330 s |
| `remote-start-auto-meter`  | the transaction is stopped (RemoteStopTransaction or locally): the Auto MeterValue node has no limit of its own | 120 s |

`run_scenario_template { "maxDurationSeconds": N }` overrides the bound per run (`0` removes it).

## Instance ids

`run_scenario_template` and `load_scenario_template` answer `{ scenarioId }` with the **instance id**
`<templateId>-c<connector>`, e.g. `cert16-tc010-remote-start-c1`: one stable instance per template and connector, replaced
when the template is loaded again (see [Template instances](#template-instances)). Pass it, or the plain template id
together with the `connector` of the call, to `scenario_status`, `scenario_report`, `get_scenario`, `run_scenario`,
`stop_scenario` and `scenario_reset`; an id that names a scenario of its own always wins. `scenario_status` and the report
also carry `transactionId` / `transactionIds`, so a harness that has to answer with a `transactionId`
(RemoteStopTransaction, a TxProfile) reads it there.

## General-purpose templates

| Template id                | Name                             | Description (from the file)                                                                                                            |
| -------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `essential-cp-behavior`    | Essential CP Behavior            | Auto-start on connect: plug in, wait for RemoteStart, run a transaction with auto-meter (stops at the EV's target SoC), then plug out. |
| `full-charging-cycle`      | Full Charging Cycle              | Complete charging cycle with AutoMeterValue                                                                                            |
| `multi-status-monitor`     | Multi-Status Monitor (Parallel)  | Monitor multiple statuses in parallel and execute different actions                                                                    |
| `remote-start-auto-meter`  | Remote Start + Auto MeterValue   | Wait RemoteStartTransaction → Start charging → AutoMeterValue                                                                          |
| `smart-charging`           | Smart Charging (Auto MeterValue) | Auto-increment MeterValue when Charging, stop when Finishing                                                                           |
| `status-triggered-actions` | Status-Triggered Auto Actions    | Auto-execute on status change (Heartbeat loop when Available)                                                                          |

All six target a single connector (`targetType: "connector"`).

`essential-cp-behavior` meters every session it runs on a connector, not only
the first. Each session starts from the cumulative register (`meterStart` of
session N+1 is `meterStop` of session N), and its Auto MeterValue node holds
until that session's own target is reached. The target is `meterStart`
plus capacity × (targetSoc − initialSoc). A 1.6 `StopTransaction.conf` never
affects a transaction that began after its request was sent, even when the
CSMS answers late or the CALL has already timed out (#367).

Its declarative `evSettings` are a 10 kWh "Compact EV" at 70 % → 80 % (50 kW), so the
Auto MeterValue node reaches the target in about 75 s and the run gets to its
RemoteStopTransaction trigger in reasonable time; the original 75 kWh, 20 % → 80 %
session took about 54 minutes (#1078).

`smart-charging` waits for Finishing in a branch beside its Auto MeterValue node (`parallel` /
`join`), not after it: a stop during the meter takes the connector through Finishing to
Available at once, so a wait armed only after the meter returned would never see it (#1080).

## Certification templates (`cert16-*`)

47 templates (46 `cert16-tcNNN-*` files plus `cert16-reservation-basic` for
TC_046) implement the **Charge Point side** of OCPP 1.6 certification
test cases (OCPPSC numbering: `cert16-tc001-cold-boot` ↔ TC_001, …). They
synchronize on incoming CSMS calls and drive CP-side behavior; they do not
validate CSMS payloads — verifying wire content is up to the operator or the
CSMS-side tooling. The full mapping table (test case, profile, CSMS-side
operator action), the numbering note, configuration side effects, the
per-action `responseOverride` status matrix, and the out-of-scope list live in
the raw README summarized at
[cert16 templates README](../sources/cert16-templates-readme.md).

Profiles covered: Core, RemoteTrigger, LocalAuthList, Reservation,
SmartCharging, Firmware, plus the Authorize-outcome cases (TC_023.x, issue
#181). Security / certificate test cases (TC_073–TC_088) and offline
transaction cases are out of scope for the `cert16-*` set; the
[power-loss primitive](../concepts/power-loss.md) and the
[resilience templates](#resilience-templates-resilience-) cover recovery after an outage.

`cert16-octt-strictness-probe` is a special template: it uses
warning-severity `ocpp_absent` assertions to flag CSMS behaviors that are
legal in OCPP 1.6 but known to break OCTT certification runs — see
[Scenario format → OCTT strictness probe](../concepts/scenario-format.md#octt-strictness-probe).

The [steve-verify](../sources/steve-verify-readme.md) harness drives all 47
`cert16-*` templates against a real SteVe CSMS.

## OCPP 2.0.1 / 2.1 variants

Until the variants existed only the two `dataflow-*-201` templates targeted 2.x: the `cert16-*` set speaks 1.6 (its
assertions read `StartTransaction`, `idTagInfo`, `StatusNotification.status`) and the `resilience-*` assertions read 1.6
payloads. 32 templates copy the graph of a 1.6 template, which the engine runs unchanged on either version
([version-agnostic scenarios](../concepts/ocpp-versions-and-transports.md#version-agnostic-scenarios)), and swap what is
version specific: the `csmsExpectations` payloads (2.x `RequestStartTransaction`, `Reset` `Immediate` / `OnIdle`,
`ReserveNow` with `id` / `idToken` / `evseId`, `ChangeAvailability` `operationalStatus`), the Authorize answer
(`idTokenInfo`) and the assertions (`TransactionEvent` `Started` / `Ended` with `stoppedReason`, `connectorStatus`
`Occupied` / `Reserved` / `Unavailable`). All declare `ocppVersions: ["2.0.1", "2.1"]`: the wire shapes are the same in both,
and `templateExpectations.bun.test.ts` runs each of them on both versions against the fake CSMS, every assertion passing.
The golden wire fixtures pin the 2.0.1 run.

| Group (ids)                                                                                                                                    | Variant of                                         | What changes on 2.x                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `essential-cp-behavior-201`, `remote-start-auto-meter-201`, `full-charging-cycle-201`                                                          | the 1.6 general-purpose template                   | `RequestStartTransaction` / `RequestStopTransaction`; transactions are `TransactionEvent`s.                                                                                                                                           |
| `cert201-cold-boot`, `-charging-plugin-first`, `-charging-id-first`, `-ev-side-disconnect`                                                     | `cert16-tc001`, `tc003`, `tc004`, `tc005`          | `Occupied` instead of `Preparing` / `Charging`; `stoppedReason: EVDisconnected`.                                                                                                                                                      |
| `cert201-remote-start`, `-remote-start-stop`, `-remote-stop`, `-remote-start-rejected`, `-remote-stop-rejected`                                | `cert16-tc010`, `tc011`, `tc012`, `tc026`, `tc028` | `RequestStartTransaction` carries an `idToken`, a `remoteStartId` and an `evseId`; the transaction id is the charge point's UUID.                                                                                                     |
| `cert201-reset-immediate`, `-reset-onidle`                                                                                                     | `cert16-tc013`, `tc014`                            | `Immediate` ends the running transaction; `OnIdle` with one running is answered `Scheduled`.                                                                                                                                          |
| `cert201-unlock-ongoing-transaction`                                                                                                           | `cert16-tc017`                                     | An unlock during an authorized transaction is answered `OngoingAuthorizedTransaction`; the 1.6 `Unlocked` / `UnlockFailed` outcomes (`unlockOutcome`) do not exist, so `tc018` has no variant.                                        |
| `cert201-authorize-invalid`, `-authorize-expired`, `-authorize-blocked`                                                                        | `cert16-tc023-*`                                   | Answered with `idTokenInfo.status`; no `TransactionEvent` follows.                                                                                                                                                                    |
| `cert201-reserve-now-faulted`, `-occupied`, `-unavailable`, `-rejected`, `-cancel-reservation`, `-cancel-reservation-rejected`                 | `cert16-tc048-*`, `tc051`, `tc052`                 | `ReserveNow` with `id`, `expiryDateTime`, `idToken`, `evseId`.                                                                                                                                                                        |
| `cert201-trigger-message`, `-trigger-message-rejected`, `-clear-cache`, `-data-transfer`                                                       | `cert16-tc054`, `tc055`, `tc061`, `tc064`          | `TriggerMessage` names an `evse`; `ClearCache` is answered `Rejected` unless the authorization cache is enabled, so only its arrival is asserted.                                                                                     |
| `resilience-authorization-rejected-201`, `-connector-fault-recovery-201`, `-ev-disconnect-recovery-201`, `-temporary-unavailable-recovery-201` | the four 1.6 resilience templates                  | `connectorStatus`, `TransactionEvent` and `idTokenInfo` assertions; `ChangeAvailability` carries `operationalStatus` and an `evse`. `resilience-communication-loss-recovery` and `-power-loss-recovery` already ran on every version. |

The `cert201-*` ids carry no OCA test-case number: they are CP-side cases in the style of the 1.6 set, not a claim of
coverage of a numbered Part 6 case, and they are not part of the TCK id contract above. Cases whose 1.6 graph needs a 1.6-only
mechanism (the local list, firmware and diagnostics, smart-charging profiles, `unlockOutcome`) have no variant yet.

## Data-flow templates (`dataflow-*`)

Six templates that show off what a scenario can read and branch on (schema 1.7):
the `$from` roots `response`, `call` and `connector`, and `switch` cases written as
`$match` matchers. They need no certification setup; the CSMS only has to answer the way
the case being demonstrated needs. The `-16` / `-201` pairs differ only in the payload
shape (OCPP 1.6 `idTag` / `idTagInfo` against 2.0.1 `idToken` / `idTokenInfo`).

| Template id                                     | Shows                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataflow-authorize-branch-16` / `-201`         | `ocppCall` Authorize, then a `switch` on `response.payload.idTagInfo.status` (`idTokenInfo` on 2.0.1): Accepted starts a session, `$match in` Blocked / Invalid / Expired, ConcurrentTx, and `default`.                                                        |
| `dataflow-call-error-handling`                  | `ocppCall` DataTransfer, then `response.kind`; on a result `response.payload.status`, on a CALLERROR `response.errorCode` with `$match` `in` / `endsWith` / `startsWith`. Each outcome reports itself with its own DataTransfer `messageId`. Version-agnostic. |
| `dataflow-charge-to-soc`                        | A bounded loop edge (schema 1.10): the `meter` step (7 s a pass) loops back to itself until `connector.power.soc` matches `$match gte 80` (`until`) or 2 hours (`forSeconds: 7200`) have passed, then stops the transaction. No `switch` node.                 |
| `dataflow-remote-start-reauthorize-16` / `-201` | `csmsCallTrigger` with `behavior: "replace"`, a `callResponse` Accepted, then Authorize with the tag read from the CALL (`$from call.payload.idTag`) and a `switch` on the answer. The session that follows starts with that same tag (#1079).                 |

The `cert16-tc023-*` templates are untouched: their ids are part of the TCK contract and
their golden frames pin them. `dataflow-authorize-branch-*` covers the same ground (one
Authorize, a different answer each time) in one file and reads the answer instead of
relying on a pre-registered tag per outcome. Each template is run by
`packages/core/src/test/goldenWire/dataflowTemplates.bun.test.ts` against the fake CSMS
with several answers, asserting the branch taken, and is validated with
`validateScenarioGraph` (no findings).

## `remote-start-timeout-fallback` (timeout edge, schema 1.8)

Waits 30 s for a `RemoteStartTransaction`. On the answer it starts a session with
automatic meter values; if the wait times out, its `kind: "timeout"` edge sets the
connector back to Available and ends instead of failing the run. Not a certification
case. Its golden frames pin the event path; the timeout path is covered by
`ScenarioExecutor.timeoutEdges.test.ts`
(see [Scenario format](../concepts/scenario-format.md)).

## `parallel-heartbeat-session` (parallel / join, schema 1.9)

A `parallel` node runs a three-Heartbeat branch next to a `RemoteStartTransaction` session
(start, meter values); a `join` with `mode: "all"` waits for both branches, then the run
ends. Not a certification case. Its golden frames pin one run (the fake CSMS answers the
heartbeats and sends the remote start); see
[Scenario format](../concepts/scenario-format.md) for `parallel` / `join`.

## Resilience templates (`resilience-*`)

Six assertion-driven scenarios for operational failures and their recovery
(#444). They add no fault mechanism of their own: a fault is either an event
the scenario reports itself (a `Faulted` status), a normal operator action
(`ChangeAvailability`, an idTag the CSMS blocks, pulling the cable), or an
injection through an existing primitive — [network simulation](../concepts/network-simulation.md)
(`network_sim.disconnect.trigger`, or any socket drop) and the
[power-loss](../concepts/power-loss.md) primitive (`power.loss` / `power.restore`,
#455). A `connectionTrigger` only observes, so the injection is the operator's
(or a test's). Each ends in the run's machine-readable verdict
(`conformanceVerdict` / `verdict` of the [run report](../concepts/scenario-format.md#assertions--verdicts)).
Like the `cert16-*` templates they auto-start on connect; use
`run_scenario_template { "once": true }` to run one deliberately.

| Template id                                 | Fault                                                               | Passes when                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resilience-communication-loss-recovery`    | Operator cuts the connection while the connector is Available       | After the drop, the reconnect and Available again, a DataTransfer probe (`org.ocpp-cp-sim.resilience` / `link-probe`) went out over the recovered link. No BootNotification is asserted: OCPP-J 1.6 §5.4 and 2.x Part 4 §5.4 say a station SHOULD NOT send one on a plain reconnect unless its boot data changed. Version-agnostic (run on 1.6 and 2.0.1). |
| `resilience-connector-fault-recovery`       | The scenario reports `Faulted` / `GroundFailure`, holds 3 s, clears | Both StatusNotifications were sent; the fault carries `errorCode: GroundFailure` (1.6 payload).                                                                                                                                                                                                                                                            |
| `resilience-ev-disconnect-recovery`         | The cable is pulled mid-charge                                      | `StopTransaction` with reason `EVDisconnected` after `StartTransaction` (1.6 §4.10) and the connector Available again.                                                                                                                                                                                                                                     |
| `resilience-temporary-unavailable-recovery` | CSMS sends `ChangeAvailability` Inoperative, then Operative         | Both calls arrived; the connector reported Unavailable, then Available (1.6 payload for the statuses).                                                                                                                                                                                                                                                     |
| `resilience-authorization-rejected`         | The idTag `RESIL-BLK` is Blocked on the CSMS (operator prepares it) | `Authorize` was answered `Blocked` and no `StartTransaction` followed (1.6 payload).                                                                                                                                                                                                                                                                       |
| `resilience-power-loss-recovery`            | Operator calls `power.loss`, then `power.restore`, during a session | A BootNotification and then a StatusNotification went out after the power came back. Independent of resume / end.                                                                                                                                                                                                                                          |

Their `csmsExpectations` say what the operator injects (`simulatorSteps`: `disconnect` / `connect` for the two link cuts).
The four that read 1.6 payloads have `-201` variants (see [OCPP 2.0.1 / 2.1 variants](#ocpp-201--21-variants)).
Assertions on the 1.6 payload shape (`StatusNotification.status`,
`StopTransaction.reason`, `idTagInfo`) make those templates 1.6 scenarios; the
communication-loss and power-loss ones only look at action names. Checks run
through `packages/core/src/test/goldenWire/resilienceTemplates.bun.test.ts`
(each template against the fake CSMS, with the injection the table names,
passing, and failing on an empty transcript) next to the usual per-template
golden frames.

## Template instances

Loading a template does not hand you the template file: it produces an
_instance_ with its own `id` and a `templateId` field naming what it came
from. On the daemon the id is stable, `<templateId>-c<connectorId>` (#338), so
instantiating a template is idempotent per (template, connector); in the
browser it stays unique per load
(`<templateId>-<cpId>-c<connectorId>-<timestamp>-<suffix>`). Details:
[Scenario format → Template instances](../concepts/scenario-format.md#template-instances).
