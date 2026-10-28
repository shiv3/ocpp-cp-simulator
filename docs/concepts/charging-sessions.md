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
related:
  - operational-timeline.md
  - state-persistence.md
  - control-plane.md
  - ocpp-versions-and-transports.md
  - ../entities/mcp-endpoint.md
  - ../entities/web-console.md
  - ../entities/cli.md
  - local-vs-remote-mode.md
updated: 2026-10-28
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
| `failed`      | The CSMS refused the start: a CALLERROR answered 1.6 StartTransaction, or the CSMS did not accept the id and the station stopped on it (`DeAuthorized`, see below).                                                                                                |
| `interrupted` | It ended with `EmergencyStop`, `HardReset`, `SoftReset`, `ImmediateReset`, `Reboot`, `PowerLoss`, `UnlockCommand`, `GroundFault`, `OvercurrentFault`, `PowerQuality`, `Timeout`, or `DeAuthorized` without a CSMS rejection; or its end was lost across a restart. |
| `completed`   | Any other end: `Local`, `Remote`, `EVDisconnected`, `Other`, `EnergyLimitReached`, `SOCLimitReached`, `StoppedByEV`, …                                                                                                                                             |

A rejected id the station kept charging on (`StopTransactionOnInvalidId` /
`TxCtrlr/StopTxOnInvalidId` false) still ends `completed`; its
`authorizationStatus` keeps the CSMS's answer.

### Rejections and failed starts (#447)

Two domain gaps were closed so these outcomes can be told apart:

- **1.6 StartTransaction CALLERROR.** The station already closed the
  transaction and went back to Available; it now also emits
  `transactionStartFailed` first. No StopTransaction.req follows.
- **2.x `idTokenInfo`.** TransactionEvent.conf `idTokenInfo` used to be
  ignored. A status other than `Accepted` for a running transaction now
  mirrors 1.6 (#181): with `TxCtrlr/StopTxOnInvalidId` (default true) the
  station ends it with `triggerReason: Deauthorized` and
  `stoppedReason: DeAuthorized`; with it false the transaction keeps running.
  Either way `startTransactionNotAccepted` reports it.

## Recording

`ChargingSessionRecorder` subscribes to the charge point's domain events, the
same way the [timeline projector](operational-timeline.md) does:
`transactionStarted` opens a session, the connector's `transactionIdChange`
fills in the 1.6 id, `transactionStopped` closes it,
`startTransactionNotAccepted` sets `authorizationStatus`, and
`transactionStartFailed` marks it `failed`. Each field is read from the
connector's `Transaction` when the event fires, never parsed from frames.
Every stored change is also pushed (below).

A session still open when the same connector starts another transaction lost
its end; it is closed as `interrupted`.

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
that charge point's oldest ended session. An active session is never evicted.
Deleting a charge point, or `state.reset`, drops its sessions.

**Reconciliation.** Sessions stored without an end (`endedAt === null`) are
settled against the connectors whenever a charge point is (re)built — on
`cp.update`, on a daemon restart, on a browser reload — and again once the
daemon has restored the connector runtime:

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
  filters `connectorId` and `outcomes`, `limit` (default 50, at most 500),
  `offset`, `order` (`"desc"`, newest first, by default; by start time).
  Answers `{ sessions, total }`; an unknown `cpId` answers `not_found`.
- **MCP:** the curated [`list_charging_sessions`](../entities/mcp-endpoint.md)
  tool.
- **Push:** every stored change is pushed to subscribers of the charge point
  as a [`charging_session`](../entities/cli.md#events) event carrying the whole
  session (in Local mode, a `charging-session` event of the browser service).
- **Console:** the charge point page's
  [Transactions](../entities/web-console.md#transactions-tab) tab.

## Limits

- A WebSocket disconnect does not end a transaction, and nothing acts on
  `StopTransactionOnEVSideDisconnect` yet: a session stays `active` across a
  connection loss.
- A 1.6 StartTransaction that is never answered keeps `transactionId: null`.
- A 2.x TransactionEvent that the CSMS answers with a CALLERROR does not mark
  the session `failed`; only 1.6 StartTransaction does.
- `sessions.list` takes one charge point; there is no fleet-wide listing yet.
- Local mode does not drop a removed charge point's sessions until
  `state.reset`.
