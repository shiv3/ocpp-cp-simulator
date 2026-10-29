---
title: OCPP 2.x variable monitoring
type: concept
summary: How a 2.0.1 / 2.1 station stores custom variable monitors (SetVariableMonitoring, ClearVariableMonitoring), reports them (GetMonitoringReport → NotifyMonitoringReport) and keeps the monitoring level, with the per-item statuses and their N-use-case requirement ids.
sources:
  - src/cp/domain/monitoring/
  - src/cp/infrastructure/transport/v201/variableMonitoringV201.ts
  - src/cp/infrastructure/transport/v201/deviceModelMap.ts
  - src/cp/infrastructure/transport/v201/baseReportV201.ts
  - src/cp/infrastructure/transport/v21/inboundRegistryV21.ts
  - "issue #457"
  - OCPP 2.0.1 Part 2 §N02–N07; OCPP 2.1 Part 2 §N02–N07
related:
  - ocpp-versions-and-transports.md
updated: 2026-10-29
---

# OCPP 2.x variable monitoring

An OCPP 2.0.1 or 2.1 station keeps a catalog of **variable monitors**: rules
the CSMS installs on a device-model variable so that the station reports
when the value crosses a threshold or moves by a step. This page covers what
the simulator stores and answers (#457). Monitor **evaluation** (sending
`NotifyEvent`), monitoring-level filtering and persistence across a restart
are not implemented yet; until then no monitor ever produces an event. 1.6
has no monitoring and is unchanged. See
[OCPP versions and transports](ocpp-versions-and-transports.md) for the
version surface.

## The device model behind a monitor

A monitor targets a component/variable pair resolved through the same map as
`GetVariables` / `SetVariables`
([`deviceModelMap.ts`](../../src/cp/infrastructure/transport/v201/deviceModelMap.ts)):
thirteen 2.x variables, each backed by a 1.6 configuration key. An unknown
component answers `UnknownComponent` and a known component with an unknown
variable answers `UnknownVariable`, exactly as those messages do. As there,
`instance` and `evse` do not change the lookup; they are kept on the monitor
and distinguish two monitors on the same variable.

Every mapped variable accepts at least a `Delta` monitor, so `GetBaseReport`
and `GetReport` report `supportsMonitoring: true` on all of them.

## Monitor types

| Type                                       | Accepted on                    | Value rule                                                       |
| ------------------------------------------ | ------------------------------ | ---------------------------------------------------------------- |
| `UpperThreshold`, `LowerThreshold`         | integer variables              | Inside the configuration key's `min` / `max`, if any (N04.FR.06) |
| `Delta`                                    | every mapped variable          | Not negative (N04.FR.14); any value on a non-numeric variable    |
| `Periodic`, `PeriodicClockAligned`         | none: `UnsupportedMonitorType` | (N04.FR.05)                                                      |
| `TargetDelta`, `TargetDeltaRelative` (2.1) | none: `UnsupportedMonitorType` | (N04.FR.05)                                                      |
| A threshold on a boolean / string / list   | none: `UnsupportedMonitorType` | (N04.FR.05)                                                      |

Severity must be an integer from 0 to 9. The schemas only set a minimum, so
a severity above 9 answers `Rejected` with `statusInfo.reasonCode`
`SeverityOutOfRange`.

## SetVariableMonitoring

One `setMonitoringResult` per `setMonitoringData` item, in order, echoing its
`type`, `severity`, `component` and `variable` (N04.FR.01, FR.02). Items
apply one after the other, so two identical items in one request answer
`Accepted` then `Duplicate`. Checks run in this order:

| Status                   | When                                                                                                                       | Requirement      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `UnknownComponent`       | Component not in the device-model map                                                                                      | N04.FR.03        |
| `UnknownVariable`        | Variable not in the map for that component                                                                                 | N04.FR.04        |
| `Rejected`               | `id` given and no monitor has it (`UnknownMonitorId`)                                                                      | N04.FR.13        |
| `Rejected`               | `id` given and its monitor is on another component/variable (`TargetMismatch`)                                             | N04.FR.16        |
| `UnsupportedMonitorType` | Type not supported on this variable (table above)                                                                          | N04.FR.05        |
| `Rejected`               | Threshold outside the range (`ValueOutOfRange`), negative Delta (`NegativeDelta`), severity above 9 (`SeverityOutOfRange`) | N04.FR.06, FR.14 |
| `Duplicate`              | Another monitor with the same type and severity on the same component/variable                                             | N04.FR.10        |
| `Accepted`               | Installed; the result carries the monitor `id`                                                                             | N04.FR.08        |

A `Rejected` result carries `statusInfo.reasonCode` (the name in brackets)
and an `additionalInfo` naming the requirement. Without an `id` the station
allocates one (N04.FR.11); ids increase from 1 and are not reused while the
station runs. With the `id` of an existing monitor on the same
component/variable, the monitor is replaced in place (N04.FR.12) and becomes
a custom monitor (N04.FR.15). Every installed monitor is a custom monitor:
there are no hardwired or preconfigured monitors yet.

## ClearVariableMonitoring

One `clearMonitoringResult` per `id`, in order (N06.FR.05): `Accepted` when
a monitor was removed (N06.FR.01), `NotFound` otherwise (N06.FR.02),
including an id repeated after its first clear. `Rejected` (N06.FR.03) is
reserved for hardwired monitors, which do not exist yet.

## GetMonitoringReport → NotifyMonitoringReport

| Request                                                | Response         | Requirement |
| ------------------------------------------------------ | ---------------- | ----------- |
| Only `PeriodicMonitoring` in `monitoringCriteria`      | `NotSupported`   | N02.FR.02   |
| Selection matches no monitor (or no monitor installed) | `EmptyResultSet` | N02.FR.10   |
| Otherwise                                              | `Accepted`       | N02.FR.01   |

- `ThresholdMonitoring` selects Upper/Lower thresholds and `DeltaMonitoring`
  selects Delta monitors (N02.FR.12, FR.13). Next to a supported criterion,
  `PeriodicMonitoring` matches nothing instead of failing the request.
- `componentVariable` narrows the selection; a missing `variable`,
  `instance`, `evse` or `connectorId` matches every value (N02.FR.16–FR.21).
  With both filters, a monitor must pass both (N02.FR.05).
- After an `Accepted` response the station sends **one**
  `NotifyMonitoringReport` (the same single-message pattern as
  `GetBaseReport`) with the request's `requestId`, `seqNo` 0 and `tbc`
  false (N02.FR.03, FR.04, FR.09). Monitors are grouped per
  component/variable in `monitor[].variableMonitoring[]`.
- On 2.1 each monitor also carries `eventNotificationType`
  (`CustomMonitor`), which 2.1 requires (2.1 N02.FR.22) and the 2.0.1
  schema forbids.

## SetMonitoringLevel

A severity from 0 to 9 answers `Accepted` and becomes the station's
monitoring level (N05.FR.01); anything else answers `Rejected` and keeps the
previous level (N05.FR.02). The level starts at 9, since the spec gives no
default. It will restrict `NotifyEvent` to monitors with a severity number
at or below it (N05.FR.03) once evaluation exists; it is not persisted yet.

## SetMonitoringBase

Still answers `NotSupported` (N03.FR.02): the preconfigured and hardwired
monitor catalogs that `All`, `FactoryDefault` and `HardWiredOnly` act on are
not modelled.
