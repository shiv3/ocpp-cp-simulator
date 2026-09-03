---
title: Built-in scenario templates
type: entity
summary: The scenario JSON files shipped inside the package — six general-purpose flows plus the 44 `cert16-*` OCPP 1.6 certification test-case templates and the OCTT strictness probe — and how template instances behave.
sources:
  - src/utils/scenarioTemplates.ts
  - src/utils/scenarios/*.json
  - src/utils/scenarios/README.md
related:
  - ../concepts/scenario-format.md
  - ../sources/cert16-templates-readme.md
  - ../sources/steve-verify-readme.md
  - cli.md
updated: 2026-09-03
---

# Built-in scenario templates

Every built-in template is a flat `ScenarioDefinition` JSON file under
[`src/utils/scenarios/`](../../src/utils/scenarios/) — the same
[scenario format](../concepts/scenario-format.md) the editor exports and the
example files under `docs/examples/scenarios/` use — wrapped by
[`scenarioTemplates.ts`](../../src/utils/scenarioTemplates.ts) into the
editor-facing `ScenarioTemplate` interface. Because they are plain files, the
daemon's `--scenario-template-file` can load any of them straight off disk
without going through the loader.

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

## Certification templates (`cert16-*`)

44 templates implement the **Charge Point side** of OCPP 1.6 certification
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
transaction cases are out of scope.

`cert16-octt-strictness-probe` is a special template: it uses
warning-severity `ocpp_absent` assertions to flag CSMS behaviors that are
legal in OCPP 1.6 but known to break OCTT certification runs — see
[Scenario format → OCTT strictness probe](../concepts/scenario-format.md#octt-strictness-probe).

The [steve-verify](../sources/steve-verify-readme.md) harness drives all 44
`cert16-*` templates against a real SteVe CSMS.

## Template instances

Loading a template does not hand you the template file: it produces an
_instance_ with its own `id`
(`<templateId>-<cpId>-c<connectorId>-<timestamp>-<suffix>`) and a
`templateId` field naming what it came from. On the daemon, instantiating a
template is idempotent per (template, connector). Details:
[Scenario format → Template instances](../concepts/scenario-format.md#template-instances).
