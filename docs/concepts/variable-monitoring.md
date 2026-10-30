---
title: OCPP 2.x variable monitoring
type: concept
summary: How a 2.0.1 / 2.1 station stores custom variable monitors (SetVariableMonitoring, ClearVariableMonitoring) next to its own hardwired and preconfigured ones, reports them (GetMonitoringReport → NotifyMonitoringReport, in parts), evaluates them into NotifyEvent (thresholds, Delta, Periodic, 2.1 TargetDelta) filtered by the monitoring level, queues them offline per OfflineQueuingSeverity, applies SetMonitoringBase, publishes the MonitoringCtrlr variables and the runtime values (EVSE.Power, AvailabilityState) and persists it all, with the statuses and their N-use-case requirement ids.
sources:
  - src/cp/domain/monitoring/
  - src/cp/domain/monitoring/PeriodicMonitorScheduler.ts
  - src/cp/domain/charge-point/runtimeValueKeys.ts
  - src/cp/domain/charge-point/DeviceModelTargets.ts
  - src/cp/infrastructure/transport/v201/variableMonitoringV201.ts
  - src/cp/infrastructure/transport/v201/getVariablesV201.ts
  - src/cp/infrastructure/transport/v201/setVariablesV201.ts
  - src/cp/infrastructure/transport/v201/notifyEventV201.ts
  - src/cp/infrastructure/transport/v201/reportParts.ts
  - src/cp/domain/monitoring/monitorCatalog.ts
  - src/cp/domain/monitoring/monitoringCtrlrKeys.ts
  - src/cp/domain/persistence/schema.ts
  - src/cp/infrastructure/transport/v201/deviceModelMap.ts
  - src/cp/infrastructure/transport/v201/baseReportV201.ts
  - src/cp/infrastructure/transport/v21/inboundRegistryV21.ts
  - "issue #457"
  - "issue #538"
  - OCPP 2.0.1 Part 2 §N02–N08, §2.11; OCPP 2.1 Part 2 §N02–N08, §2.13
  - OCPP 2.0.1 / 2.1 Part 2 appendices, standardized components (dm_components_vars.csv)
related:
  - ocpp-versions-and-transports.md
  - state-persistence.md
updated: 2026-10-30
---

# OCPP 2.x variable monitoring

An OCPP 2.0.1 or 2.1 station keeps a catalog of **variable monitors**: rules
the CSMS installs on a device-model variable so that the station reports
when the value crosses a threshold or moves by a step. This page covers what
the simulator stores, answers and reports (#457, #538): the monitor catalog,
the station's own monitors, its evaluation into `NotifyEvent` (on value
changes, on a timer for periodic monitors), the monitoring level,
`SetMonitoringBase`, the `MonitoringCtrlr` variables, the runtime values a
monitor can watch, and persistence. The final
[table](#issue-538-items) lists each #538 item with its requirement id.
1.6 has no monitoring and is unchanged: a `ChangeConfiguration`
on a 1.6 station never sends a `NotifyEvent`. See
[OCPP versions and transports](ocpp-versions-and-transports.md) for the
version surface.

## The device model behind a monitor

A monitor targets a component/variable pair resolved through the same map as
`GetVariables` / `SetVariables`
([`deviceModelMap.ts`](../../src/cp/infrastructure/transport/v201/deviceModelMap.ts)):
each 2.x variable there is backed by a configuration key, a 1.6 key or a
read-only value the 2.x station defines at runtime (the `MonitoringCtrlr`
variables and the [runtime values](#runtime-values) below). An unknown
component answers `UnknownComponent` and a
known component with an unknown variable answers `UnknownVariable`, exactly
as those messages do (N04.FR.03, FR.04).

- **Variable instance.** An instanced variable is only found with its
  `variable.instance`, as for `GetVariables` (#538): a monitor on
  `OCPPCommCtrlr.MessageAttempts` with instance `TransactionEvent` is
  accepted, without the instance it is `UnknownVariable`. A variable without
  instances answers whatever instance the CSMS names.
- **EVSE.** A component is its name plus its EVSE scope, so a
  `component.evse` the station does not have answers `UnknownComponent`
  (N04.FR.03, #538). EVSE N is connector N and has one connector, number 1:
  on a two-connector station `evse` 1 or 2 (with `connectorId` 1 or none)
  resolves, `evse` 0 or 3 or `connectorId` 2 does not. `GetVariables` /
  `SetVariables` do not check the EVSE of a station-wide variable; an
  `EVSE` or `Connector` variable (below) needs an `evse` the station has,
  or answers `UnknownComponent` there too (B05.FR.04, B06.FR.06). A
  resolved `evse` (and `instance`) is kept on the monitor: it
  distinguishes two monitors on the same variable, is echoed in reports
  and events, and links the events to the transaction on that EVSE
  (below).

Every mapped variable accepts at least a `Delta` monitor, so `GetBaseReport`
and `GetReport` report `supportsMonitoring: true` on all of them.

### Runtime values

Next to the configuration, a 2.x station publishes the live values of the
standardized components of the Part 2 appendices that track its state
(#538). They are read-only runtime keys of 2.x stations only, never
persisted: `GetVariables` reads them, `SetVariables` answers `Rejected`
(B05.FR.09), `GetBaseReport` / `GetReport` list them (an `EVSE` or
`Connector` variable once per EVSE; a `GetReport` `componentVariable`
with an `evse` keeps that EVSE only, and its `connectorId` when given,
B08.FR.11), and a monitor watches them like any other variable. Removing
a connector removes its EVSE's keys and its `EVSE.Power` target; a
monitor on them stays installed but reports nothing (a periodic tick finds
no value).

| Variable                            | Value                                                      | Appendix |
| ----------------------------------- | ---------------------------------------------------------- | -------- |
| `EVSE.Power` (per EVSE)             | Active power in W, as a `Power.Active.Import` sample       | Required |
| `EVSE.AvailabilityState` (per EVSE) | The EVSE's connector status, as in StatusNotification      | Required |
| `Connector.AvailabilityState`       | The same, on connector 1 of the EVSE                       | Optional |
| `ChargingStation.AvailabilityState` | The station-level status (`Available` once the boot is in) | Required |

- The states are `ConnectorStatusEnumType` values (`Available`,
  `Occupied`, `Reserved`, `Unavailable`, `Faulted`), the `valuesList` of
  their `OptionList`. `EVSE.Power` is reported as a `decimal` in `W`, in
  whole watts; it has no `maxLimit`, since the station models no EVSE
  power rating.
- A value is refreshed on every connector event that can move it (status,
  meter tick, SoC, EV settings, charging profiles, transaction) and
  redefined only when it changes, so a monitor on it is evaluated on a
  change, never once per meter tick. A charging-profile period boundary
  shows at the next such event. Reading the power announces no schedule
  crossing.
- Energy is not published: the appendices' `Energy` variable is stored
  energy (a battery), not the energy register a meter value reports.

### Target attribute (2.1)

On a 2.1 station `EVSE.Power` also has a `Target` attribute (#538), the
value a TargetDelta monitor compares the power with. `SetVariables` with
`attributeType` `Target` sets it (a plain decimal such as `-2.5`; anything
else, `0x10`, `1e3`, `+5` or padded with spaces, is `Rejected`, B05.FR.07) and answers with that `attributeType` (B05.FR.03); `GetVariables`
reads it, an empty string until it is set (B06.FR.13). `GetBaseReport`
lists it as a `ReadWrite` attribute next to the `Actual` one. It is the
only variable with a target: a configuration variable's value is its
setting, with no goal distinct from it, while the power is a measurement
a CSMS can set a goal for. Every other variable, and every variable of a
2.0.1 station, answers `NotSupportedAttributeType` for `Target` (B05.FR.06,
B06.FR.08). Targets are kept in memory, not persisted.

## Monitor types

| Type                                       | Accepted on                    | Value rule                                                       |
| ------------------------------------------ | ------------------------------ | ---------------------------------------------------------------- |
| `UpperThreshold`, `LowerThreshold`         | integer variables              | Inside the configuration key's `min` / `max`, if any (N04.FR.06) |
| `Delta`                                    | every mapped variable          | Not negative (N04.FR.14); any value on a non-numeric variable    |
| `Periodic`, `PeriodicClockAligned`         | every mapped variable          | An interval in seconds, at least 1 (#538)                        |
| `TargetDelta`, `TargetDeltaRelative` (2.1) | variables with a `Target`      | Not negative (#538)                                              |
| `TargetDelta*` on a variable without one   | none: `UnsupportedMonitorType` | (N04.FR.05)                                                      |
| A threshold on a boolean / string / list   | none: `UnsupportedMonitorType` | (N04.FR.05)                                                      |

The 2.0.1 schema has no `TargetDelta` / `TargetDeltaRelative`: a 2.0.1
station refuses such a `SetVariableMonitoring` as malformed before any
result, as for any other value outside its schema. The minimum interval
and the non-negative target delta are simulator rules, not spec ones: N08
sets no lower bound (a zero interval would spin), and N07.FR.22 / FR.23
none on the deviation.

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
| `UnknownComponent`       | Component not in the device-model map, or an `evse` / `connectorId` the station does not have                              | N04.FR.03        |
| `UnknownVariable`        | Variable not in the map for that component                                                                                 | N04.FR.04        |
| `Rejected`               | Variable mapped to a configuration key the station does not have (the `GetVariables` answer), no `statusInfo`              | —                |
| `Rejected`               | `id` given and no monitor has it (`UnknownMonitorId`)                                                                      | N04.FR.13        |
| `Rejected`               | `id` given and its monitor is on another component/variable (`TargetMismatch`)                                             | N04.FR.16        |
| `Rejected`               | `id` given and its monitor is hardwired (`HardWiredMonitor`)                                                               | N04.FR.18        |
| `UnsupportedMonitorType` | Type not supported on this variable (table above)                                                                          | N04.FR.05        |
| `Rejected`               | Threshold outside the range (`ValueOutOfRange`), negative Delta (`NegativeDelta`), severity above 9 (`SeverityOutOfRange`) | N04.FR.06, FR.14 |
| `Rejected`               | Periodic interval under 1 s (`IntervalTooShort`), negative TargetDelta (`NegativeTargetDelta`)                             | —                |
| `Duplicate`              | Another monitor with the same type and severity on the same component/variable                                             | N04.FR.10        |
| `Accepted`               | Installed; the result carries the monitor `id`                                                                             | N04.FR.08        |

Every other `Rejected` result carries `statusInfo.reasonCode` (the name in
brackets) and an `additionalInfo` naming the requirement. Without an `id` the station
allocates one (N04.FR.11); ids increase from 1 and are not reused while the
station runs. With the `id` of an existing monitor on the same
component/variable, the monitor is replaced in place (N04.FR.12) and becomes
a custom monitor (N04.FR.15), a replaced preconfigured monitor included.
Allocated ids skip the ids of the station's own monitors (below).

## ClearVariableMonitoring

One `clearMonitoringResult` per `id`, in order (N06.FR.05): `Accepted` when
a monitor was removed (N06.FR.01), `NotFound` otherwise (N06.FR.02),
including an id repeated after its first clear. A hardwired monitor answers
`Rejected` and stays (N06.FR.03); a preconfigured one is removed like a
custom one, until `SetMonitoringBase` brings it back.

## GetMonitoringReport → NotifyMonitoringReport

| Request                                                | Response         | Requirement |
| ------------------------------------------------------ | ---------------- | ----------- |
| Selection matches no monitor (or no monitor installed) | `EmptyResultSet` | N02.FR.10   |
| Otherwise                                              | `Accepted`       | N02.FR.01   |

- `ThresholdMonitoring` selects Upper/Lower thresholds, `DeltaMonitoring`
  Delta monitors and `PeriodicMonitoring` Periodic / PeriodicClockAligned
  ones (N02.FR.12–FR.14, #538). Every criterion is supported, so
  `NotSupported` (N02.FR.02) never happens.
- TargetDelta monitors (2.1) are only reported by a request without
  `monitoringCriteria`: 2.1 N02.FR.23 names a `TargetDeltaMonitoring`
  criterion that the 2.1 `MonitoringCriterionEnumType` (schema and §3.67)
  does not have.
- `componentVariable` narrows the selection; a missing `variable`,
  `instance`, `evse` or `connectorId` matches every value (N02.FR.16–FR.21).
  With both filters, a monitor must pass both (N02.FR.05).
- After an `Accepted` response the station sends the report in one or
  more `NotifyMonitoringReport` parts, in order, each with the request's
  `requestId`, `seqNo` 0, 1, … and `tbc` true on every part but the last
  (N02.FR.03, FR.04, FR.09; see [Reports in parts](#reports-in-parts)).
  Monitors are grouped per component/variable in
  `monitor[].variableMonitoring[]`; a group is never split across parts.
- The station's own monitors are reported like the others, so a fresh
  station answers `Accepted` to a request without filter (N02.FR.11); its
  catalog holds Delta monitors only, so `ThresholdMonitoring` alone still
  answers `EmptyResultSet` there.
- On 2.1 each monitor also carries `eventNotificationType`
  (`CustomMonitor`, `PreconfiguredMonitor` or `HardWiredMonitor`), which
  2.1 requires (2.1 N02.FR.22) and the 2.0.1 schema forbids.

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
`--state-db` at start-up is not a change), when `SetMonitoringLevel` /
`SetMonitoringBase` changes `ActiveMonitoringLevel` / `ActiveMonitoringBase`
(#538), when a [runtime value](#runtime-values) or a
[target](#target-attribute-21) changes, and when the monitor is installed
or replaced. Periodic monitors ignore value changes: their timer fires
them (below).

| Type             | Fires when                                                                                      | `trigger`  | Requirement |
| ---------------- | ----------------------------------------------------------------------------------------------- | ---------- | ----------- |
| `UpperThreshold` | The value goes above the threshold (not on it); `cleared: true` when it comes back at or below  | `Alerting` | N07.FR.16   |
| `LowerThreshold` | The value goes below the threshold (not on it); `cleared: true` when it comes back at or above  | `Alerting` | N07.FR.17   |
| `Delta`, numeric | The value moved more than the step (strictly) from the baseline; the baseline becomes the value | `Delta`    | N07.FR.18   |
| `Delta`, other   | The value changed from the baseline, whatever the step (booleans, strings, lists)               | `Delta`    | N07.FR.19   |

The other types (#538):

| Type                        | Fires when                                                                             | `trigger`  | Requirement      |
| --------------------------- | -------------------------------------------------------------------------------------- | ---------- | ---------------- |
| `Periodic`                  | Every `value` seconds from the time the monitor was set (or Accepted after Pending)    | `Periodic` | N08.FR.05, FR.06 |
| `PeriodicClockAligned`      | On the clock grid of `value` seconds: 900 fires at :00, :15, :30, :45                  | `Periodic` | N08.FR.05, FR.07 |
| `TargetDelta` (2.1)         | \|Actual − Target\| goes above `value`; `cleared: true` when it comes back at or below | `Alerting` | 2.1 N07.FR.22    |
| `TargetDeltaRelative` (2.1) | \|Actual − Target\| goes above `value` × \|Target\|; `cleared: true` when back within  | `Alerting` | 2.1 N07.FR.23    |

- A periodic monitor reports the current value, whatever it is, in one
  `NotifyEvent` per tick (`seqNo` 0, N08.FR.04), filtered like any event
  by the level and the `transaction` flag. Its timer runs while reporting
  is on and while the station is offline, where a tick at or below
  `OfflineQueuingSeverity` is queued (N08.FR.03, [offline](#offline-queuing));
  it keeps its period across a reconnection. It stops on a boot not
  `Accepted` (`Pending`, `Rejected`), a clear, a replace by another type, a
  monitoring base that deletes it, and when the station is disposed, and
  restarts with no catch-up tick, a full interval later for a `Periodic`
  monitor. A replace restarts it from the replace. The clock grid is the one of
  `AlignedDataCtrlr.Interval` ([clock-aligned meter
  values](ocpp-versions-and-transports.md#clock-aligned-meter-values-clockaligneddatainterval)):
  UTC, restarting each midnight, so an interval that does not divide a day
  has a shorter last slot. An interval above a day (86400 s) would fire at
  every midnight, before `value` seconds have passed (N08.FR.07); it uses
  the grid of `value` seconds counted from 1970-01-01T00:00Z instead, so a
  whole number of days fires at UTC midnight every `value` / 86400 days,
  and a restart of the timer keeps that grid.
- A TargetDelta monitor follows the threshold rules (2.1 N07.FR.02, FR.11,
  FR.12, FR.14 name them together): one event per crossing, `cleared` on
  return, re-checked on replace and when reporting resumes, its triggered
  flag persisted. Without a target there is nothing to compare: the
  monitor keeps its state until one is set. TargetDeltaRelative measures
  the band on the target's magnitude, so a target of 0 leaves no band.

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
  `Accepted` boot; offline, the events at or below `OfflineQueuingSeverity`
  are queued instead ([offline](#offline-queuing)). Meanwhile a threshold
  that is not queued keeps the state the CSMS was last
  told and a Delta keeps its baseline; on `Accepted` every threshold is
  re-checked against the current value, so a crossing in between sends its
  trigger or `cleared` then (a Delta waits for the next change). A
  triggered threshold replaced in that window by the other threshold sends
  its owed `cleared` with the replacement's type and severity; replaced by
  a Delta, it never sends it.

### Offline queuing

OCPP 2.0.1 / 2.1 N07.FR.04 (and N08.FR.03 for periodic monitors): while
the station is offline, the `NotifyEvent` of a monitor whose severity is
equal to or lower than `MonitoringCtrlr.OfflineQueuingSeverity` is queued
and delivered once back online (#538).

- **Offline** means from a close (or before the first connection) until
  the next BootNotification `Accepted`, the window between the
  reconnection and the boot answer included: nothing goes out live there
  (B02.FR.02). A boot `Pending` or `Rejected` holds the events as before,
  without queuing them.
- **Queued** events are evaluated as if online and count as told: a
  threshold records its trigger, a Delta moves its baseline. The monitors
  above the severity are held (their evaluation is delayed, as the N07
  Remark suggests) and re-checked at the `Accepted` boot. The monitoring
  level and the `transaction` flag still apply. An event produced online
  that finds the socket already down is queued under the same rule, the
  others dropped.
- **Where**: the [E11 queue](ocpp-versions-and-transports.md#e11-offline-queue-for-transactionevent)
  (`pending_messages`, action `NotifyEvent`, with `--state-db`), one row
  per report, in production order among the queued TransactionEvents. A
  restart with state persistence still delivers them.
- **Cap**: at most 1000 `NotifyEvent` reports per charge point
  (`MAX_QUEUED_NOTIFY_EVENTS`), so a `Periodic` monitor ticking through a
  long outage cannot grow the queue without bound. A report queued at the
  cap drops the oldest queued report; a TransactionEvent row is never
  dropped nor counted. The first drop of an outage logs a `warn` (category
  `OCPP`), and the replay after the next `Accepted` boot logs one more with
  the number of reports dropped. Periodic ticks are not coalesced.
- **Replay**: after the `Accepted` boot (after the post-boot
  StatusNotifications), in queue order, each report cut into parts then
  (`seqNo` from 0, `tbc`). `NotifyEventRequest` has no `offline` field, so
  nothing marks a replayed event. The re-check of the `Accepted` boot runs
  after the replay and reports only the held monitors: an event queued
  offline is never sent twice. A queued report stores the 2.1 fields;
  2.0.1 drops `severity`, so a `cp.update` between versions still replays
  a valid payload.
- **No hostage**: queued `NotifyEvent`s alone never make a live
  TransactionEvent wait; only queued TransactionEvents do (#528). The
  queue stays FIFO: a `NotifyEvent` replay the socket refuses stays at
  the head and delays the TransactionEvents queued behind it until the
  next `Accepted` boot, as a refused TransactionEvent would.

`OfflineQueuingSeverity` is a persisted 2.x key, `ReadWrite`, 0-9
(`SetVariables` outside the range is `Rejected`), default `0`: only
Emergency events are queued until the CSMS raises it. The spec gives no
default: the station queues "When set" (2.0.1 §2.11.7, 2.1 §2.13.7), so
an unset variable would queue nothing. The simulator always sets it,
because a configuration key here always has a value (an integer key
cannot be left unset, and `GetVariables` would have no value to read);
`0` is the setting closest to unset that still keeps the most severe
events across an outage. The consequence: 0 is the floor of the range,
so the CSMS can narrow queuing to Emergency events but never turn it off.

The events of one value change (or one install, or one `Accepted` boot) are
**one report**, sent after the answer to the message that caused them: one
`NotifyEvent` part per 100 events (in practice one), sharing `generatedAt`,
with `seqNo` from 0 (N07.FR.07) and `tbc` true on every part but the last,
and one `eventData` per monitor, by increasing monitor id:

- `eventId` (increasing per station from 1, restarting at 1 after a
  restart), `timestamp`, `trigger`, `actualValue` as `GetVariables` renders
  it (empty for a write-only value, N07.FR.10), `cleared` only when true;
- `component` (with its `evse`, if any), `variable` and
  `variableMonitoringId` of the monitor (N07.FR.06), and
  `eventNotificationType`, the monitor's origin (`CustomMonitor`,
  `PreconfiguredMonitor` or `HardWiredMonitor`);
- `transactionId` when the event is linked to a transaction (#538): the
  transaction running on the monitor's EVSE, or, for a monitor without
  EVSE that reports only during a transaction (`transaction: true`), the
  transaction when exactly one runs on the station; absent otherwise;
- on 2.1 only, the monitor's `severity` (2.1 N07.FR.20); the 2.0.1 schema
  does not allow the field.

## The station's own monitors

Next to the custom monitors, a 2.x station ships **hardwired** and
**preconfigured** monitors (#538), from the static catalog in
[`monitorCatalog.ts`](../../src/cp/domain/monitoring/monitorCatalog.ts).
N03 leaves their content to the manufacturer; these three watch the
read-only `MonitoringCtrlr` limits, which never change, so they appear in
reports and obey the rules below without ever sending a `NotifyEvent` of
their own:

| Id      | Origin                 | Type  | Severity | Variable                                                   |
| ------- | ---------------------- | ----- | -------- | ---------------------------------------------------------- |
| 1000001 | `HardWiredMonitor`     | Delta | 2        | `MonitoringCtrlr.ItemsPerMessage[SetVariableMonitoring]`   |
| 1000002 | `PreconfiguredMonitor` | Delta | 5        | `MonitoringCtrlr.BytesPerMessage[SetVariableMonitoring]`   |
| 1000003 | `PreconfiguredMonitor` | Delta | 8        | `MonitoringCtrlr.ItemsPerMessage[ClearVariableMonitoring]` |

- A hardwired monitor cannot be cleared (N06.FR.03) or replaced
  (N04.FR.18) and survives every monitoring base (N03.FR.05).
- A preconfigured monitor can be cleared, and replaced by id: the
  replacement keeps the id and becomes a custom monitor (N04.FR.12, FR.15).
- Custom ids start at 1 and skip the catalog's ids, even those of monitors
  currently deleted, so `FactoryDefault` always restores a preconfigured
  monitor under its original id.

## SetMonitoringBase

Every base answers `Accepted` (N03.FR.01). `NotSupported` (N03.FR.02) never
happens: the schema admits no other value.

| `monitoringBase` | Custom monitors                          | Preconfigured monitors            | Requirement |
| ---------------- | ---------------------------------------- | --------------------------------- | ----------- |
| `All`            | Kept, replaced preconfigured ones too    | The missing ones are re-activated | N03.FR.03   |
| `FactoryDefault` | Deleted, replaced preconfigured ones too | All active again, original ids    | N03.FR.04   |
| `HardWiredOnly`  | Deleted                                  | Deleted                           | N03.FR.05   |

The hardwired monitors stay under every base. Deleted monitors send no
`NotifyEvent` (N07.FR.12) and their rows leave the state database; a
re-activated preconfigured monitor is evaluated like a newly set one. The
base in force is `MonitoringCtrlr.ActiveMonitoringBase` (below), `All`
until a `SetMonitoringBase`.

A re-activation can leave two monitors of the same type and severity on
one variable. After `HardWiredOnly`, a custom monitor set on a
preconfigured monitor's variable, type and severity is no `Duplicate`
(N04.FR.10): the preconfigured one is gone. `All` then re-activates the
preconfigured monitor next to it, as N03.FR.03 requires ("activate all
preconfigured monitoring", custom monitors left intact); N04.FR.10 governs
a `SetVariableMonitoringRequest`, not a restore, so the station keeps
both. `FactoryDefault` deletes the custom one instead.

## MonitoringCtrlr variables

The 2.x device model has these `MonitoringCtrlr` variables (#538; 2.0.1
Part 2 §2.11, 2.1 Part 2 §2.13), all `ReadOnly`: `SetVariables` answers
`Rejected`. They are runtime keys of the 2.x station only, never persisted,
so a 1.6 `GetConfiguration` does not list them. `OfflineQueuingSeverity`
(§2.11.7, 2.1 §2.13.7) is the exception: `ReadWrite` and persisted, see
[offline queuing](#offline-queuing).

| Variable                                   | Value                                                     | Spec                |
| ------------------------------------------ | --------------------------------------------------------- | ------------------- |
| `ItemsPerMessage[SetVariableMonitoring]`   | 100                                                       | Required; N04.FR.09 |
| `BytesPerMessage[SetVariableMonitoring]`   | 65536                                                     | Required; N04.FR.09 |
| `ItemsPerMessage[ClearVariableMonitoring]` | 100                                                       | Optional; N06.FR.04 |
| `BytesPerMessage[ClearVariableMonitoring]` | 65536                                                     | Optional; N06.FR.04 |
| `ActiveMonitoringLevel`                    | The level, 0-9 (`minLimit` / `maxLimit` published)        | Optional            |
| `ActiveMonitoringBase`                     | `All`, `FactoryDefault` or `HardWiredOnly` (`OptionList`) | Optional            |

The instances are `variableInstance` values: `ItemsPerMessage` without an
instance is `UnknownVariable`. The four limits bound what the CSMS sends in
one request (N04.FR.09, N06.FR.04); a larger request is still served, since
refusing it with a CALLERROR is optional (N06.FR.06, FR.07). They do not
size the station's own reports. `ActiveMonitoringLevel` and
`ActiveMonitoringBase` follow `SetMonitoringLevel` and `SetMonitoringBase`,
so a monitor on them reports those changes.

`GetBaseReport` / `GetReport` publish `variableCharacteristics.minLimit` /
`maxLimit` for every integer variable with bounds (#538), the range outside
which a threshold is `ValueOutOfRange` (N04.FR.06), and report a string
limited to a few values as `OptionList` with its `valuesList`.

## Reports in parts

`NotifyMonitoringReport` and `NotifyEvent` are reports in parts (N02.FR.03,
FR.09; N07.FR.07). No configuration variable sizes these parts: the
`ItemsPerMessage` / `BytesPerMessage` instances above bound the CSMS's
requests, not the station's reports. The station puts at most 100 items
(monitor groups, eventData) in a part
([`reportParts.ts`](../../src/cp/infrastructure/transport/v201/reportParts.ts)),
which keeps every report it realistically builds in one part (`seqNo` 0,
`tbc` false); a longer one is split, the parts sent in order.

## Persistence

With `--state-db` (or the browser's database), the installed monitors are
stored in the `variable_monitors` table (schema v21, see
[State persistence](state-persistence.md)) and restored when the station is
created again: monitors survive a reboot (N04 remarks, N07.FR.13). The
station's own monitors are stored too (#538), and the row with id 0 holds
the monitoring base last set, so a preconfigured monitor deleted by
`HardWiredOnly` or `ClearVariableMonitoring` stays deleted after a restart.
A database without that row (a first start, or one written before #538)
gets the hardwired and preconfigured monitors, its custom monitors keeping
their ids; the hardwired monitors always come from the catalog, and a
stored hardwired monitor the catalog no longer has is ignored and its row
deleted, so no undeletable monitor comes back from an older build. Ids
resume after the highest restored one, so a CSMS that sends
`GetMonitoringReport` after the reboot (N04.FR.19) sees the same ids. The
triggered flag of a threshold monitor (as last reported) is stored too, so
a value that returns within range after the reboot still sends
`cleared: true` (N07.FR.14), at the first `Accepted` boot when the value
is already back in range at start-up. A Delta baseline restarts at the
restored value. Every monitor type is stored and restored (#538): a
periodic monitor's timer starts with the station (offline until the first
`Accepted` boot, [offline](#offline-queuing)), and a
TargetDelta keeps its triggered flag (2.1 N07.FR.14), but the
[target](#target-attribute-21) itself is not stored, so its `cleared`
waits until the CSMS sets a target again. The monitoring level is not
stored (above).

## Limits

- **Offline.** Events above `OfflineQueuingSeverity` are not queued:
  threshold and TargetDelta crossings are reported by the re-check at the
  next `Accepted` boot, Delta and periodic events are lost, and a
  triggered-then-cleared threshold stays invisible (the N07 Remark). A
  replayed `NotifyEvent` written, or still in the network-sim pipeline,
  when the connection drops again is not queued again. A replay refused by
  the socket stays at the head of the queue until the next `Accepted`
  boot, while live `NotifyEvent`s go out directly; a refusal after the
  first part loses the rest of that report. Past 1000 queued reports the
  oldest are dropped ([cap](#offline-queuing)).
- **Value sources.** Events follow a CSMS `SetVariables` /
  `SetVariableMonitoring`, `SetMonitoringLevel` / `SetMonitoringBase` (on
  the `MonitoringCtrlr` variables), a scenario `configSet` node, a change
  of a runtime value or target, a periodic tick, or the re-check of an
  `Accepted` boot. A `SetVariables` that changes several values sends one
  `NotifyEvent` per value change, not one per request.
- **EVSE scope.** The configuration variables are station-wide values: a
  monitor on one with an `evse` watches the same value as one without, and
  differs only in its target (`Duplicate`, `TargetMismatch` and the report
  grouping compare `evse` and `instance`) and in the transaction its
  events name. The `EVSE` / `Connector` runtime values are per EVSE.
- **Runtime values.** Only those of the [table](#runtime-values); no
  current, voltage or energy variable, and `EVSE.Power` has no `maxLimit`.
  2.1-only appendix variables (`EVSE.ChargingState`,
  `ActiveTransactionId`) are not published.
- **MonitoringCtrlr.** `Enabled` and `Available` (both optional) are not
  mapped. The request limits are advertised, not
  enforced (above).
- **Event fields.** No `cause` (N07.FR.05, a MAY): every event follows a
  change of its own variable, so no event causes another. No `techCode` /
  `techInfo`.

## Issue #538 items

Each item of #538, implemented or declined, with its requirement ids
(OCPP 2.0.1 / 2.1 Part 2 unless marked 2.1).

| Item                                                                | Status                                                           | Requirement                         |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------- |
| Hardwired and preconfigured monitor catalogs                        | Implemented ([own monitors](#the-stations-own-monitors))         | N04.FR.15, FR.18; N06.FR.03         |
| Complete `SetMonitoringBase`                                        | Implemented ([SetMonitoringBase](#setmonitoringbase))            | N03.FR.01–FR.05                     |
| `Periodic` / `PeriodicClockAligned` monitors                        | Implemented ([evaluation](#evaluation-and-notifyevent))          | N08.FR.04–FR.07; N02.FR.14          |
| `TargetDelta` / `TargetDeltaRelative` (2.1)                         | Implemented, on `EVSE.Power` ([target](#target-attribute-21))    | 2.1 N07.FR.22, FR.23                |
| `TargetDeltaMonitoring` report criterion (2.1)                      | Not applicable: absent from the 2.1 schema                       | 2.1 N02.FR.23                       |
| Offline `NotifyEvent` queuing per `OfflineQueuingSeverity`          | Implemented ([offline](#offline-queuing))                        | N07.FR.04; N08.FR.03                |
| `MonitoringCtrlr` `ItemsPerMessage`, `BytesPerMessage` (instances)  | Implemented ([MonitoringCtrlr](#monitoringctrlr-variables))      | N04.FR.09; N06.FR.04                |
| `MonitoringCtrlr.ActiveMonitoringLevel`                             | Implemented                                                      | §2.11 (2.1 §2.13)                   |
| `NotifyEvent` / `NotifyMonitoringReport` in parts (`seqNo` / `tbc`) | Implemented ([parts](#reports-in-parts))                         | N02.FR.03, FR.04, FR.09; N07.FR.07  |
| `transactionId` and the EVSE scope in `eventData`                   | Implemented ([events](#evaluation-and-notifyevent))              | —                                   |
| `cause` in `eventData`                                              | Declined: a MAY, and no event of the simulator causes another    | N07.FR.05                           |
| Resolve `evse` / `instance` of a monitored variable                 | Implemented ([device model](#the-device-model-behind-a-monitor)) | N04.FR.03, FR.04                    |
| `minLimit` / `maxLimit` in `GetBaseReport`                          | Implemented ([MonitoringCtrlr](#monitoringctrlr-variables))      | N04.FR.06                           |
| Monitor runtime values                                              | Implemented ([runtime values](#runtime-values))                  | Appendices, standardized components |
