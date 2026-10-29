---
title: Charging sessions
type: concept
summary: Version-independent read model of the transactions a charge point ran (OCPP 1.6 StartTransaction/StopTransaction and 2.x TransactionEvent map onto one ChargingSession), with derived duration and energy, the stop reason as sent, an outcome (active, completed, interrupted, failed), persistence in `charging_sessions` and restart reconciliation — read with `sessions.list`, the `list_charging_sessions` MCP tool or the console's Transactions tab.
sources:
  - src/cp/domain/session/ChargingSession.ts
  - src/cp/application/services/ChargingSessionRecorder.ts
  - src/cp/domain/persistence/ChargingSessionRepository.ts
  - src/cp/domain/persistence/SqliteChargingSessionRepository.ts
  - src/protocol/methods.ts (sessions.list)
  - "issue #447"
  - "issue #491"
  - "issue #488"
  - src/cp/domain/charge-point/ChargePoint.ts (evDisconnected)
related:
  - operational-timeline.md
  - state-persistence.md
  - control-plane.md
  - ocpp-versions-and-transports.md
  - ../entities/mcp-endpoint.md
  - ../entities/web-console.md
  - ../entities/cli.md
  - local-vs-remote-mode.md
updated: 2026-10-29
---

# Charging sessions

The [log](log-format.md) and the [operational timeline](operational-timeline.md)
show what happened on the wire and to the charge point, but neither answers
"which sessions ran, for how long, how much energy, how did each end?". OCPP
spells a session differently per version:

```text
OCPP 1.6:  StartTransaction → MeterValues → StopTransaction
OCPP 2.x:  TransactionEvent Started → Updated → Ended
```

The charging-session history ([#447](https://github.com/shiv3/ocpp-cp-simulator/issues/447))
is one normalized record per transaction, whatever version carried it. It is a
**read model** of what the charge point did, not a CSMS transaction database:
it has no tariff, price or billing field, and never will.

## The model

| Field                         | Meaning                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `sessionId`                   | The session's own id (a UUID). Never a transaction id — see below.                                         |
| `cpId`, `connectorId`         | Where it ran.                                                                                              |
| `evseId`                      | OCPP 2.x EVSE id (the simulator gives each connector its own EVSE); `null` for 1.x.                        |
| `ocppVersion`                 | The charge point's version, e.g. `OCPP-1.6J`, `OCPP-2.0.1`.                                                |
| `transactionId`               | 1.6: the CSMS-assigned integer, as a string. 2.x: the station-minted id. `null` until known.               |
| `idTag`                       | The idTag / idToken the transaction started with, or `null`.                                               |
| `startedAt`, `endedAt`        | ISO 8601. `endedAt` is `null` while active, and when the end was never observed.                           |
| `durationMs`                  | `endedAt − startedAt`; `null` when either is unknown.                                                      |
| `meterStartWh`, `meterStopWh` | The connector's energy register at start and end; `meterStopWh` is `null` when the end was never observed. |
| `energyWh`                    | `meterStopWh − meterStartWh`; `null` when the end is unknown or the register went backwards.               |
| `stopReason`                  | As sent: the 1.6 StopTransaction `reason` (`Local` when omitted), or the 2.x `stoppedReason`.              |
| `triggerReason`               | 2.x Ended-event `triggerReason`; `null` for 1.x.                                                           |
| `authorizationStatus`         | The last id status the CSMS answered other than `Accepted`, or `null`.                                     |
| `outcome`                     | `active`, `completed`, `interrupted` or `failed` (below).                                                  |

**Transaction ids.** 1.6 sends StartTransaction with no id and learns the
CSMS's integer from the conf; until then the domain holds a `0` placeholder,
and a start that times out never gets one. 2.x mints the id itself, at the
first TransactionEvent. A session is therefore keyed by its own `sessionId`,
and `transactionId` fills in when it is known.

**Energy.** Derived from the simulator's own energy register (`meterValue` of
the connector, in Wh), read when the transaction starts and stops. It does not
depend on MeterValues frames having been sent or answered, so it is known for
every session whose end was observed, and `null` otherwise — never estimated.

## Outcomes

`classifyEndedSession` decides the outcome of an ended session from the stop
cause the domain recorded (the 2.x `stoppedReason` when one was named, else
the 1.6 reason; not the wire value, which folds `UnlockCommand` into `Other`
for 2.x):

| Outcome       | When                                                                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `active`      | The transaction is still running.                                                                                                                                                                                                                                  |
| `failed`      | The CSMS refused the start: a CALLERROR answered 1.6 StartTransaction, or the CSMS did not accept the id on the start and the station stopped on it (`DeAuthorized`, see below). An id a 2.x `Updated` answer withdraws mid-session ends it `interrupted`.         |
| `interrupted` | It ended with `EmergencyStop`, `HardReset`, `SoftReset`, `ImmediateReset`, `Reboot`, `PowerLoss`, `UnlockCommand`, `GroundFault`, `OvercurrentFault`, `PowerQuality`, `Timeout`, or `DeAuthorized` without a CSMS rejection; or its end was lost across a restart. |
| `completed`   | Any other end: `Local`, `Remote`, `EVDisconnected`, `Other`, `EnergyLimitReached`, `SOCLimitReached`, `StoppedByEV`, …                                                                                                                                             |

A rejected id the station kept charging on (`StopTransactionOnInvalidId` /
`TxCtrlr/StopTxOnInvalidId` false) still ends `completed`; its
`authorizationStatus` keeps the CSMS's answer.

### Rejections and failed starts (#447)

Two domain gaps were closed so these outcomes can be told apart:

- **1.6 StartTransaction CALLERROR.** The station already closed the
  transaction (stop time and meter stamped) and went back to Available; it
  now also emits `transactionStartFailed`, once the transaction is closed and
  before Available. No StopTransaction.req follows. Once the listeners have
  read it, the closed transaction is detached from the connector (#491). A
  later Reset or UnlockConnector finds no transaction there and sends no
  StopTransaction.req for it (one used to go out with the placeholder
  `transactionId: 0`); a RemoteStopTransaction for id `0` is `Rejected`, and
  ChangeAvailability is `Accepted` at once rather than `Scheduled`.
  `ChargePoint.stopTransaction` also ignores a transaction whose stop time is
  already set, such as one restored from a `connector_runtime` snapshot
  persisted before this fix.
- **2.x `idTokenInfo`.** TransactionEvent.conf `idTokenInfo` used to be
  ignored. A status other than `Accepted` for a running transaction now
  mirrors 1.6 (#181): with `TxCtrlr/StopTxOnInvalidId` (default true) the
  station ends it with `triggerReason: Deauthorized` and
  `stoppedReason: DeAuthorized`; with it false the transaction keeps running.
  Either way `startTransactionNotAccepted` reports it.

In both versions the CSMS's answer is written to the transaction
(`Transaction.authorizationStatus`, persisted with it) before the station
stops on it, so the stop already carries its cause.

## Recording

`ChargingSessionRecorder` subscribes to the charge point's domain events, the
same way the [timeline projector](operational-timeline.md) does:
`transactionStarted` opens a session, the connector's `transactionIdChange`
fills in the 1.6 id, `transactionStopped` closes it (taking
`authorizationStatus` from the transaction), `startTransactionNotAccepted`
sets `authorizationStatus` on a session that keeps charging, and
`transactionStartFailed` marks it `failed`. Each field is read from the
connector's `Transaction` when the event fires, never parsed from frames.
Every stored change is also pushed (below).

A session still open when the same connector starts another transaction lost
its end; it is closed as `interrupted`, and so is the running session of a
connector that is removed (removal does not stop the transaction). A stop
with no running session on its connector is ignored: the transaction already
ended.

## Persistence and restarts

There is one history per process, shared by every charge point:

- **Daemon with `--state-db`:** the
  [`charging_sessions`](state-persistence.md#tables) table (schema v17). The
  history survives restarts.
- **Daemon without `--state-db`:** a bounded in-memory store, which outlives a
  `cp.update` rebuild but not the process.
- **Browser (Local mode):** the browser's sql.js database, persisted to
  IndexedDB like the other tables.

Retention: past 500 **ended** sessions per charge point, storing one evicts
that charge point's ended session with the oldest end (its start when the end
is unknown), so a long session that just ended is kept. An active session is
never evicted. Deleting a charge point, or `state.reset`, drops its sessions.

**Reconciliation.** Sessions stored without an end (`endedAt === null`) are
settled against the connectors once per charge point (re)build — on create,
on `cp.update`, on a browser reload, and on a daemon restart once the
connector runtime has been restored:

- a connector still running the transaction a session started (same start
  time) keeps it, `active` again, under the same `sessionId`;
- a restored running transaction with no session gets a new one (e.g. one
  started before this history existed);
- every other unended session becomes `interrupted`, with `endedAt`,
  `meterStopWh`, `energyWh` and `durationMs` left `null`.

So after a daemon restart with `--state-db`, an in-flight transaction resumes
with its session; a `cp.update` (which drops the in-memory transaction) or a
browser reload (which restores none) leaves it `interrupted`.

## Reading it

- **Control plane:** [`sessions.list`](control-plane.md) — `cpId` (required),
  filters `connectorId` and `outcomes`, then a window like `logs.get`'s:
  `limit` takes the newest N (default 50, at most 500), `offset` skips the
  newest N first, and `order` (`"desc"`, newest first, by default; by start
  time) only orders the returned page.
  Answers `{ sessions, total }`; an unknown `cpId` answers `not_found`.
- **MCP:** the curated [`list_charging_sessions`](../entities/mcp-endpoint.md)
  tool.
- **Push:** every stored change is pushed to subscribers of the charge point
  as a [`charging_session`](../entities/cli.md#events) event carrying the whole
  session (in Local mode, a `charging-session` event of the browser service).
- **Console:** the charge point page's
  [Transactions](../entities/web-console.md#transactions-tab) tab.

## EV-side disconnect and connection loss

What a running transaction does when the cable leaves the EV, or when the
WebSocket closes ([#488](https://github.com/shiv3/ocpp-cp-simulator/issues/488)):

- **EV-side disconnect** (`ChargePoint.evDisconnected`; the
  [`ev_disconnected`](control-plane.md) method, the
  [`ev_disconnected`](../entities/mcp-endpoint.md) MCP tool, the console's
  **Unplug**, and a scenario `connectorPlug` plug-out during a transaction).
  `StopTransactionOnEVSideDisconnect` (2.x `TxCtrlr.StopTxOnEVSideDisconnect`,
  default `true`) decides:

  | Key     | OCPP 1.6                                                                                         | OCPP 2.0.1 / 2.1                                                                                              |
  | ------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
  | `true`  | StopTransaction `reason` `EVDisconnected`, then Finishing (and Available while auto-reset is on) | E09: `Ended`, `triggerReason` `EVCommunicationLost`, `stoppedReason` `EVDisconnected`                         |
  | `false` | The transaction is kept; StatusNotification `SuspendedEV`                                        | E10: the transaction is kept; `Updated`, `chargingState` `SuspendedEV`, `triggerReason` `EVCommunicationLost` |

  With `false` the session stays `active`, and the meter stops rising: the
  derived power is zero outside `Charging`. The connector lock is not
  modelled. Without a running transaction, the console's **Unplug** sends
  StatusNotification `Available`, as before, while a scenario plug-out stays a
  no-op.

- **Connection loss.** A WebSocket close never ends a transaction, on any
  version, and no setting makes it (1.6 §3.7, 2.x E11). On OCPP-J 1.6 the
  transaction-related messages produced offline (StartTransaction,
  StopTransaction, MeterValues with a transaction) are queued (in
  [`pending_messages`](state-persistence.md) with `--state-db`, in memory
  otherwise) and replayed after the next accepted boot, at most
  `TransactionMessageAttempts` times. On 2.x there is
  no offline queue: a TransactionEvent produced offline is dropped, not
  replayed with `offline: true` as E11.FR.01/FR.02 require; the transaction
  itself survives, and its later events carry the same `transactionId`.

## Limits

- A 2.x TransactionEvent produced while offline is lost: there is no 2.x
  offline queue, so nothing is replayed with `offline: true` (E11.FR.02); see
  [EV-side disconnect and connection loss](#ev-side-disconnect-and-connection-loss).
- A 1.6 StartTransaction that is never answered keeps `transactionId: null`.
- A 2.x TransactionEvent that the CSMS answers with a CALLERROR does not mark
  the session `failed`; only 1.6 StartTransaction does
  ([#490](https://github.com/shiv3/ocpp-cp-simulator/issues/490)).
- `sessions.list` takes one charge point; there is no fleet-wide listing yet
  ([#489](https://github.com/shiv3/ocpp-cp-simulator/issues/489)).
- Local mode does not drop a removed charge point's sessions until
  `state.reset`.
