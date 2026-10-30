---
title: OCPP 2.x variable monitoring
type: concept
summary: How a 2.0.1 / 2.1 station stores custom variable monitors (SetVariableMonitoring, ClearVariableMonitoring), reports them (GetMonitoringReport → NotifyMonitoringReport), evaluates them into NotifyEvent filtered by the monitoring level, applies SetMonitoringBase and persists them, with the statuses and their N-use-case requirement ids.
sources:
  - src/cp/domain/monitoring/
  - src/cp/infrastructure/transport/v201/variableMonitoringV201.ts
  - src/cp/infrastructure/transport/v201/notifyEventV201.ts
  - src/cp/domain/persistence/schema.ts
  - src/cp/infrastructure/transport/v201/deviceModelMap.ts
  - src/cp/infrastructure/transport/v201/baseReportV201.ts
  - src/cp/infrastructure/transport/v21/inboundRegistryV21.ts
  - "issue #457"
  - OCPP 2.0.1 Part 2 §N02–N07; OCPP 2.1 Part 2 §N02–N07
related:
  - ocpp-versions-and-transports.md
  - state-persistence.md
updated: 2026-10-29
---

# OCPP 2.x variable monitoring

An OCPP 2.0.1 or 2.1 station keeps a catalog of **variable monitors**: rules
the CSMS installs on a device-model variable so that the station reports
when the value crosses a threshold or moves by a step. This page covers what
the simulator stores, answers and reports (#457): the monitor catalog, its
evaluation into `NotifyEvent`, the monitoring level, `SetMonitoringBase` and
persistence. 1.6 has no monitoring and is unchanged: a `ChangeConfiguration`
on a 1.6 station never sends a `NotifyEvent`. See
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
| `Rejected`               | Variable mapped to a configuration key the station does not have (the `GetVariables` answer), no `statusInfo`              | —                |
| `Rejected`               | `id` given and no monitor has it (`UnknownMonitorId`)                                                                      | N04.FR.13        |
| `Rejected`               | `id` given and its monitor is on another component/variable (`TargetMismatch`)                                             | N04.FR.16        |
| `UnsupportedMonitorType` | Type not supported on this variable (table above)                                                                          | N04.FR.05        |
| `Rejected`               | Threshold outside the range (`ValueOutOfRange`), negative Delta (`NegativeDelta`), severity above 9 (`SeverityOutOfRange`) | N04.FR.06, FR.14 |
| `Duplicate`              | Another monitor with the same type and severity on the same component/variable                                             | N04.FR.10        |
| `Accepted`               | Installed; the result carries the monitor `id`                                                                             | N04.FR.08        |

Every other `Rejected` result carries `statusInfo.reasonCode` (the name in
brackets) and an `additionalInfo` naming the requirement. Without an `id` the station
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
default, and restricts `NotifyEvent` to monitors with a severity number at
or below it (N05.FR.03, N07.FR.15). The spec does not say the level survives
a reboot, so it is not persisted: a restarted station is back at 9.

## Evaluation and NotifyEvent

A monitor watches the configuration value behind its variable, the value
`GetVariables` reads. It is evaluated when that value changes through
`SetVariables` or a scenario `configSet` node (a value restored from
`--state-db` at start-up is not a change), and when the monitor is installed
or replaced.
The other device-model values (meter readings, connector state) are not
variables of the map, so they never trigger a monitor.

| Type             | Fires when                                                                                      | `trigger`  | Requirement |
| ---------------- | ----------------------------------------------------------------------------------------------- | ---------- | ----------- |
| `UpperThreshold` | The value goes above the threshold (not on it); `cleared: true` when it comes back at or below  | `Alerting` | N07.FR.16   |
| `LowerThreshold` | The value goes below the threshold (not on it); `cleared: true` when it comes back at or above  | `Alerting` | N07.FR.17   |
| `Delta`, numeric | The value moved more than the step (strictly) from the baseline; the baseline becomes the value | `Delta`    | N07.FR.18   |
| `Delta`, other   | The value changed from the baseline, whatever the step (booleans, strings, lists)               | `Delta`    | N07.FR.19   |

- A threshold fires once per crossing: the station remembers that it is
  triggered, sends `cleared: true` when the value returns within range
  (N07.FR.02) and nothing while it stays beyond. A monitor installed on a
  value already beyond its threshold fires at once.
- A Delta baseline is the value when the monitor was set (or replaced) or
  last reported, whichever was last: the step counts « since the last time
  this event notice was sent » (N07.FR.18).
- Replacing a threshold monitor by `id` re-checks it against the current
  value: a new threshold that clears the old one sends `cleared: true`, one
  the value exceeds sends the trigger (N07.FR.11). A triggered threshold
  replaced by a monitor of another type (the other threshold, or a Delta)
  that is not triggered sends `cleared: true` for the old monitor, with its
  type and severity; a replacement that is triggered sends its own trigger
  only.
- Removing a monitor (ClearVariableMonitoring, SetMonitoringBase) sends
  nothing, even if it was triggered (N07.FR.12).
- The monitoring level and the `transaction` flag only decide whether an
  event is **sent**. A filtered threshold still records that it is
  triggered, so its `cleared` event follows once the level allows it; a
  filtered Delta keeps its baseline, so the next change is measured from the
  last value reported. A monitor with `transaction: true` reports only while
  a transaction runs on the station.
- Nothing is sent until BootNotification is `Accepted` (B02.FR.02 allows no
  NotifyEvent while `Pending`), nor between a disconnect and the next
  `Accepted` boot. Meanwhile a threshold keeps the state the CSMS was last
  told and a Delta keeps its baseline; on `Accepted` every threshold is
  re-checked against the current value, so a crossing in between sends its
  trigger or `cleared` then (a Delta waits for the next change). A
  triggered threshold replaced in that window by the other threshold sends
  its owed `cleared` with the replacement's type and severity; replaced by
  a Delta, it never sends it.

The events of one value change (or one install, or one `Accepted` boot) go
out as **one** `NotifyEvent`, after the answer to the message that caused
them, with
`generatedAt`, `seqNo` 0 and `tbc` false (N07.FR.07), and one `eventData`
per monitor, by increasing monitor id:

- `eventId` (increasing per station from 1, restarting at 1 after a
  restart), `timestamp`, `trigger`, `actualValue` as `GetVariables` renders
  it (empty for a write-only value, N07.FR.10), `cleared` only when true;
- `component`, `variable` and `variableMonitoringId` of the monitor
  (N07.FR.06), and `eventNotificationType` `CustomMonitor`;
- on 2.1 only, the monitor's `severity` (2.1 N07.FR.20); the 2.0.1 schema
  does not allow the field.

## SetMonitoringBase

No preconfigured or hardwired monitor is modelled, so the three bases are
all correct with an empty catalog of both, and all answer `Accepted`
(N03.FR.01). `NotSupported` (N03.FR.02) never happens: the schema admits no
other value.

| `monitoringBase` | Effect on the custom monitors          | Requirement |
| ---------------- | -------------------------------------- | ----------- |
| `All`            | Kept                                   | N03.FR.03   |
| `FactoryDefault` | Deleted (no factory default to enable) | N03.FR.04   |
| `HardWiredOnly`  | Deleted                                | N03.FR.05   |

Deleted monitors send no `NotifyEvent` (N07.FR.12) and their rows leave the
state database.

## Persistence

With `--state-db` (or the browser's database), the installed monitors are
stored in the `variable_monitors` table (schema v21, see
[State persistence](state-persistence.md)) and restored when the station is
created again: monitors survive a reboot (N04 remarks, N07.FR.13). Ids
resume after the highest restored one, so a CSMS that sends
`GetMonitoringReport` after the reboot (N04.FR.19) sees the same ids. The
triggered flag of a threshold monitor (as last reported) is stored too, so
a value that returns within range after the reboot still sends
`cleared: true` (N07.FR.14), at the first `Accepted` boot when the value
is already back in range at start-up. A Delta baseline restarts at the
restored value. The monitoring level is not
stored (above).

## Limits

- **Offline.** No `NotifyEvent` is queued while the station is offline:
  N07.FR.04 queues events at or below
  `MonitoringCtrlr.OfflineQueuingSeverity`, an optional variable the
  simulator does not model, so its precondition never holds. Threshold
  crossings meanwhile are reported by the re-check at the next `Accepted`
  boot (above); Delta events are not.
- **Value sources.** Events follow a CSMS `SetVariables` /
  `SetVariableMonitoring`, a scenario `configSet` node, or the threshold
  re-check of an `Accepted` boot. A `SetVariables` that changes several
  values sends one `NotifyEvent` per value change, not one per request.
- **Bounds.** A threshold outside the variable's range is rejected
  (`ValueOutOfRange`, N04.FR.06), but `GetBaseReport` publishes no
  `variableCharacteristics.minLimit` / `maxLimit`, so the CSMS cannot read
  that range beforehand.
- **Target.** `evse` and `instance` are ignored to resolve the variable,
  as for `GetVariables`: a monitor on a station-level component with an
  `evse` is accepted and is a distinct target from the same monitor without
  one (`Duplicate`, `TargetMismatch` and the report grouping compare
  `evse` and `instance`).
- **Catalogs.** No hardwired or preconfigured monitors, no `Periodic` /
  `PeriodicClockAligned` monitors (N08), no 2.1 `TargetDelta` /
  `TargetDeltaRelative`.
- **MonitoringCtrlr.** None of its variables is mapped. The required
  `ItemsPerMessage` / `BytesPerMessage` (instance `SetVariableMonitoring`)
  need variable instances, which the device-model map does not have; the
  others (`Enabled`, `Available`, `OfflineQueuingSeverity`,
  `ActiveMonitoringBase`, `ActiveMonitoringLevel`) are optional.
- **Reports in parts.** A `NotifyEvent` is never split (`tbc` is always
  false), and no `cause`, `techCode`, `techInfo` or `transactionId` is set.
