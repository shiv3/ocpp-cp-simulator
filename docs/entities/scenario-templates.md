---
title: Built-in scenario templates
type: entity
summary: The scenario JSON files shipped inside the package — six general-purpose flows, six `resilience-*` failure / recovery scenarios, the 47 `cert16-*` OCPP 1.6 certification test-case templates and the OCTT strictness probe — and how template instances behave.
sources:
  - packages/core/src/utils/scenarioTemplates.ts
  - packages/core/src/utils/scenarios/*.json
  - packages/core/src/utils/scenarios/README.md
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
updated: 2026-11-08
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
template without an entry, such as the `resilience-*` templates today, shows
the file's own text in every language.

## Where templates are used

| Surface                                                          | How                                                                                                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [Web console](web-console.md) Scenario Editor                    | Pick a template from the dropdown; `cert16-*` templates auto-start once the connector reaches `Available` (`triggerOn: "connect"`). |
| [CLI](cli.md#startup-scenarios) startup                          | `--scenario-template <id> --scenario-connector <list>`                                                                              |
| [Control plane](../concepts/control-plane.md#cp-command-methods) | `list_scenario_templates`, `load_scenario_template`, `run_scenario_template`                                                        |
| [MCP endpoint](mcp-endpoint.md)                                  | `scenario_templates`, `run_scenario_template`                                                                                       |

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
