---
title: OCPP versions and transports
type: concept
summary: What the simulator speaks — OCPP-J 1.6J (default), 2.0.1 and 2.1 over WebSocket, and OCPP-S 1.2 / 1.5 / 1.6S over SOAP 1.2 + WS-Addressing — and which surfaces support which.
sources:
  - src/ocpp/ (generated from vendor/ocpp-schemas)
  - vendor/ocpp-schemas/NOTICE
  - README.md (SOAP section)
  - src/cli/soapCallbackUrl.ts
  - src/cli/soapTunnel.ts
  - src/cp/infrastructure/transport/OCPPWebSocket.ts (WebSocket ping)
  - src/cp/domain/charge-point/ClockAlignedMeterScheduler.ts (clock-aligned metering)
  - src/cp/domain/connector/SignedMeterData.ts (OCMF signed meter values)
  - src/cp/infrastructure/transport/OCPPMessageHandlerV201.ts (TransactionEvent retries, E11 offline queue)
  - src/cp/domain/transport/PendingMessageQueue.ts
  - src/cli/server/CPRegistry.ts (SOAP public base derivation)
  - docs/examples/scenarios/all-cases.json
  - e2e/README.md
related:
  - ../sources/vendored-ocpp-schemas.md
  - ../entities/csms-peers.md
  - ../entities/cli.md
  - ../entities/daemon.md
  - security-profiles.md
  - trace-format.md
  - scenario-format.md
  - charging-sessions.md
  - operational-timeline.md
  - expert-ocpp-calls.md
  - variable-monitoring.md
updated: 2026-10-30
---

# OCPP versions and transports

| Version    | Transport                        | Flag value   | Browser (Local mode) | CLI / daemon     | Notes                                                                |
| ---------- | -------------------------------- | ------------ | -------------------- | ---------------- | -------------------------------------------------------------------- |
| OCPP 1.6J  | OCPP-J (JSON over WebSocket)     | `OCPP-1.6J`  | ✅                   | ✅ (default)     | Primary target; DebugKit `analyze`, k6 export, cert16 templates      |
| OCPP 2.0.1 | OCPP-J                           | `OCPP-2.0.1` | ✅                   | ✅               | Validated against gocpp in the [e2e suite](../sources/e2e-readme.md) |
| OCPP 2.1   | OCPP-J                           | `OCPP-2.1`   | ✅                   | ✅               | Wire output identical to 2.0.1 for the scenario node set             |
| OCPP 1.2   | OCPP-S (SOAP 1.2, WS-Addressing) | `OCPP-1.2`   | send-only            | ✅ bidirectional | Narrower message surface (see below)                                 |
| OCPP 1.5   | OCPP-S                           | `OCPP-1.5`   | send-only            | ✅ bidirectional |                                                                      |
| OCPP 1.6S  | OCPP-S                           | `OCPP-1.6S`  | send-only            | ✅ bidirectional | Full 1.6 message set incl. TriggerMessage and charging profiles      |

Message types and validators for the JSON versions are generated from the
[vendored OCA schemas](../sources/vendored-ocpp-schemas.md).

On 2.0.1 and 2.1, `SetVariableMonitoring`, `ClearVariableMonitoring`,
`GetMonitoringReport`, `SetMonitoringLevel` and `SetMonitoringBase` act on a
stored, persisted monitor catalog that includes the station's own
hardwired and preconfigured monitors, and the monitors report through
`NotifyEvent`, periodic ones on a timer: see
[OCPP 2.x variable monitoring](variable-monitoring.md) (#457, #538). A 2.x
station also publishes runtime values as device-model variables
(`EVSE.Power`, `AvailabilityState`), and on 2.1 a `Target` attribute on
`EVSE.Power` for TargetDelta monitors, which 2.0.1 does not have.

## Version-agnostic scenarios

The scenario engine is version-agnostic: the same
[scenario file](scenario-format.md) runs under `--ocpp-version OCPP-1.6J`,
`OCPP-2.0.1` or `OCPP-2.1` and each node emits the wire message appropriate
to that version (e.g. `remoteStartTrigger` waits for `RemoteStartTransaction`
on 1.6 and `RequestStartTransaction` on 2.x). `docs/examples/scenarios/all-cases.json`
is the node-type catalogue exercised across all three versions by
`e2e/comprehensive.gocpp.e2e.ts` ([Example scenarios](../sources/example-scenarios.md)).

The same rule covers the nodes that **name a CSMS→CP action** —
`csmsCallTrigger`, `responseOverride`, `inboundPolicy` (#349). A scenario may spell the action in either version's vocabulary; a 2.x station looks an incoming CALL up under its own name and its 1.6 alias, and a trigger spelled `RemoteStartTransaction` releases on `RequestStartTransaction`. A 1.6 station translates nothing: there `GetDiagnostics` / `GetLog`, `TriggerMessage` / `ExtendedTriggerMessage` and `UpdateFirmware` / `SignedUpdateFirmware` are distinct messages on the same wire, and a node keeps matching exactly what it names. When an override was armed under both spellings, one CALL consumes both. The pairs
whose spelling differs (`src/cp/domain/types/csmsActionNames.ts`; every other
action is spelled identically in both versions):

| OCPP 1.6                 | OCPP 2.0.1                | Note                                                                                                                                                                                                                                                             |
| ------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RemoteStartTransaction` | `RequestStartTransaction` | `responseOverride` `{ status }` is schema-valid on both.                                                                                                                                                                                                         |
| `RemoteStopTransaction`  | `RequestStopTransaction`  | Same.                                                                                                                                                                                                                                                            |
| `ChangeConfiguration`    | `SetVariables`            | `inboundPolicy` and `csmsCallTrigger` translate; a `responseOverride` does **not** fit — `SetVariablesResponse` is `setVariableResult[]`, not `{ status }` — so the station **ignores it with a warning** and answers normally (the override is still consumed). |
| `GetConfiguration`       | `GetVariables`            | Same caveat as `SetVariables`: ignored with a warning.                                                                                                                                                                                                           |
| `GetDiagnostics`         | `GetLog`                  |                                                                                                                                                                                                                                                                  |
| `SignedUpdateFirmware`   | `UpdateFirmware`          | 1.6 Security Whitepaper name; both fold into the one 2.0.1 message.                                                                                                                                                                                              |
| `ExtendedTriggerMessage` | `TriggerMessage`          | Same.                                                                                                                                                                                                                                                            |

Until #349 the 2.0.1 inbound dispatch consulted none of the three mechanisms,
so no negative (refuse / ignore a CSMS call) or wait-for-call scenario was
expressible on 2.0.1 at all; it now consults them at the same point the 1.6
handler does, before payload validation and handler lookup, so policies are
sticky across reconnects the same way and an override answers once.

## WebSocket ping (`WebSocketPingInterval`)

An OCPP-J charge point sends a WebSocket ping frame every
`WebSocketPingInterval` seconds (#406) — the 1.6 key, or
`OCPPCommCtrlr.WebSocketPingInterval` through `SetVariables` on 2.0.1 / 2.1.
It keeps an idle connection alive through a proxy that drops silent
WebSockets, at the cost of a control frame instead of a Heartbeat round trip.

- **`0` (the default) sends no ping**, as before; the CSMS may still ping and
  the station answers with a pong.
- A change takes effect at once on the open socket and is re-armed on every
  reconnect; a value persisted with `--state-db` applies from the first open.
- A negative value (§9.1.34), or one above `2147483` s — the longest delay a
  timer holds before Node and Bun turn it into 1 ms — is answered `Rejected`;
  such a value persisted by an older version is ignored at load, so the key
  falls back to `0`.
- Ping frames are WebSocket control frames, not OCPP messages: they bypass
  [network simulation](network-simulation.md) and are not logged one by one
  (one `WebSocket ping every Ns` or `WebSocket ping off` line when the value
  changes).
- **A charge point that cannot send a ping frame does not have the key.** A
  SOAP station has no socket, and the browser's `WebSocket` API has no
  `ping()`, so in Local mode and on every SOAP version `ChangeConfiguration`
  answers `NotSupported`, `GetConfiguration` lists the key as unknown, and
  2.x `SetVariables` answers `Rejected`. The CLI and daemon (Bun's client, or
  `ws` under Node) always send them.

## Transaction message retries (OCPP 2.x)

On 2.0.1 and 2.1 a transmission of a TransactionEvent (`Started`, `Updated`
or `Ended`) fails in two ways (E13):

- a CALLERROR answers it: the CSMS failed to process it (#490);
- no CALLRESULT or CALLERROR comes within
  `OCPPCommCtrlr.MessageTimeout[Default]` seconds (default 30, #529). E13
  names this trigger in its description and remark (2.0.1 Table 120 / 2.1
  E13 use case); OCPP-J
  Part 4 §4.1.1 calls such a CALL timed out.

On either failure the station:

- **keeps the transaction running.** The connector stays as it was, the
  station does not end the transaction on the error, and the
  [charging session](charging-sessions.md) stays `active`. This differs from 1.6, where a StartTransaction CALLERROR
  abandons the transaction (#447);
- **emits `transactionMessageRejected`** (`connectorId`, `transactionId`,
  `action`, `eventType`, `reason`, `errorCode`, `attempt`) on every failed
  transmission. `action` is `TransactionEvent`; `reason` is `callError` or
  `timeout`, and `errorCode` is set for `callError` only;
- **resends the same payload** (same `seqNo`, same `transactionId`) under a
  new message id, as OCPP-J requires for a retry (Part 4 §4.1.4). It waits
  `OCPPCommCtrlr.MessageAttemptInterval[TransactionEvent]` seconds times the
  number of transmissions so far (E13.FR.03): 60 s, then 120 s with the
  default of 60;
- **discards the message after `OCPPCommCtrlr.MessageAttempts[TransactionEvent]`
  transmissions in all** (default 3, E13.FR.04) and emits
  `transactionMessageDiscarded` (`attempts` instead of `attempt`; `reason`
  and `errorCode` describe the last failure).

A CALLRESULT ends the retries; an answer to a resend goes through the normal
`idTokenInfo` handling. Both settings are the 1.6 keys
`TransactionMessageAttempts` and `TransactionMessageRetryInterval` under
their 2.x names, so `SetVariables`, `GetVariables` and `GetBaseReport` see
them and a change applies to the next failure. An attempts value below 1
counts as 1; a negative interval counts as 0.

A timed-out transmission stays matched to its message, so a late answer is
still handled. The rule (#529) is that each message is applied once and
each transmission counts as failed once:

- the **first CALLRESULT** for any transmission of the message settles it.
  The station applies that answer, cancels a resend still waiting, and
  forgets every other transmission of the message;
- an answer to a forgotten transmission is ignored: a second CALLRESULT
  applies nothing twice, and a CALLERROR triggers no resend;
- a CALLERROR for a transmission that already timed out is not counted
  again: the resend already scheduled stays the only one;
- once the message is discarded, every transmission is forgotten, and a
  CALLRESULT arriving later is ignored.

`MessageTimeout` is a 2.x-only key (default 30, like the 1.6 serial queue's
30 s CALL timeout), read at each transmission. The CSMS addresses it as
`OCPPCommCtrlr.MessageTimeout` with `variableInstance = "Default"` (2.0.1
and 2.1 §2.1.3 "DefaultMessageTimeout"). The spec makes it ReadOnly: the
CSMS sets it through a NetworkConnectionProfile, and this simulator answers
`SetNetworkProfile` with `Rejected`. So `SetVariables` answers `Rejected`
too, and `GetBaseReport` reports it as ReadOnly. No other 2.x CALL is resent
on a timeout. 1.6 `GetConfiguration` does not list the key.

The two retry settings are instanced variables: the CSMS names them
`MessageAttempts` / `MessageAttemptInterval` with
`variableInstance = "TransactionEvent"`
(2.0.1 §2.1.10/2.1.11, 2.1 §2.1.12); "MessageAttemptsTransactionEvent" is
only the title of the spec section. Without that instance, or under the
flat name, `GetVariables` / `SetVariables` answer `UnknownVariable`. The
same holds for `MessageTimeout` with instance `Default`. The results echo
the `variable` the CSMS sent, instance included, and `GetBaseReport`
reports `variable: { name, instance }` for them. The
`MonitoringCtrlr.ItemsPerMessage` / `BytesPerMessage` variables are
instanced the same way (`SetVariableMonitoring`, `ClearVariableMonitoring`;
see [variable monitoring](variable-monitoring.md#monitoringctrlr-variables),
#538). Every other mapped variable has no instance and answers whatever
instance the CSMS names, as before.

Known limitation: 2.x has no serial queue here as on 1.6, so a waiting
resend does not hold back the next transaction message. E13 (Figure 62)
describes sequential delivery; this station may deliver `Ended` before the
resent `Started`, and the CSMS has to order the messages by `seqNo`. When
the WebSocket closes (network loss, disconnect, reset, delete), a resend
still waiting and a written TransactionEvent still waiting for its answer
are not dropped: they go to the
[E11 offline queue](#e11-offline-queue-for-transactionevent) (#528), and
their timers are cleared. So does a resend that finds the station offline
when it falls due. A transmission the socket drops while the connection
stays up (a network-sim queue overflow) is lost: a resend is logged as a
`warn` (category `TRANSACTION`) naming the event type, transaction and
attempt; no event is emitted. Only TransactionEvents the station builds are
retried, time out or are queued; one sent as an
[expert call](expert-ocpp-calls.md) is not.

The [operational timeline](operational-timeline.md) records both events as
`transaction_message_rejected` and `transaction_message_discarded`.

## E11 offline queue for TransactionEvent

On 2.0.1 and 2.1 the station queues the TransactionEvents (`Started`,
`Updated`, `Ended`) it cannot deliver and replays them once the connection
is restored (E11 "Connection Loss During Transaction", #528):

- **What is queued** (E11.FR.01: "all TransactionEventRequest messages,
  that it would have sent to the CSMS if the Charging Station had been
  online"): an event produced while the WebSocket is down, an event the
  socket drops on close, an event written but still unanswered when the
  socket closes, and an E13 resend still waiting. Each message is queued
  once, in the order the events were produced, with the payload as last
  sent or built: no `offline` field for an event not yet replayed,
  `offline: true` for a replay a new close queues again. An event produced
  while the queue still waits for its replay (socket back, BootNotification
  not yet Accepted, or a restart that found persisted rows) joins the
  queue too, so the order holds.
- **Where**: the `pending_messages` table that 1.6 uses (action
  `TransactionEvent`), with [`--state-db`](state-persistence.md); in memory
  otherwise. A restart with state persistence replays what was queued.
- **Replay** (E11.FR.02): after the next BootNotification `Accepted`, every
  queued event is sent in order with `offline: true`, under a new message
  id, with the `seqNo` it was built with. E11.FR.07 ("every message that is
  still in the queue SHALL be set Offline") is why an event that was
  written before the close also carries `offline: true` on replay.
  The replay sets `offline: true`; an event sent directly, not through the
  queue, never carries it.
- **E13 still applies to a replayed event**, with fresh counters: its
  `MessageAttempts[TransactionEvent]` budget and `transactionMessageRejected`
  `attempt` restart at 1, as a 1.6 replay goes through the serial queue
  anew. A row leaves the queue when its replay is handed to the socket; a
  close before the answer queues the event again. A replay the socket
  refuses while the connection stays up (a network-sim refusal or
  overflow) stays at the head of the queue, with a `warn` (category
  `TRANSACTION`); the replay stops there, and that row, the rows behind it
  and any new TransactionEvent wait for the next BootNotification
  `Accepted`.
- **Rows of the other protocol are dropped.** 1.6 and 2.x share
  `pending_messages` by charge point id, and `cp.update` can switch
  `ocppVersion` over the same `--state-db`. When a handler starts, its
  queue deletes every row it does not replay, with one `warn` (category
  `OCPP`) listing them: the 2.x handler anything but `TransactionEvent`
  and `NotifyEvent`, the 1.6 handler anything but StartTransaction,
  StopTransaction and MeterValues. Such a row never holds back a new
  TransactionEvent.
- **NotifyEvent** (#538): monitor events at or below
  `MonitoringCtrlr.OfflineQueuingSeverity` are queued too (N07.FR.04,
  N08.FR.03) and replayed in the same pass, in production order, without
  `offline` (the request has no such field). Queued NotifyEvents alone
  never hold a live TransactionEvent back: only queued TransactionEvents
  do. A refused NotifyEvent replay stays at the head and delays the
  TransactionEvents behind it, as a refused TransactionEvent would. The
  queue keeps at most 1000 NotifyEvent reports per charge point: past
  that, the oldest report made only of `Periodic` events is dropped, else
  the oldest report, never a TransactionEvent, with one `warn` at the
  first drop of an outage and one with the count at the replay.
  See [variable monitoring](variable-monitoring.md#offline-queuing).
- **Other 2.x messages are not queued.** StatusNotification, Heartbeat,
  MeterValues, the NotifyEvents above the severity and the rest are
  dropped while offline, as before. `OCPPCommCtrlr.QueueAllMessages` (optional, not implemented) is
  what would queue them; when it is false the spec queues only
  transaction-related messages "as required in: E04.FR.01" (2.0.1
  §2.1.9, 2.1 §2.1.10). The spec sets no order between the replay and the
  other messages sent after reconnecting. The station sends its post-boot
  StatusNotifications first, then the replay, as on 1.6
  (`ChargePoint.markBootAccepted` defers the flush to a microtask).

Limits:

- The queue has no size cap for TransactionEvents (only the NotifyEvent
  reports are capped, #538), so the E11.FR.04/FR.05 memory-pressure drop
  of `Updated` events is not modelled.
- The replay goes out as a burst: 2.x has no serial queue (see the known
  limitation above), so the station does not wait for one answer before
  sending the next replayed event.
- A row leaves the table when its replay is handed to the socket, as on
  1.6. A process crash before the answer loses it, where the E04 failure
  postcondition keeps an unanswered event in the queue.
- A restart replays the queued events, but the 2.x `transactionId` and
  `seqNo` counter of a transaction restored after the restart are not
  persisted, so its later events do not continue the replayed ones.
- `GetTransactionStatus` answers `messagesInQueue: false` whatever the
  queue holds (E14).

## Clock-aligned meter values (`ClockAlignedDataInterval`)

Every `ClockAlignedDataInterval` seconds a charge point sends one
clock-aligned sample per connector (#454) — the 1.6 keys
`ClockAlignedDataInterval` / `MeterValuesAlignedData`, or
`AlignedDataCtrlr.Interval` / `AlignedDataCtrlr.Measurands` through
`SetVariables` on 2.0.1 / 2.1. It is independent of the transaction meter
scheduler (`MeterValueSampleInterval`, auto-meter curves): it reads the
register and never advances it.

- **Boundaries are wall-clock instants counted from UTC midnight**, not
  "every N seconds since start": with `900` samples go out at `12:00:00`,
  `12:15:00`, `12:30:00`… whenever the station booted. An interval that does
  not divide a day shortens the day's last slot; midnight is always a
  boundary. Each sample carries the boundary instant as its `timestamp` and,
  except on 1.2 (which has no `context`), `context` `Sample.Clock`.
- **`0` (the default) sends nothing.** Valid values are `0`–`86400`; anything
  else is answered `Rejected`.
- **`MeterValuesAlignedData` picks the measurands**, not
  `MeterValuesSampledData`. It is empty by default, and an empty list sends
  nothing even with a positive interval. The SOAP dialects narrow it the way
  they narrow every `MeterValues`: 1.5 drops the measurands it does not
  define and sends nothing for a connector when none is left (with a
  warning); 1.2 only ever reports the energy register, `"0"` when the list
  does not name `Energy.Active.Import.Register`.
- **What carries the sample:**

  | Version         | Live transaction on the connector                                           | Otherwise                                   |
  | --------------- | --------------------------------------------------------------------------- | ------------------------------------------- |
  | 1.6J, 1.5, 1.6S | `MeterValues` with the transaction's `transactionId` (none while it is `0`) | `MeterValues` without `transactionId`       |
  | 1.2             | `MeterValues` (1.2 has no `transactionId`)                                  | `MeterValues`                               |
  | 2.0.1, 2.1      | `TransactionEvent(Updated)`, `triggerReason` `MeterValueClock`              | `MeterValues` with the connector's `evseId` |

  The 2.x clock trigger is never `MeterValuePeriodic`, which stays reserved to
  periodic in-transaction samples (#347).

- **It runs while BootNotification is Accepted** and stops when the
  connection closes or a boot is answered Pending / Rejected; it restarts on
  the next accepted boot. Samples are not taken while offline. A change takes
  effect at once on the new grid; a value persisted with `--state-db`
  applies from the first accepted boot.
- **A boundary is reported once per process**, even when a reconnect, a
  re-boot or an interval change lands on it again.
- Not implemented: connector 0 / `evseId` 0 (main meter), `StopTxnAlignedData`
  in `StopTransaction`, `AlignedDataCtrlr.SendDuringIdle` and the `TxEnded*`
  variables, and per-period aggregation of `*.Interval` measurands.

## Periodic meter values in a 2.x transaction (#347)

OCPP 2.0.1 and 2.1 carry in-transaction sampled data
(`SampledDataCtrlr.TxUpdatedMeasurands`, mapped to `MeterValuesSampledData`)
in `TransactionEvent(Updated)`, and keep `MeterValuesRequest` for data
outside a transaction. The simulator's per-connector meter-value scheduler
sends `MeterValuesRequest` either way **by default**, because changing that
would change the wire for every existing 2.x integration.

A charge point created with `txUpdatedMeterValues: true` (`cp.create`,
`cp.update`, `cp.create_many`, the MCP `cp_create` tools) or with
`--tx-updated-meter-values` opts in. It is persisted with `--state-db`.

| Scheduler sample, OCPP 2.x | Option off (default) | Option on                                         |
| -------------------------- | -------------------- | ------------------------------------------------- |
| Transaction running        | `MeterValues`        | `TransactionEvent(Updated)`, `MeterValuePeriodic` |
| No transaction             | `MeterValues`        | `MeterValues`                                     |

With the option on, the Updated event shares the transaction's `seqNo` and
goes through the [transaction message retries](#transaction-message-retries-ocpp-2x);
its sampled values carry `context` `Sample.Periodic`, and a sample with no
value in it sends nothing, as `MeterValues` does. The option never applies to
a one-off sample (`send_meter_value`, a CSMS `TriggerMessage(MeterValues)`),
to clock-aligned samples (above, `MeterValueClock` regardless), or to 1.x.
The details are in [Control plane → Transaction event parameters](control-plane.md#transaction-event-parameters).

Independently of the option, the register reading in `TransactionEvent(Started)`
and `(Ended)` carries `context` `Transaction.Begin` / `Transaction.End`.

## Signed meter values (OCMF, #315)

A charge point can sign its energy register in the Open Charge Metering
Format (OCMF 1.4, from S.A.F.E. e.V.), the format German calibration-law
(Eichrecht) charge points use, so a CSMS's signed-data path (parse the OCMF
document, check the signature against the station's key, reject on mismatch)
has something to test against. **It simulates the wire format, not a
calibrated meter**: nothing it produces is legally valid metering data.

- **Off by default, and free while off**: no record is built and no key is
  made until `SampledDataSignReadings` is `true` (on 2.0.1 / 2.1 through
  `SetVariables` on `SampledDataCtrlr.SignReadings`).
- **One ephemeral key per connector**: ECDSA P-256
  (`ECDSA-secp256r1-SHA256`), made on first use and held in memory only. There
  is no key store, import or rotation; a restart makes new keys. A 1.6
  transaction restored after a restart therefore drops its stored begin
  record (the key that signed it is gone), and its `StopTransaction` carries
  the end record only. A message signed before a restart and still queued
  offline is resent as it was, so its records fail against the new key; that
  is what a station that lost its key would send.
- **Signing is synchronous** (`@noble/curves`), so turning it on never
  reorders the messages a station sends.

| Key (1.6 name)            | 2.x variable                    | Access | Default | Meaning                                                                                      |
| ------------------------- | ------------------------------- | ------ | ------- | -------------------------------------------------------------------------------------------- |
| `SampledDataSignReadings` | `SampledDataCtrlr.SignReadings` | RW     | `false` | Sign the energy register (custom key on 1.6; the name the ecosystem's vendors use)           |
| `SignedMeterDataMode`     | —                               | RW     | `valid` | `valid`, `tampered_payload`, `wrong_key` or `invalid_signature`; anything else is `Rejected` |
| `MeterPublicKey<id>`      | —                               | R      | —       | Connector `<id>`'s public key, hex DER SubjectPublicKeyInfo; appears once that key exists    |

**What carries the record:**

| Version    | Begin (`TX` `B`)                                                                              | During the transaction (`TX` `C`)                                                                              | End (`TX` `E`)                                        |
| ---------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 1.6J       | Signed at `StartTransaction`, sent in `StopTransaction.transactionData` (`Transaction.Begin`) | An extra `format: "SignedData"` sample in every `MeterValues` with a `transactionId`                           | `StopTransaction.transactionData` (`Transaction.End`) |
| 2.0.1, 2.1 | `signedMeterValue` on the energy sample of `TransactionEvent(Started)`                        | `signedMeterValue` on the energy sample of `TransactionEvent(Updated)` with meter values, and of `MeterValues` | `signedMeterValue` on `TransactionEvent(Ended)`       |

The 2.x `signedMeterValue` always carries all four fields (`signedMeterData`
base64 of the OCMF document, `signingMethod`, `encodingMethod` `OCMF`,
`publicKey` base64 DER): 2.0.1 requires them and 2.1, where two became
optional, accepts them. Records are signed in time order, so the OCMF
transaction page counter (`PG` `T1`, `T2`…) runs begin, samples, end, and a
CSMS that collects every record of a session sees no gap. A 1.6 begin record
signed at `StartTransaction` is still sent at the stop if signing was turned
off in between. A `|` inside an identifier (idTag, serial) is written as the
JSON escape `\u007C`, so the record always splits into its three
sections; a negative register is signed as it is (`-1.500`), not clamped.
A register too large to write as plain decimal digits is not signed. The
records claim no identification detail (`IF` is empty): the station does not
record whether a tag came from an Authorize result, the cache or a timeout.
Clock-aligned (`Sample.Clock`) samples carry no signed record on any version.
Every 2.x Started / Ended register reading, signed or not, carries `context`
`Transaction.Begin` / `Transaction.End` (#347).

**Test modes** (`SignedMeterDataMode`) apply to every record signed while
set; the advertised key is always the connector's own:

| Mode                | Record                                                   | A conforming CSMS |
| ------------------- | -------------------------------------------------------- | ----------------- |
| `valid`             | Signed with the connector's key                          | accepts           |
| `tampered_payload`  | A reading changed after signing                          | rejects           |
| `wrong_key`         | Validly signed, but with a different key than advertised | rejects           |
| `invalid_signature` | The signature block is garbage                           | rejects           |

- Not implemented: SOAP versions, clock-aligned (`AlignedData*`) and fiscal
  (`PG` `F…`) records, other OCMF curves, a stable or imported key, and
  scenario nodes to switch the mode mid-session (set the key with a
  `configSet` node or, on 1.6J, `ChangeConfiguration` instead). 2.x has no
  `ChangeConfiguration` and no `SignedMeterDataMode` variable.

## SOAP versions (1.2, 1.5, 1.6S)

OCPP 1.2, 1.5, and 1.6 (SOAP) all use SOAP 1.2 / WS-Addressing over HTTP
(not WebSocket). The browser UI can run them in **send-only mode** (CP→CSMS
calls work; CSMS-initiated commands like RemoteStart and Reset are unavailable
since the browser can't host the callback endpoint). Full bidirectional SOAP
remains **CLI / server-mode only**. Point `--ws-url` at the CSMS
_CentralSystemService_ URL and give the callback URL the CSMS should reach the
charge point on.

> The `http://` examples below are for a **local / trusted-network** CSMS
> such as a SteVe checkout on the same machine. OCPP-S carries no per-message
> authentication and the callback endpoint is gated only by the daemon's
> Basic Auth or the network boundary, so for a remote CSMS or a tunnel use
> `https://` on both sides (`--ws-url https://…`, an HTTPS
> `--soap-public-base-url` / `--soap-callback-url` terminated by a proxy in
> front of the daemon, or the https origin `--soap-tunnel ngrok` yields).

**OCPP 1.2:**

```bash
bun src/cli/main.ts \
  --cp-id CP-001 --ocpp-version OCPP-1.2 \
  --ws-url http://csms-host:8180/services/CentralSystemService \
  --soap-callback-url http://this-host:9700/ocpp/soap/CP-001/ChargePointService \
  --json
```

OCPP 1.2 has a narrower message surface: no DataTransfer (a `data_transfer` command is refused there, #348), GetConfiguration,
LocalAuthList, or Reservation messages; status values are limited to a 4-value set.

**OCPP 1.5:**

```bash
bun src/cli/main.ts \
  --cp-id CP-001 --ocpp-version OCPP-1.5 \
  --ws-url http://csms-host:8180/steve/services/CentralSystemService \
  --soap-callback-url http://this-host:9700/ocpp/soap/CP-001/ChargePointService \
  --json
```

**OCPP 1.6 (SOAP):**

```bash
bun src/cli/main.ts \
  --cp-id CP-001 --ocpp-version OCPP-1.6S \
  --ws-url http://csms-host:8180/steve/services/CentralSystemService \
  --soap-callback-url http://this-host:9700/ocpp/soap/CP-001/ChargePointService \
  --json
```

OCPP 1.6S supports the full 1.6 message set including TriggerMessage and
charging profiles.

All SOAP versions share the same endpoint pattern:

- **CP → CSMS**: BootNotification, Heartbeat, StatusNotification, Authorize,
  Start/StopTransaction, MeterValues.
- **CSMS → CP**: the daemon hosts `POST <soap-path>/:cpId/ChargePointService`
  (default `--soap-path /ocpp/soap`) to answer CSMS-initiated calls — **Reset** on
  every SOAP version, and the full OCPP 1.6 command set (RemoteStart/Stop,
  TriggerMessage, ChangeAvailability, charging profiles, …) on 1.6S. The endpoint
  relies on the daemon's `--web-console-basic-auth-*` gate or a trusted network
  boundary — OCPP-S has no per-message authentication field
  ([Access control](access-control.md#basic-auth-gate)).

The callback URL the CP advertises to the CSMS is resolved by precedence:

1. `--soap-callback-url <url>` — the full URL, used verbatim.
2. A **SOAP public base** the daemon holds — either `--soap-public-base-url
<url>` (a public origin the CSMS can reach) or the origin of the tunnel
   `--soap-tunnel ngrok` opens; the two are mutually exclusive, since both
   answer the same question. Every SOAP charge point without a callback URL —
   bootstrapped from the flags, restored from `--state-db`, or created later
   over `cp.create` / the web console — gets one derived at instantiation as
   `<base><soap-path>/<cp-id>/ChargePointService`, flagged
   `soapCallbackUrlDerived` in its config. Such a URL is **not persisted**: a
   free-tier tunnel URL changes between daemon runs, so a restored charge point
   re-derives from whatever base the daemon has now, and a `cp.update` that
   sends no `soapCallbackUrl` re-derives as well rather than freezing one
   run's origin into the row. An explicit `--soap-callback-url` still wins —
   and so does a URL that was _persisted_ as explicit: charge points created
   before the derivation existed (images before `0.7.13`) had the URL derived
   from `--soap-public-base-url` written to their row, so they keep that
   origin across a base change or a switch to the tunnel until a `cp.update`
   sends them without a `soapCallbackUrl` (which clears the row and
   re-derives).
3. None — a SOAP charge point refuses to start: the CSMS has nowhere to call.
   On `cp.create` / the console that is an `invalid_params` error; from the
   flags it is a fatal startup error. On **restore** it is neither: a
   persisted SOAP charge point with no callback URL and no base to derive one
   from is **skipped with a warning** naming `--soap-tunnel` and
   `--soap-public-base-url`, its row is kept, and the remaining charge points
   restore normally — a daemon that ran once with the tunnel and once without
   must still start (#354 follow-up). Start it again with a base, or give the
   charge point an explicit URL with `cp.update`, and it comes back.

Clients read the base from the `server.info` RPC
([Control plane](control-plane.md#daemon-methods)). The web console uses it to make
the callback URL optional in the create / edit form (the derivation is shown as
the field's placeholder), and shows the effective URL on the charge point's
**Config** form with a **Copy** button — that is the value to register in the
CSMS — noting when it came from the tunnel.

### Exposing the callback through a tunnel

`--soap-tunnel ngrok` (#183) is for a CSMS that cannot reach your machine — a
hosted SteVe, a staging environment, CI. The daemon starts in the issue's
order: it binds a **dedicated listener that serves the callback route and
nothing else** (`--soap-tunnel-port`, a free port by default), opens the tunnel
towards that listener, and only then builds the registry, restores the fleet
and binds the API / console listeners — so by the time a restored charge point
tells the CSMS its callback URL, a callback finds a bound, routed listener. The
tunnel therefore publishes the CSMS→CP endpoint alone: socket.io, the web
console, MCP, health and metrics stay on the local listeners and answer 404 on
the tunnel one. That listener has **no authentication**: the CSMS is its only
client and OCPP-S callbacks carry no credentials, and `--web-console-basic-auth-*`
gates the daemon's own listeners, not this one. Its only guard is the charge
point identity check on the route, so put a boundary in front of the tunnel
before exposing it — an ngrok traffic policy or IP allow-list restricted to the
CSMS — rather than relying on the URL staying unknown; the startup lines say
so. The per-charge-point `--basic-auth-*` credentials cover the outgoing CP→CSMS
connection only. No npm dependency is involved; two modes:

- **Spawn** (default) — the `ngrok` binary from `PATH` is run as
  `ngrok http <host>:<port> --log stdout --log-format json`, the public URL is
  read from its `started tunnel` log line, and the agent is killed on shutdown.
  If it dies on its own the daemon stops with exit code 1 — a SOAP charge point
  without a reachable callback cannot do its job. `--ngrok-auth-token` reaches
  the agent through its environment (`NGROK_AUTHTOKEN`), never on its command
  line or in a log line; omit it to use the agent's own config file
  (`ngrok config add-authtoken …`). `--ngrok-domain` requests a reserved domain;
  free-tier URLs change between runs, so re-register the callback in the CSMS
  each time (or let it read `wsa:From`).

  ```bash
  ocpp-cp-sim --ocpp-version OCPP-1.6S \
    --ws-url https://csms.example.com/steve/services/CentralSystemService \
    --cp-id CP1 --daemon --soap-tunnel ngrok
  # [server] SOAP tunnel (ngrok, spawn): https://a1b2.ngrok-free.app -> http://127.0.0.1:53412
  # [server] Warning: SOAP callback endpoint is publicly reachable through the tunnel at https://a1b2.ngrok-free.app/ocpp/soap/CP1/ChargePointService; …
  # [server] The tunnel forwards to the SOAP-only listener on port 53412: the callback route is the only one it publishes; …
  ```

- **Attach** (`--ngrok-api-url <url>`) — an agent someone else runs, typically
  an `ngrok/ngrok` sidecar next to the [Docker image](../entities/docker-image.md),
  which ships no ngrok binary. The daemon reads `GET <url>/api/tunnels` and
  picks the https tunnel whose `addr` port is exactly `--soap-tunnel-port` —
  a tunnel to any other port is refused even when it is the only one, naming
  the port it does forward to, since an agent pointed at the API port would
  publish the control plane — and never stops that agent. `--ngrok-auth-token` and
  `--ngrok-domain` are refused here: the agent is configured where it runs. And
  since that agent forwards to a port configured where _it_ runs,
  `--soap-tunnel-port` is required, so the daemon's SOAP-only listener is where
  the agent expects it.

  ```yaml
  services:
    simulator:
      image: ghcr.io/shiv3/ocpp-cp-simulator
      command: >-
        --ocpp-version OCPP-1.6S --cp-id CP1
        --ws-url https://csms.example.com/steve/services/CentralSystemService
        --soap-tunnel ngrok --ngrok-api-url http://ngrok:4040
        --soap-tunnel-port 9702
    ngrok:
      image: ngrok/ngrok
      command: http simulator:9702
      environment:
        NGROK_AUTHTOKEN: ${NGROK_AUTHTOKEN}
  ```

The flag needs server mode (`--daemon`, `--http-port` or `--web-console`) and a
SOAP `--ocpp-version`; the tunnel forwards to the SOAP-only listener of
`--soap-tunnel-port` and to nothing else. A fleet (`--cp-count`) derives one callback per
charge point from the tunnel origin, exactly as with `--soap-public-base-url`.

Pairs with [SteVe](../entities/csms-peers.md#steve) (register charge points
with protocol `ocpp1.2S`, `ocpp1.5S`, or `ocpp1.6S`, status Accepted).

### SOAP limitations elsewhere in the simulator

- [Network simulation](network-simulation.md) applies to WebSocket CPs only.
- `WebSocketPingInterval` is not a key a SOAP CP has: `ChangeConfiguration`
  answers `NotSupported` ([WebSocket ping](#websocket-ping-websocketpinginterval)).
- [Expert OCPP calls](expert-ocpp-calls.md) (#389) need an OCPP-J CP: a SOAP
  CP refuses them, because each envelope is built per operation.
- `--trace-output` does not capture SOAP frames yet; the
  [trace format](trace-format.md) already reserves `transport: "soap"`.
- [`analyze`](../entities/analyze.md) excludes SOAP records.
- **OCPP 1.5 MeterValues carry fewer measurands than every other version, and
  never two samples with the same one.** 1.5's `SampledValue` has no
  `Power.Offered`, `Current.Offered`, `Power.Factor`, `SoC`, `Frequency` or
  `RPM` measurand, and no `phase` attribute; each unsupported sample is
  dropped rather than relabelled onto a measurand 1.5 does have. 1.6-S carries
  all of them through unchanged. The canonical statement, with the reasoning
  and the tradeoff, is in
  [Scenario format → Charging curve](scenario-format.md#charging-curve-v12).

## Inbound CS→CP request validation

An inbound SOAP request on an **OCPP 1.6-S** charge point is validated
against the vendored OCPP 1.6 schema for its operation before any handler
runs. A request missing a mandatory element is answered with a SOAP Fault
naming that element:

```xml
<s:Fault>
  <s:Code><s:Value>s:Sender</s:Value></s:Code>
  <s:Reason>
    <s:Text>Invalid SetChargingProfile request: must have required property 'csChargingProfiles'</s:Text>
  </s:Reason>
</s:Fault>
```

Before #285 there was no such check, and the consequence was worse than an
unhelpful error: six operations answered a malformed request with a plausible
OCPP status — `Rejected`, `NotSupported`, `VersionMismatch`, one even
`Accepted` with a full schedule payload — so a CSMS sending an invalid
request got a well-formed verdict back and its own defect was masked. The
seventh crashed and returned a Fault carrying a raw JavaScript `TypeError`
that named an implementation variable.

What counts as invalid is the schema in full: a missing mandatory element, an
unexpected one, a value outside its type — including XML that only _looks_
numeric, since `<duration/>` and `<duration>1e2</duration>` would otherwise be
coerced into a perfectly good `0` and `100` — and a `date-time` or `uri` that
does not parse. Formats are checked on this path only; elsewhere a sloppy
timestamp from a CSMS is still worth simulating against rather than refusing.

`Reset` is covered too, although it never reaches the shared dispatcher —
the server answers it from an older registry first, and a check that covered
every operation except the one that reboots the station would be the wrong
one to have.

**Scope: 1.6-S only.** The schemas are the vendored 1.6 ones and OCPP 1.2 /
1.5 have none of their own, so validating a 1.2 request against a 1.6 schema
would reject requests that are correct for their version. Type coercion —
XML gives strings, the schema wants integers and booleans — stays
schema-guided on every dialect, because being lenient in that direction
cannot reject anything.
