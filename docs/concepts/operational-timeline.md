---
title: Operational timeline
type: concept
summary: Per-charge-point, in-memory projection of domain events (connection, injected network faults and their recovery, status changes, transactions and their rejected or discarded 2.x TransactionEvents, authorization rejections, scenario runs, smart-charging profiles applied / cleared / expired) with stable snake_case kinds, a monotonic `seq`, and incident / run correlation — read with `timeline.get`, the `get_timeline` MCP tool or the console's Operational events tab.
sources:
  - src/cp/application/services/OperationalTimeline.ts
  - src/cp/application/services/OperationalTimelineProjector.ts
  - src/cli/service.ts (recordScenarioOnTimeline)
  - src/protocol/methods.ts (timeline.get)
  - src/cp/domain/charge-point/ChargePoint.ts (applyChargingProfile, clearChargingProfiles)
  - "issue #448"
  - "issue #469"
  - "issue #490"
  - "issue #527"
related:
  - control-plane.md
  - network-simulation.md
  - log-format.md
  - ../entities/web-console.md
  - ../entities/mcp-endpoint.md
  - charging-sessions.md
  - local-authorization.md
  - ocpp-versions-and-transports.md
updated: 2026-10-30
---

# Operational timeline

Reconstructing an incident from the raw [log](log-format.md), the
[network-simulation](network-simulation.md) log lines, the state history and
the scenario run history means correlating several views by hand. The
operational timeline ([#448](https://github.com/shiv3/ocpp-cp-simulator/issues/448))
is one additional, normalized view of what happened to a charge point:

```text
15:21:42.000  network_fault_injected   Network fault injected by rule cut (manual-disconnect, reconnect blocked 40 s)
15:21:42.001  connector_status   1     Connector 1 Available → Unavailable
15:21:42.001  status_change            Charge point Available → Unavailable
15:21:42.001  disconnected             Disconnected (code 1000)
15:21:42.001  reconnecting             Reconnect attempt 1 in 40 s
15:22:22.002  connected                Connected
15:22:22.003  boot_notification        BootNotification Accepted
15:22:22.003  status_change            Charge point Unavailable → Available
15:22:23.004  connector_status   1     Connector 1 Unavailable → Available
15:22:23.004  recovery_completed       Recovered in 41.0 s after rule cut
```

It is an observability and debugging feature, not an alarm-management
subsystem: there is no acknowledgement, assignment or ticketing. Raw logs and
OCPP frames are unchanged; scenario runs are linked by `runId`, never copied.
The timeline records each transaction event as it happens; the
[charging-session history](charging-sessions.md) (#447) is the per-transaction
summary — duration, energy, stop reason, outcome — and, unlike the timeline,
is persisted with `--state-db`.

## Where it lives

Every charge point owns its timeline (`ChargePoint.timeline`), fed by a
projector subscribed to the charge point's domain events. It therefore works
the same in the [daemon](../entities/daemon.md) and in browser
[Local mode](local-vs-remote-mode.md), and disappears with the charge point:
`cp.delete` and `state.reset` (which removes every charge point) drop it, and
so does `cp.update` on the daemon, which rebuilds the charge point from its new
configuration — the edited charge point starts an empty timeline. Editing a
charge point in Local mode keeps it.

- **Retention:** in memory only, the newest **1000** entries per charge point;
  older entries are evicted. `--state-db` does not persist it, so a daemon
  restart starts an empty timeline.
- **Ordering:** by `seq`, a per-charge-point counter that strictly increases
  and is never reused (evicted entries leave a gap at the start). Several
  entries can share a millisecond `timestamp`; never sort by it.

## Entry shape

| Field         | Type                 | Notes                                                                      |
| ------------- | -------------------- | -------------------------------------------------------------------------- |
| `seq`         | positive integer     | Ordering contract (see above).                                             |
| `timestamp`   | ISO 8601 string, UTC | When the entry was recorded.                                               |
| `kind`        | string               | One of the kinds below.                                                    |
| `cpId`        | string               | The charge point.                                                          |
| `connectorId` | integer, optional    | Set on connector-scoped entries; absent on charge-point-wide ones.         |
| `runId`       | string, optional     | Scenario run the entry is attributed to (see [Correlation](#correlation)). |
| `incidentId`  | string, optional     | Network-fault incident the entry belongs to.                               |
| `summary`     | string               | Human-readable; not a contract, may change wording.                        |
| `data`        | object               | Kind-specific, machine-readable fields (table below).                      |

`timeline.get` answers `{ version, entries, total }`. The format version is
**`1.3`**, following the [trace format](trace-format.md#versioning) rules: an
additive change (a new kind, a new `data` field) bumps the minor version, and
consumers must ignore kinds and fields they do not know. `1.1` added the three
`charging_profile_*` kinds (#469). `1.2` added `transaction_message_rejected` and
`transaction_message_discarded` (#490). `1.3` added their `action` and `reason`
fields, and made `errorCode` conditional (#527, #529).

## Kinds

Names reuse the [CLI event](../entities/cli.md#events) names where both exist.

| Kind                            | Scope     | `data`                                                               | Recorded when                                                                                                           |
| ------------------------------- | --------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `connected`                     | CP        | —                                                                    | The socket opens (SOAP: on connect).                                                                                    |
| `disconnected`                  | CP        | `code`, `reason`                                                     | The socket closes, after the charge point's own teardown.                                                               |
| `reconnecting`                  | CP        | `attempt`, `delayMs`                                                 | The transport schedules a reconnect after an unrequested close.                                                         |
| `boot_notification`             | CP        | `status`, `interval`                                                 | A BootNotification.conf is processed, whatever its status.                                                              |
| `status_change`                 | CP        | `from`, `to`                                                         | The charge point status changes; repeats of the same status are skipped.                                                |
| `connector_status`              | connector | `from`, `to`                                                         | A connector status changes; repeats are skipped.                                                                        |
| `network_fault_injected`        | CP        | `ruleId`, `ruleType`, `reconnectDelayMs`                             | A `manual-disconnect` or `periodic-disconnect` rule fires, before the socket closes. Opens an incident.                 |
| `recovery_completed`            | CP        | `durationMs`, `ruleId`, `restored`, `unrestored` (when not restored) | The open incident's recovery condition holds, or its settle window runs out. Closes it.                                 |
| `transaction_started`           | connector | `tagId`, `transactionId` (2.x only)                                  | A transaction starts. OCPP 2.x carries the CP-minted id; 1.6 has no id yet.                                             |
| `transaction_id_assigned`       | connector | `transactionId`                                                      | (1.6) StartTransaction.conf assigns the id, whatever its value.                                                         |
| `transaction_stopped`           | connector | `transactionId`, `reason` (optional)                                 | A transaction stops; `reason` is the stop reason when one was given.                                                    |
| `transaction_rejected`          | connector | `status`, `stopped`                                                  | A 1.6 StartTransaction.conf or (#447) 2.x TransactionEvent.conf carries a non-Accepted id status; `stopped`: see below. |
| `transaction_message_rejected`  | connector | message fields (see below), `attempt`                                | (2.x #490, #529; 1.6 #527) A transaction message transmission fails; it is resent unless it was the last.               |
| `transaction_message_discarded` | connector | message fields (see below), `attempts`                               | (2.x #490, #529; 1.6 #527) The last attempt failed too: the message is dropped, the transaction keeps running.          |
| `authorization_rejected`        | CP        | `tagId`, `status`                                                    | An Authorize.conf is not Accepted (a CALLERROR counts as `Invalid`). Accepted answers are not recorded.                 |
| `scenario_started`              | connector | `scenarioId`                                                         | (daemon) A scenario run starts.                                                                                         |
| `scenario_wait_changed`         | connector | `scenarioId`, `nodeId`, `kind`                                       | (daemon) An operator extends, retries or continues a parked wait.                                                       |
| `scenario_error`                | connector | `scenarioId`, `error` (redacted)                                     | (daemon) A scenario run reports an error.                                                                               |
| `scenario_finished`             | connector | `verdict`, `stopped`, `executionState`                               | (daemon) A scenario run ends — completed, failed or stopped by an operator — with its run-history verdict.              |
| `charging_profile_applied`      | either    | profile fields, `source`, `replaced`                                 | A SetChargingProfile is accepted; an update of the same id is one entry with `replaced: true`.                          |
| `charging_profile_cleared`      | either    | `connectorId`, `reason`, `profiles`                                  | At least one profile is removed from one scope (see [Smart-charging profiles](#smart-charging-profiles)).               |
| `charging_profile_expired`      | either    | profile fields                                                       | A profile's `validTo` passes while it is still installed.                                                               |

The 1.6 placeholder transaction id (`0` until StartTransaction.conf) is never
recorded: `transaction_started` has no id on 1.6, and
`transaction_id_assigned` reports the CSMS's id. A disconnect never records a
"transaction interrupted" entry: a 1.6 transaction can legitimately continue
offline.

`transaction_rejected.stopped` says whether the station ended the transaction
on the rejection: `StopTransactionOnInvalidId` on 1.6 (#181),
`TxCtrlr/StopTxOnInvalidId` (default true) on 2.x. Before #447 a non-Accepted
2.x `idTokenInfo` was ignored and recorded nothing; it is checked only while
the transaction runs (not on an `Ended` event's answer).

The message fields of `transaction_message_rejected` and
`transaction_message_discarded` are `transactionId`, `action`
(`TransactionEvent` on 2.x; `StartTransaction`, `StopTransaction` or
`MeterValues` on 1.6, #527), `eventType` (2.x only: `Started`, `Updated` or
`Ended`), `reason` and `errorCode`. `reason` is `callError` when a CALLERROR
answered the transmission (#490, #527), and then `errorCode` holds its error
code; it is `timeout` when no answer came within
`OCPPCommCtrlr.MessageTimeout` (#529, 2.x only), and then there is no
`errorCode`. On `transaction_message_discarded` they describe the last
failure. See
[Transaction message retries (2.x)](ocpp-versions-and-transports.md#transaction-message-retries-ocpp-2x)
and [(OCPP-J 1.6)](ocpp-versions-and-transports.md#transaction-message-retries-ocpp-j-16).

### Smart-charging profiles

The three `charging_profile_*` kinds (#469) are recorded on OCPP 1.6 and 2.x
alike, for connector profiles and for station-wide ones (1.6 `connectorId` 0,
2.x `evseId` 0).

- **Scope.** A connector profile's entry carries the entry-level
  `connectorId`; a station-wide profile's entry has none, like any
  charge-point-wide entry, so the `connectorId` filter never returns it.
  `data.connectorId` is always set, `0` for station-wide.
- **Profile fields** are `connectorId`, `profileId`, `purpose`, `stackLevel`
  and `validTo` (only when the profile has one). `purpose` uses the 1.6 names
  on every version: a 2.x `ChargingStationMaxProfile` reads
  `ChargePointMaxProfile`.
- **`source`** is `SetChargingProfile`: profiles sent with a remote start are
  ignored, and restored ones are not recorded (see [Limits](#limits)).
- **`charging_profile_cleared`** is recorded once per scope that lost a
  profile — a clear without a target can record a station entry and one per
  connector — and never for a clear that matched nothing (1.6 still answers
  `Accepted`, 2.x `Unknown`). `profiles` holds one
  `{ profileId, purpose, stackLevel }` per removed profile; `reason` is one
  of:
  - `ClearChargingProfile` — the CSMS cleared it;
  - `TransactionEnded` — a TxProfile, removed when its transaction stops,
    right after `transaction_stopped`; TxDefault and max profiles stay;
  - `ConnectionClosed` — station-wide profiles, which the charge point drops
    when its connection closes (before `disconnected`); connector profiles
    are kept;
  - `ConnectorRemoved` — every profile of a connector being removed.
- **Expiry.** The simulator ignores a profile past its `validTo` but never
  removes it, so `charging_profile_expired` reports the moment it stops
  applying. A profile installed with a `validTo` already past records it
  right after `charging_profile_applied`. An expired profile is still
  installed: a `charging_profile_cleared` naming it can follow. Clearing or
  updating a profile cancels its pending expiry.

## Correlation

**Incidents.** `network_fault_injected` opens an incident with a fresh
`incidentId`, and records the status every connector had at that moment.
Every entry recorded while the incident is open — scenario entries included —
carries its `incidentId`. The incident closes with `recovery_completed`, whose
`durationMs` runs from the injection, as soon as all of these hold:

1. the socket is connected again,
2. the CSMS accepted a BootNotification on that connection, and
3. every connector is back to the status it had when the fault fired
   (a connector removed since is ignored).

It then reads `restored: true`. A connector status may legitimately not come
back (a connector that was `Preparing` before the fault and comes back
`Available`, one with auto-reset off left `Unavailable`, a transaction that
ended offline), so once conditions 1 and 2 hold the incident waits at most 60 s
for condition 3. Past that it closes anyway with `restored: false` and
`unrestored`, one `{ connectorId, expected, actual }` per connector still off;
`durationMs` then runs to that moment.

A disconnect during the incident resets conditions 1 and 2, and the 60 s
window with them. A fault firing while an incident is still open starts a new
incident; the replaced one never gets a `recovery_completed`.

**Scenario runs.** Run ids are minted by the daemon service, so scenario
entries and run attribution exist in the daemon only; Local mode records no
`scenario_*` entries and no `runId`. Every `scenario_*` entry carries
`scenarioId` in `data`; `scenario_finished` is recorded once per run, when its
report is computed, so a stopped run reads `stopped: true` rather than as a
completed one. Between a run's `scenario_started` and its
end, connector-scoped entries on its connector carry its `runId`. When two
runs are in progress on one connector (one parked on a trigger, one driven),
entries go to the most recently started one. The full run report stays in the
[run history](control-plane.md#scenario-run-history), reachable by `runId`.

## Reading it

- **Control plane:** [`timeline.get`](control-plane.md) — filters
  `connectorId`, `runId`, `incidentId`, `kinds`; windowing like `logs.get`
  (`limit` takes the newest N matching entries, `offset` pages backwards,
  `order` is `"asc"` by default). An unknown `cpId` answers `not_found`; an
  unknown kind `invalid_params`.
- **MCP:** the curated [`get_timeline`](../entities/mcp-endpoint.md) tool.
- **Push:** every entry is also pushed to subscribers of the charge point as a
  [`timeline_entry`](../entities/cli.md#events) event (in Local mode, a
  `timeline-entry` event of the browser service). `seq` grows by one per entry,
  so a client that sees a gap missed entries and reads `timeline.get` again.
- **Console:** the charge point page's
  [Operational events](../entities/web-console.md#operational-events-tab) tab.

## Limits

- A charging profile sent inside RemoteStartTransaction / RequestStartTransaction
  is ignored by the simulator, so it never reaches the timeline.
- A schedule period switching between a zero and a non-zero limit is not an
  entry; during a transaction its effect shows as the `connector_status`
  change between `Charging` and `SuspendedEVSE`.
- Profiles that Local mode restores from its database when it recreates a
  charge point are not recorded, and their expiry is not either: restoring
  state is not a change.
- An injected latency rule is not an incident: only disconnect rules are.
