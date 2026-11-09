---
title: OCPP versions and transports
type: concept
summary: What the simulator speaks — OCPP-J 1.6J (default), 2.0.1 and 2.1 over WebSocket, and OCPP-S 1.2 / 1.5 / 1.6S over SOAP 1.2 + WS-Addressing — and which surfaces support which.
sources:
  - packages/core/src/cp/shared/WsClientOptions.ts
  - "issue #611"
  - packages/core/src/cp/shared/ReconnectPolicy.ts
  - "issue #609"
  - packages/ocpp/src/ (generated from packages/ocpp/vendor/ocpp-schemas)
  - packages/ocpp/vendor/ocpp-schemas/NOTICE
  - README.md (SOAP section)
  - packages/core/src/cp/infrastructure/transport/soap/soapCallbackUrl.ts
  - packages/core/src/cp/infrastructure/transport/soap/soapRequestQueue.ts (SOAP transaction message retries)
  - apps/cli/src/soapTunnel.ts
  - packages/core/src/cp/infrastructure/transport/OCPPWebSocket.ts (WebSocket ping)
  - packages/core/src/cp/domain/charge-point/ClockAlignedMeterScheduler.ts (clock-aligned metering)
  - packages/core/src/cp/domain/connector/SignedMeterData.ts (OCMF signed meter values)
  - packages/core/src/cp/infrastructure/transport/OCPPMessageHandlerV201.ts (TransactionEvent retries, E11 offline queue)
  - packages/core/src/cp/domain/transport/PendingMessageQueue.ts
  - packages/core/src/cp/infrastructure/persistence/SqlitePendingMessageRepository.ts (`pending_messages` table, issue #878)
  - packages/core/src/cp/infrastructure/transport/v16/serialCallQueueV16.ts (1.6 transaction message retries)
  - "OCPP 1.6 Part 2 §3.7.1 (issue #527)"
  - apps/cli/src/server/CPRegistry.ts (SOAP public base derivation)
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
updated: 2026-11-09
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
whose spelling differs (`packages/core/src/cp/domain/types/csmsActionNames.ts`; every other
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

## Identity in the connection URL

On OCPP-J (1.6, 2.0.1, 2.1) the connection URL is the configured endpoint, a `/` and the charge point identity. The identity is percent-encoded as one path segment with `encodeURIComponent` (OCPP-J 1.6 §3.1.1, RFC 3986; #742): `CP001` stays `CP001`, `a/b` becomes `a%2Fb`, `a%41` becomes `a%2541`, `RDAM 123` becomes `RDAM%20123`. The builder (`buildOcppWebSocketUrl`) adds the `/` itself, so an endpoint with or without a trailing `/` gives the same URL. The HTTP Basic Auth username stays the unencoded identity ([Security profiles](security-profiles.md)).

## Reconnect policy and `RetryBackOff*` (#609)

When an OCPP-J connection closes without the charge point asking for it, the
transport waits and reconnects. The wait and the point at which it stops are
the **reconnect policy**, one object per charge point (`transport.reconnect` on
`cp.create`, the `--reconnect-*` flags in the [CLI](../entities/cli.md), the
`charge_points.transport_options` column of the [state database](state-persistence.md)).
Every field is optional and **the defaults are the schedule before the policy
existed**: 1 s, doubling to 30 s, forever, no jitter.

| Field            | Default       | Meaning                                                                                                                                                                                                                                                                                                         |
| ---------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxAttempts`    | `-1`          | Reconnect attempts after a loss before giving up; `-1` unlimited, `0` never reconnects. The count restarts when a connection opens.                                                                                                                                                                             |
| `mode`           | `exponential` | `exponential` waits `min(baseDelayMs × 2^(attempt−1), maxDelayMs)`; `fixed` waits `baseDelayMs` every time.                                                                                                                                                                                                     |
| `baseDelayMs`    | `1000`        | Wait before the first attempt.                                                                                                                                                                                                                                                                                  |
| `maxDelayMs`     | `30000`       | Cap of the exponential wait; must be ≥ `baseDelayMs`.                                                                                                                                                                                                                                                           |
| `jitterMs`       | `0`           | A random extra wait in `[0, jitterMs]`, drawn from the charge point's seeded `reconnect` stream: the same seed replays the same waits. Without a simulation seed (the CLI and `cp.create` set none) the stream is seeded by the charge point id, so the same id replays the same waits. No draw happens at `0`. |
| `bootRetryLimit` | `-1`          | Automatic BootNotification re-sends after a `Rejected` answer (§4.2) before stopping; `-1` unlimited. An `Accepted` answer or a new connection restores the budget. Applies to SOAP too.                                                                                                                        |

An invalid value is refused when the charge point is created (a typo does not
silently leave the default in place). The delay a network-simulation
`reconnectDelayMs` reserves still wins when it is longer than the computed wait
([network simulation](network-simulation.md)).

**Giving up** — `maxAttempts` or `bootRetryLimit` reached — logs a warning, emits
`gaveUp` and records a `gave_up` entry (`target` `reconnect` or
`boot_notification`, `attempts`) in the [operational timeline](operational-timeline.md).
On 2.x this is an opt-in deviation: OCPP 2.0.1 Part 4 §5.4 says the station keeps reconnecting, and the default (`-1`, unlimited) does. The charge point then stays offline until an explicit `connect`, which starts
with a fresh budget; so does every new connection: the BootNotification budget
is restored when a socket opens, not only on an `Accepted` answer. The
`gave_up` entry of a BootNotification follows the `Rejected` answer that caused it.

**OCPP 2.0.1 / 2.1 (Part 4 §5.4 "Reconnecting").** A 2.x charge point reads three
`OCPPCommCtrlr` variables, ReadWrite and persisted like the others, and they
replace `baseDelayMs`, `jitterMs` and the number of doublings:

| Variable                  | Unit    | Meaning                                                               |
| ------------------------- | ------- | --------------------------------------------------------------------- |
| `RetryBackOffWaitMinimum` | seconds | The first wait; at least 1.                                           |
| `RetryBackOffRandomRange` | seconds | A random extra wait in `[0, RandomRange]` added to every wait.        |
| `RetryBackOffRepeatTimes` | count   | How many times the wait doubles (0–30); after that it stays constant. |

The wait before attempt N is `RetryBackOffWaitMinimum × 2^min(N−1, RepeatTimes)`
plus the random extra (Part 4 §5.4 describes the doubling and the random range
in prose, not as a formula; the variables are defined in the Part 2 Appendices
under `OCPPCommCtrlr`). `RepeatTimes` 2 with a minimum of 20 s waits 20, 40, 80,
80 s. The spec sets no ceiling, so a CSMS's values are followed as set: only the
timer's own limit (2147483647 ms) applies, to the wait and to the wait plus the
random extra. One exception keeps the default schedule: while the three variables
still equal the values derived from the policy (nobody changed them), `maxDelayMs`
caps the doubled part, so 1, 2, 4, 8, 16 does not become 32 s on the sixth attempt.
`mode: fixed` never doubles and `maxAttempts` still ends the loop. The
variable defaults are derived from the policy (whole seconds, at least 1 for the
minimum), so a 2.x charge point with no policy reconnects after 1, 2, 4, 8, 16
and 30 s, like 1.6; a policy with sub-second values is rounded up in the
variables. A 1.6 charge point has none of the three keys.

Local mode (the browser) does not take the policy: the reconnect loop of the web
console's charge points keeps the defaults.

## WebSocket client options (#611)

`transport.ws` — next to `transport.reconnect`, same places: `cp.create`, the
`--ws-*` flags of the [CLI](../entities/cli.md), `charge_points.transport_options` —
sets what the OCPP-J client asks of its WebSocket. Every field is optional and a
charge point without them behaves as before.

| Field                | CLI flag                        | Meaning                                                                                                                                    | Bun | Node (`ws`) | Browser |
| -------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --- | ----------- | ------- |
| `handshakeTimeoutMs` | `--ws-handshake-timeout-ms`     | An attempt that has not opened within this many ms is closed; the [reconnect policy](#reconnect-policy-and-retrybackoff-609) then applies. | yes | yes         | yes     |
| `perMessageDeflate`  | `--ws-no-compression` (`false`) | `false` stops offering `permessage-deflate` on the upgrade; `true` offers it (the default).                                                | yes | yes         | no      |
| `maxPayloadBytes`    | `--ws-max-payload`              | Largest incoming message; a larger one closes the socket (1006 on `ws`).                                                                   | no  | yes         | no      |
| `proxy`              | `--ws-proxy`                    | `http://` or `https://` proxy the upgrade goes through with `CONNECT`.                                                                     | yes | no          | no      |
| `localAddress`       | `--ws-local-address`            | Local IP the connection binds to.                                                                                                          | no  | yes         | no      |

**What the table means.** _yes_ is measured (below), not read from documentation.
The handshake timeout is _yes_ everywhere because the transport enforces it itself
with a timer: no runtime does it for us (Bun never times a handshake out).

**An option the runtime cannot honour is refused, not ignored.** The charge point
is not created: `cp.create` answers an error such as
`WebSocket option "localAddress" is not supported on bun (supported on: node)`,
the CLI exits 1 with the same text, and a charge point restored from the state
database that needs an option the current runtime lacks is skipped with that
warning (the row is kept). Issue #611 asked for a startup warning; a warning
would leave a test running behind a proxy it never used or with a payload limit
it never enforced, so the simulator fails instead. `transport.ws` on a SOAP
version is refused for the same reason: it has no WebSocket.

Values are validated when the charge point is created: `handshakeTimeoutMs` > 0,
`maxPayloadBytes` an integer > 0, `proxy` an `http(s)://` URL, `localAddress`
non-empty. The refusal probe that explains a refused upgrade ([#288](https://github.com/shiv3/ocpp-cp-simulator/issues/288))
goes through the same `proxy`.

**Local mode** (the web console's browser charge points) takes none of this:
`WebSocket` in a browser cannot set compression, payload limits, a proxy or a
source address, and Local charge points keep the default handshake behaviour.

**PoC (2026-11-08, Bun 1.3.14 and Node 22 with `ws`).** Each option was passed
to the client constructor against a local server that records the upgrade
request, a silent TCP server and a recording `CONNECT` proxy:

| Option                     | Bun 1.3.14                                                                                                                                  | Node 22 + `ws`                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `perMessageDeflate: false` | No `Sec-WebSocket-Extensions` sent (default offers `permessage-deflate; client_max_window_bits`). A `compression: false` option is ignored. | Honoured, same result.                                           |
| `maxPayload` 1 KB          | **Ignored**: a 2 MB message is delivered whole.                                                                                             | Honoured: `Max payload size exceeded`, close 1006.               |
| `localAddress` 127.0.0.2   | **Ignored**: the server sees 127.0.0.1.                                                                                                     | Honoured: the server sees 127.0.0.2.                             |
| `proxy`                    | Honoured: the proxy receives `CONNECT host:port`. `HTTP_PROXY` / `http_proxy` are **not** used for WebSockets.                              | No proxy option; it needs an agent and none is bundled.          |
| handshake timeout          | No option; a silent server leaves the socket `CONNECTING` for the whole 6 s observed.                                                       | `handshakeTimeout` honoured (`Opening handshake has timed out`). |

The Bun half runs on every CI build as
`packages/core/src/cp/infrastructure/transport/__tests__/OCPPWebSocket.wsOptions.bun.test.ts`,
including a canary for the two options Bun ignores: if a Bun release starts
honouring one, that test fails and the matrix in
[`WsClientOptions.ts`](../../packages/core/src/cp/shared/WsClientOptions.ts)
is corrected.

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
  [charging session](charging-sessions.md) stays `active`. An `Ended`
  event goes out once its transaction ended: both stay ended. OCPP-J 1.6
  does the same since #527 (see
  [the 1.6 section](#transaction-message-retries-ocpp-j-16));
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
30 s CALL timeout), read at each transmission; it is also the time after
which an unanswered CALL frees the [one-CALL-in-flight slot](#one-call-in-flight-on-2x-ocpp-j-411). The CSMS addresses it as
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

A waiting resend holds back the next TransactionEvent (E13.FR.03/04: "continue
with the next transaction-related message"), so `Ended` does not overtake a
resent `Started` ([one CALL in flight](#one-call-in-flight-on-2x-ocpp-j-411)).
When
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
  anew. A row stays in the table (and so survives a crash) until the CSMS
  answers the replay or the event is discarded after
  `MessageAttempts[TransactionEvent]` failures (#554); a close before the
  answer hands the same row back to the queue, in its place, instead of
  adding a second one. After a restart every remaining row replays again
  with `offline: true`, so the CSMS may see an event twice and
  de-duplicates by `transactionId` and `seqNo`. A replay the socket
  refuses while the connection stays up (a network-sim refusal or
  overflow) stays at the head of the queue, with a `warn` (category
  `TRANSACTION`); the replay stops there, and that row, the rows behind it
  and any new TransactionEvent wait for the next BootNotification
  `Accepted`.
- **Rows of the other protocol are dropped.** 1.6 and 2.x share
  `pending_messages` by charge point id, and `cp.update` can switch
  `ocppVersion` over the same `--state-db`. When a handler starts, its
  queue deletes every row it does not replay, with one `warn` (category
  `OCPP`) listing them: the 2.x handler anything but `TransactionEvent`,
  `NotifyEvent` and `SecurityEventNotification`, the 1.6 handler anything but
  StartTransaction, StopTransaction and MeterValues. Such a row never holds back a new
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
- **SecurityEventNotification** (#552): a critical security event
  (A04.FR.02, Appendix 1; the list is in
  [Security profiles](security-profiles.md#ocpp-201-and-21-behaviour)) produced
  while offline is queued too and replayed in the same pass, in production
  order, as built: the request carries the time of the event and no `offline`
  marker. A queued security event never holds a live TransactionEvent back; a
  refused replay stays at the head. A replayed row (and a NotifyEvent row) stays in the queue until the CSMS answers: a close while the CALL waits for the one-CALL slot, or before the answer, puts it back for the next replay (#664), and a critical event written online but unanswered at a close is queued the same way. At most 1000 are kept per charge point.
- **Other 2.x messages are not queued.** StatusNotification, Heartbeat,
  MeterValues, the NotifyEvents above the severity and the rest are
  dropped while offline, as before. `OCPPCommCtrlr.QueueAllMessages` (optional, not implemented) is
  what would queue them; when it is false the spec queues only
  transaction-related messages "as required in: E04.FR.01" (2.0.1
  §2.1.9, 2.1 §2.1.10). The spec sets no order between the replay and the
  other messages sent after reconnecting. The station sends its post-boot
  StatusNotifications first, then the replay, as on 1.6
  (`ChargePoint.markBootAccepted` defers the flush to a microtask).

- **Size limit** (#554, E11.FR.04 / E11.FR.05). The simulator key
  `OfflineQueueMaxEvents` (2.x only, ReadWrite, default `1000`, `0` = no
  limit; not an OCPP variable, the spec sets none for the size, and it is
  not in the device model, so a CSMS cannot reach it with
  `GetVariables` / `SetVariables`: set it in the simulator's own
  configuration) bounds the
  TransactionEvents in the queue, rows whose replay awaits an answer
  included. With the queue full, only `Updated` events are dropped; `Started`
  and `Ended` never are. E11.FR.05 fixes the order: intermediate messages
  first (the 2nd, 4th, 6th, ...), "not start dropping messages from the
  start or stop adding messages to the queue". The simulator therefore
  thins: the candidates are the idle queued `Updated` rows in queue order
  (`D`), a per-outage cursor `k` (starting at 1) picks `D[k]` and advances,
  and since the list shifts left after each drop the drops fall on the 2nd,
  4th, 6th, ... original rows. At the end of `D` the cursor wraps to 1,
  which halves the density again; the cursor resets at the replay. The
  first queued `Updated` goes only when it is the only candidate (a queue of
  `Started` and one `Authorized` `Updated` makes room for a new periodic
  sample by dropping the `Authorized` one). A new event is always queued,
  except that a new `Updated` is dropped itself when no idle queued
  `Updated` exists; a new `Started` or `Ended` is queued past the limit with
  a `warn`. Each insert drops until the queue is under the limit again, so
  a queue left above it (events queued past the limit, rows loaded after a
  restart) shrinks back. A row whose replay awaits its answer is not
  dropped. A dropped event leaves a gap in the `seqNo` of its transaction,
  which is how the CSMS sees the loss. One `warn` (category `TRANSACTION`)
  at the first drop of an outage, naming the first dropped event, one with
  the count at the replay.
- **E14 `GetTransactionStatus`** (#554): `messagesInQueue` is `true` while a
  TransactionEvent of the asked `transactionId` (of any transaction when the
  request names none) is still to be delivered: queued, replayed but not
  yet answered, or live and not yet settled (awaiting its answer or the
  wait for an E13 resend). It is `false` once the CSMS has answered them all
  or they were discarded. `ongoingIndicator` is only sent for a request with
  a `transactionId`: `true` while that transaction has not stopped
  (E14.FR.02), `false` for a stopped or unknown one (E14.FR.01/03); without
  an id it is omitted (E14.FR.06, #700).

Limits:

- The replay goes out as a burst: 2.x has no serial queue (see the known
  limitation above), so the station does not wait for one answer before
  sending the next replayed event.
- A live event (never queued) that is written and unanswered when the
  process crashes is lost: only the E11 queue is durable. A replayed event
  is durable until answered (#554), as the E04 failure postcondition asks.
- A restart replays the queued events, but the 2.x `transactionId` and
  `seqNo` counter of a transaction restored after the restart are not
  persisted, so its later events do not continue the replayed ones.

## OCPP-J 1.6 triggered status notifications

A triggered `DiagnosticsStatusNotification`, `FirmwareStatusNotification`,
`LogStatusNotification` or `SignedFirmwareStatusNotification` reports what the
station is doing, not a fixed `Idle` (#730; 1.6 §4.4, §4.5, security whitepaper
L01.FR.28/29, N01.FR.12). The status comes from the last one the engine sent
(`ChargerState`):

| Trigger                                              | Busy: reported as it is                                        | Otherwise |
| ---------------------------------------------------- | -------------------------------------------------------------- | --------- |
| `TriggerMessage(DiagnosticsStatusNotification)`      | `Uploading`                                                    | `Idle`    |
| `TriggerMessage(FirmwareStatusNotification)`         | `Downloading`, `Downloaded` (waiting to install), `Installing` | `Idle`    |
| `ExtendedTriggerMessage(LogStatusNotification)`      | `Uploading`, with the GetLog `requestId`                       | `Idle`    |
| `ExtendedTriggerMessage(FirmwareStatusNotification)` | the last sent status with its `requestId`, unless `Installed`  | `Idle`    |

## Transaction message retries (OCPP-J 1.6)

OCPP 1.6 Part 2 §3.7.1 lets a charge point skip a transaction-related
message only when the Central System repeatedly fails to process it: the
station "SHOULD send this message again" until it has met as many failures
as `TransactionMessageAttempts`, waiting before each retransmission
`TransactionMessageRetryInterval` seconds "multiplied by the number of
preceding transmissions", then "SHOULD discard the message and continue with
the next transaction-related message". §4.8 adds that failing to answer a
StartTransaction.req "will only cause the Charge Point to try the same
message again". OCPP-J 1.6 reports such a failure as a CALLERROR.

Since #527 the 1.6 station follows it for StartTransaction.req,
StopTransaction.req and a MeterValues.req carrying a `transactionId`, the
same way 2.x handles a TransactionEvent (above). It used to abandon the
transaction on a StartTransaction CALLERROR (#447) and to ignore one on the
other two. Now it:

- **keeps the transaction running** on a StartTransaction.req or
  MeterValues.req CALLERROR, and the
  [charging session](charging-sessions.md) stays `active`. A
  StopTransaction.req goes out once its transaction stopped: the
  transaction and its session stay ended, and the retry only resends the
  message;
- **emits `transactionMessageRejected`** (`connectorId`, `transactionId`,
  `action` `StartTransaction` / `StopTransaction` / `MeterValues`, `reason`
  `callError`, `errorCode`, `attempt`; no `eventType`) on every CALLERROR;
- **resends the same payload** under a new message id, through the §4.1.1
  serial queue, after `TransactionMessageRetryInterval` seconds times the
  number of transmissions so far: 60 s, then 120 s with the default of 60;
- **discards the message after `TransactionMessageAttempts` transmissions
  in all** (default 3) and emits `transactionMessageDiscarded` (`attempts`
  instead of `attempt`).

A CALLRESULT ends the retries, and an answer to a resend goes through the
normal StartTransaction.conf handling (`transactionId`, `idTagInfo`). Both
keys are read at each CALLERROR, so a ChangeConfiguration applies to the
next one, and the attempts key also before each resend or replay (below); an
attempts value below 1 counts as 1, a negative interval as 0.

StartTransaction.req carries no transaction id: its events report the
placeholder `transactionId` `"0"`. Once it is discarded the transaction
runs on without an id, and its MeterValues.req and StopTransaction.req carry
`transactionId: -1`: 1.6 errata 3.18 (added in errata sheet v4.0) says "the
Charge Point SHALL send any Transaction related messages for this transaction
to the Central System with a transactionId = -1" when it "was unable to
deliver the StartTransaction.req despite repeated attempts". Before that the
station-side `0` stands in for the id, and a message built then takes the
id its conf assigns, or `-1` if the request is discarded, when it is
sent (below). A connector still in `Preparing` goes to `Charging` when the
request is discarded, as when `StopTransactionOnInvalidId` is false. Any
other status, such as one a scenario set meanwhile, is left alone. On 1.x,
`ConnectionTimeOut` does not
apply while the transaction runs, so it never moves a connector waiting in
`Preparing` for the conf to `Finishing`. On 2.x it maps to
`TxCtrlr/EVConnectionTimeOut`, which targets exactly a transaction started
before the cable is plugged in: it still fires while that transaction runs
and ends it (E03.FR.05, #549). Once a CALLERROR answered its
StartTransaction.req, while it is resent and after it is discarded, a
RemoteStopTransaction for id `0` is `Rejected`, with no
StopTransaction.req: the CSMS never issued that id (#491). A `0` the CSMS
did assign in a StartTransaction.conf is stopped as any other id (#328).
Unlock, Reset and the other stop paths stop the
transaction with one StopTransaction.req, and a
ChangeAvailability to `Inoperative` answers `Scheduled`.

A StartTransaction.conf belongs to the transaction its request started,
identified by the request's `idTag` and `timestamp`. So that the pair differs
between two transactions of one tag, a start on a connector gets a `startTime`
different from the previous transaction's there: a stop then a start in the
same millisecond sends a timestamp 1 ms later than the clock (#586; 1.x only,
2.x does not match on it). Only that collision bumps the time: a clock stepped
back is stamped as it reads. When it answers a resend
after that transaction stopped, or after another one began on the connector,
it is logged and ignored: neither the transaction id nor the connector
status changes, and a non-`Accepted` `idTagInfo` stops nothing. It still
updates the Authorization Cache, and its `transactionId` goes to the
StopTransaction.req and MeterValues.req of that transaction (below). OCPP-S
binds its StartTransaction answer the same way, though it never resends: a
slow HTTP exchange can return after the transaction stopped.

**Order of transaction messages (#565, §3.7).** OCPP 1.6 edition 2 §3.7: "The Charge Point SHOULD deliver transaction-related
messages to the Central System in chronological order", and "The delivery of
new transaction-related messages SHALL wait until the queue has been emptied".
§3.7.1 lets it skip a message only after the allowed failures, and the
errata (3.18) gives the messages of a transaction whose StartTransaction.req
was never delivered `transactionId = -1`. So the station holds back the
transaction-related messages (StartTransaction.req, StopTransaction.req and a
MeterValues.req of a transaction) that follow a message being resent:

- From the first CALLERROR of one until it settles, every transaction-related
  message the station builds waits behind it, whatever connector it is for
  (§3.7 is about the queue, not a transaction). A Heartbeat,
  StatusNotification, Authorize or other CALL that is not transaction-related
  is not held, as §3.7 allows. Messages already queued in the serial queue behind the
  failed CALL join the held ones, in order.
- The resend is **settled** when it is answered with a CALLRESULT, discarded
  (the last attempt failed, or `TransactionMessageAttempts` was lowered to
  below its count), dropped by a behavior's `beforeSend`, or times out (1.6
  does not retry a timeout). The held messages then go out in order, through
  the serial queue; if the first of them fails in turn, the rest wait again.
- A StartTransaction.req resend is therefore sent even if its transaction
  stopped meanwhile (a local stop, UnlockConnector, an EV disconnect, a
  Reset, a scenario's stop node): it reaches the CSMS **before** the
  StopTransaction.req, which closes the transaction it opens. Nothing is
  discarded for that reason any more.
- A StopTransaction.req or MeterValues.req takes its `transactionId` when
  it is written, not when it is built: the `transactionId` of the
  StartTransaction.conf of its transaction if it arrived before the request
  timed out, including a conf answering a request still in flight when the
  transaction stopped (the stop waits behind it in the serial queue); `-1` when
  the StartTransaction.req was discarded or timed out (1.6 does not resend a
  timeout, and a conf that still arrives later is applied to the messages sent
  after it). A StartTransaction.req that timed out also lets its transaction
  go on from `Preparing` to `Charging`, as after a discard. This also holds
  for a message salvaged to the offline queue.
- A transaction records `startUnanswered` from its start until a
  StartTransaction.conf assigns its id (persisted with the transaction, #727):
  its `0` is a placeholder, not an id the CSMS issued (errata 3.54: a CSMS may
  issue `0`, and then the flag is gone). A StopTransaction.req or
  MeterValues.req built for such a transaction while no StartTransaction.req of
  it is in flight, queued, waiting out a resend or in the offline queue (it
  was lost with a restart or a closed link, or it timed out) is built with
  `-1` (errata 3.18). A start is matched by connector, `idTag` and
  `timestamp`. RemoteStopTransaction naming `0` or `-1` for it is `Rejected`.
  A transaction persisted by a release before #727 holds `0` without the flag,
  so after the upgrade its `0` is taken for one the CSMS issued: its
  StopTransaction.req carries `0` and RemoteStopTransaction naming `0`
  matches it.
- A stop requested before the StartTransaction.req is queued (a
  `connectorStatusChange` listener of the `Preparing` status calling
  `stop_transaction`) waits for it, so on the wire the StartTransaction.req
  comes first and the StopTransaction.req takes its id (§3.7: transaction
  messages in chronological order). `-1` is for a Start nobody
  answered, not for one that has yet to be sent. 2.x is unchanged.
- A message moved from the serial queue to the hold keeps what the
  behaviors' `beforeSend` made of it (its `wire`), its attempt count and last
  error code: when released it goes back into the serial queue without being
  intercepted again. A message that was held before it ever reached the queue
  is intercepted once, when it is released.
- When the WebSocket closes, a resend and the messages held behind it go to
  the offline queue in that order (§3.7: "When offline, the Charge Point MUST
  queue any transaction-related messages"), and the replay after the next
  accepted boot sends the StartTransaction.req first. A stop or meter message
  still carrying `0` in the queue takes the id of the StartTransaction.req
  replayed before it for the same connector, so the order and the id
  survive a restart. The same holds when the resend falls due behind a closed
  boot gate.
- Held messages are kept in memory, like the resend itself: a process that
  ends without closing the socket loses them.
- Known gap: a resend that fails to be written (`write_failed`) on a live link
  is salvaged to the offline queue, which is replayed only after the next
  close and boot; transaction-related messages built meanwhile are not held
  behind it and go out first.

A resend still waiting when the WebSocket closes goes to the 1.6 offline
queue (§3.7), ahead of the CALLs still queued and the messages held behind
it, and is replayed after the
next accepted boot like any queued transaction message. So does a resend
that falls due while the boot gate is closed on a live link (a
BootNotification answered `Pending`, e.g. after a TriggerMessage). That
replay keeps its count, since §3.7.1 counts failures "for this message": it
is stored in `pending_messages.attempts`, survives a restart, and the message
is discarded after `TransactionMessageAttempts` transmissions however often
the link drops. A resend or replay that already met the limit, lowered while
it waited, is not sent: it is discarded with `transactionMessageDiscarded` (a
replay has no `errorCode`, the queue does not store it), and a
StartTransaction.req whose transaction still runs ends as after a last attempt;
the messages held behind it go out. A row stored by an older release holds `0` and replays as a first transmission,
as does any message never transmitted, whatever the limit. The replay goes out
right after the boot, without waiting out what was left of the retry interval.

A CALLERROR for a transmission that already timed out (the 30 s §4.1.1
watchdog) changes nothing: no resend and no event, since the station gave up on
it and 1.6 does not retry a timeout. Nor does it make the `0` placeholder one
a RemoteStopTransaction refuses, as above (the timeout itself does, through
`startUnanswered`: the transaction's messages then carry `-1`). A CALLRESULT arriving that late
still applies, to the transaction its request started.

Unlike 2.x
(#529), a message left unanswered is not retried: only a CALLERROR is.
A resend waiting out its interval is held in memory, like the CALLs in the
serial queue. It reaches the persisted offline queue only when the socket
closes, so a process that ends without closing it, such as a crash, loses
the resend.
An [expert call](expert-ocpp-calls.md) is never resent, and a MeterValues.req
without a `transactionId` is not transaction-related. OCPP-S 1.2 and 1.5 do
not retry: a SOAP Fault answering these messages is reported as an error and
the message is not sent again. Only the 1.6 errata sheet was checked, not the
1.2 and 1.5 specs. OCPP-S 1.6 retries; see the next section.

### Deviation: OCPP-S 1.6 retries after a SOAP Fault

The OCPP-S 1.6 errata sheet (v1.0, 2019-12-04) makes the SOAP Fault the way
to report a failure to process a message (3.1) and, in 3.2, replaces the
"SHOULD NOT resend" of its §4 with: "the sender SHOULD NOT resend the same
message, except transaction-related message, a Charge Point SHALL retry these
a couple of times". It also has the station send a simple message such as a
Heartbeat to tell a failure to process from a connection issue, and treats an
HTTP error status like a Fault. Since
[#585](https://github.com/shiv3/ocpp-cp-simulator/issues/585) the SOAP client
(`OCPPSoapHandler`, whose request chain lives in
[`soapRequestQueue.ts`](../../packages/core/src/cp/infrastructure/transport/soap/soapRequestQueue.ts))
does this on 1.6S for StartTransaction.req, StopTransaction.req and a
MeterValues.req carrying a `transactionId`:

- **A Fault or an HTTP error status** answering one is a failure to process.
  Before it counts, the station sends a Heartbeat through the request chain.
  If that Heartbeat is answered, even by a Fault or an HTTP error, the Central
  System is reachable and the failure counts. If it is not (a network error or
  a timeout) the failure is a connection issue: the message is dropped with a
  `warn`, as before, because SOAP has no offline queue. A network error or a
  timeout of the message itself is a connection issue too and is not retried.
- **`transactionMessageRejected`** is emitted on every counted failure, with
  `reason` `callError` and `errorCode` the Fault code (`SOAP Fault Receiver`)
  or `HTTP <status>`.
- **The resend** goes through the request chain after
  `TransactionMessageRetryInterval` seconds times the number of transmissions
  so far, with a new message id, and ends after `TransactionMessageAttempts`
  transmissions: `transactionMessageDiscarded` and a `warn`. Both keys are
  read at each failure, and a resend that finds the attempts limit lowered is
  discarded.
- **A StartTransaction.req whose transaction no longer runs** is discarded
  instead of resent (SOAP-only behaviour; OCPP-J resends it and sends the
  Stop behind it, #565): a conf the station would ignore would leave a
  transaction open on the Central System. A discarded
  StartTransaction.req leaves the `0` placeholder and a connector still in
  `Preparing` goes to `Charging`. SOAP does not send `-1` yet: #727 covers
  OCPP-J.
- **Stop and dispose** (`onWebSocketClosed`) cancel every waiting resend, each
  with a `warn` and a `transactionMessageDiscarded`: SOAP has no offline queue
  to salvage it to. A failure whose Heartbeat probe is still in flight at that
  moment schedules nothing.

Two limits are SOAP-only (#839): a waiting resend does **not** hold back the
next transaction message (OCPP-J does since #565, §3.7 chronological order),
and a crash loses the resend. The boot gate's triggered-message exception
(#725, below) is OCPP-J only: SOAP has no `runTriggered`, so a message
triggered while a 1.6S boot is `Pending` is dropped.

## OCPP-J 1.6 boot gate (§4.2)

Outgoing CALLs follow the status of the last `BootNotification.conf`
(`BootGate`): `Accepted` lets everything out; before the first answer and while
`Pending` only `BootNotification` goes out, and while `Rejected` nothing does
until the retry interval has passed. One exception (#725): §4.2 lets a
`Pending` station send what the CSMS "instructed ... with a TriggerMessage.req",
so the CALL that follows an accepted `TriggerMessage` or `ExtendedTriggerMessage`
(StatusNotification, Heartbeat, MeterValues, the status notifications) passes
the gate while `Pending`. Anything not triggered (transaction messages, status
changes, heartbeats) stays suppressed, and a `Rejected` station sends nothing
even when triggered.

## OCPP-J 1.6 boot gate (§4.2)

Outgoing CALLs follow the status of the last `BootNotification.conf`
(`BootGate`): `Accepted` lets everything out; before the first answer and while
`Pending` only `BootNotification` goes out, and while `Rejected` nothing does
until the retry interval has passed.

Inbound CALLs are gated too (#726). §4.2: "While Rejected, the Charge Point
SHALL NOT respond to any Central System initiated message", so from a
`Rejected` answer until the retry interval has passed the station sends no
CALLRESULT or CALLERROR for a CSMS CALL and runs nothing (a `Reset` does not
reboot). The CALL is announced, logged (`Boot Rejected (§4.2): ignored …`) and
shown on the timeline as unanswered. When the retry BootNotification is due the
station answers again. Pending and Accepted answer as usual. There is no
opt-out.

## OCPP 2.x Reset OnIdle

For OCPP 2.0.1 and 2.1, `Reset` with `type: OnIdle` is answered `Accepted` and
reboots after the CALLRESULT when its target is already idle. If a targeted
connector has a running transaction, it is answered `Scheduled`; the station
queues that reset and boots when the last transaction in that reset's scope
ends. A station-wide reset waits for all connectors, while an EVSE-scoped reset
waits only for that EVSE. Multiple scoped resets remain independent, and an
Immediate reset supersedes only pending resets in the scope it resets.

An EVSE-scoped reset (`evseId`, B11.FR.08) does not reboot the station: it ends
that EVSE's transaction, reports the EVSE `Unavailable` and then in the state it
had (`Reserved` and an Inoperative `Unavailable` are kept, B11.FR.02/05), and
sends no BootNotification. That holds for an OnIdle reset that ran later too
(#699). Only a reset without `evseId` reboots and cold-boots (B11.FR.03/04).

The decision uses whether a transaction is actually running, not whether a
stopped transaction object is still attached to the connector. The queue is
also rechecked after adding a scheduled reset and after connector removal, so a
transaction ending while the response is in flight cannot strand the reset.
An `Inoperative` availability change scheduled during a transaction remains
`Unavailable` after the accepted reboot and continues to reject new local
transaction starts.

## Periodic meter values in a 1.x transaction (`MeterValueSampleInterval`, #722)

OCPP 1.6 Part 2 §3.16.1 and §9.1.19: `MeterValueSampleInterval` is the
interval between samples, "transmitted periodically at this interval from the
start of the charging transaction", and `0` means no sampled data is
transmitted. Errata sheet 3.15 (to §4.7) makes it mandatory: "When the value of
the configuration variable MeterValueSampleInterval and/or
ClockAlignedDataInterval has been set to a value greater than zero, the Charge
Point SHALL send MeterValues at the given interval(s)." While a transaction
runs and the value is greater than zero, the charge point therefore sends a
`MeterValues.req` every `MeterValueSampleInterval` seconds, with the
transaction id, `context` `Sample.Periodic` and the `MeterValuesSampledData`
measurands. This applies to every 1.x version, SOAP included. The default is
`60` (the 1.6 specification names no default; this is the simulator's), so a
default 1.6 transaction now sends one sample a minute (a wire change from the
earlier "nothing unless an auto-meter is configured"); `0` sends none.

- The value is read when the transaction starts, or when it is restored after
  a daemon restart, and again when a `ChangeConfiguration` of the key arrives
  mid-transaction (#839): the running samplers start over with the new
  interval (a new phase), and `0` stops them. A connector removed meanwhile
  loses its sampler. The specification does not say when the interval is
  read; "every `MeterValueSampleInterval` seconds" is why a change applies at
  once.
- It does not matter what drives the register. A configured auto-meter curve
  or increment fallback only moves the register at its own interval (the
  curve's `intervalSeconds`); the sample goes out on the
  `MeterValueSampleInterval` tick, so there is one sample per tick and not two
  schedules. A scenario's own meter strategy (a `meterValue` node with
  auto-increment) keeps sending at its own interval, so a scenario that
  auto-increments sends both.
- Offline, the sample is queued like any transaction-related message (§3.7:
  "When offline, the Charge Point MUST queue any transaction-related messages",
  "periodic or clock-aligned MeterValues.req" included) and delivered in order
  after the reconnect.
- A transaction whose StartTransaction.req was answered with a CALLERROR
  (#527) is sampled too (errata 3.15 asks for every interval). While a
  StartTransaction.req of the transaction is still on its way a sample carries
  the placeholder `0`, which its conf replaces when the sample is sent; once
  none is (timed out, discarded, lost in a restart) it carries `-1` (#727).
- Only 1.x: the 2.x sampling below is unchanged.

## Reconnect without BootNotification (OCPP 2.x, #702)

OCPP-J 2.0.1 §5.4: when reconnecting, a charging station "SHOULD NOT send a
BootNotification unless one or more of the elements in the BootNotification
have changed". On 2.0.1 and 2.1 the station follows it. The transport's
automatic reconnect after a connection loss (a CSMS close, a network-sim cut)
reopens the socket and **sends no `BootNotification`** when

- the last `BootNotification` was `Accepted` and the boot data is unchanged, and
- `BootOnReconnect` (a 2.x simulator key, default `false`) is not `true`.

A first connect, an operator `connect()`, a `Reset`, a boot that a closed
socket lost, a last boot that was `Pending` or `Rejected`, and changed boot data
all still send it, and so does `TriggerMessage(BootNotification)` while the boot
is not `Accepted` (after an `Accepted` boot the request is answered `Rejected`,
F06.FR.17, so a resumed link rejects it too). OCPP 1.x and SOAP always boot on
connect: that is a deliberate choice of the simulator, not something the spec
requires (OCPP-J 1.6 §5.4 carries the same "should not send" sentence); the
issue is 2.x-only and the 1.6 certification flows rely on the boot.

Instead the station resumes what an accepted boot starts (B04, E11):

- **Status reports.** The connection loss made the idle connectors `Unavailable`
  locally only. Each connector's status is derived again from its state: one
  the loss made `Unavailable` gets the status it had back (`Reserved` only
  while its reservation is still held, else `Available`), one made
  `Inoperative` meanwhile stays `Unavailable`, and a status changed during the
  outage (a plug-in, a stop) stands. A `StatusNotification` goes out for each
  connector whose status differs from what the CSMS last **answered**
  (B04.FR.02): a notification still in flight when the link closed counts as
  not delivered and is sent again. Statuses are compared as the 2.x wire
  carries them (`Preparing` and `Charging` are both `Occupied`). All
  connectors are reported when the outage lasted longer than
  `OCPPCommCtrlr.OfflineThreshold` seconds (B04.FR.01; key
  `OfflineThreshold`, 2.x only, default `60`, the spec gives none). The
  station scope is never reported on 2.x
  ([connectors only](#ocpp-2x-statusnotification-reports-connectors-only)).
- **Reservations** survive the loss with their expiry (a link loss is not a
  reboot, and B01.FR.13 even keeps `Reserved` across a reboot). A `Reset` still
  drops them, as before: persisting a reservation across a reboot is not
  modeled. Station-level charging profiles (connectorId 0) are cleared by the
  teardown (`ConnectionClosed`) but restored by the resume, minus those whose
  `validTo` passed during the outage (#799): without a boot the CSMS has no cue
  to push its limits again. A connection loss that ends in a boot (first
  start, `Reset`, a changed boot data or `BootOnReconnect`) still leaves them
  cleared; connector and transaction profiles stay.
- The heartbeat timer (with the interval in force), the clock-aligned samples
  and the variable-monitoring reports are re-armed.
- The [E11 queue](#e11-offline-queue-for-transactionevent) is replayed after
  the status reports, as after an accepted boot.

`connected` is emitted as always; no `boot_notification` event follows it on
such a reconnect, and the [operational timeline](operational-timeline.md)
records `reconnected_without_boot` (`offlineMs`, `reportedAll`) in its place.

## OCPP 2.x BootNotification reason

`BootNotificationRequest.reason` (B01.FR.09, `BootReasonEnumType`) carries the
cause of the boot (#691). `ChargePoint.boot(reason)` remembers it until the
boot is `Accepted`, so a retry after `Rejected` repeats it; an accepted boot
falls back to `PowerUp`, which is also the reason of a plain (re)connect.

| Cause                                                                         | `reason`         |
| ----------------------------------------------------------------------------- | ---------------- |
| First boot, a reconnect that boots, renewed-certificate reconnect (A02.FR.08) | `PowerUp`        |
| CSMS `Reset` (Immediate, or OnIdle with an idle target)                       | `RemoteReset`    |
| `Reset` OnIdle that was answered `Scheduled` and ran later                    | `ScheduledReset` |
| CSMS `TriggerMessage(BootNotification)`                                       | `Triggered`      |
| Control-plane reset (`cp.reset`, CLI / web console)                           | `LocalReset`     |

OCPP 1.6 has no `reason` field and is unchanged.

## Units of 2.x meter value samples

On OCPP 2.0.1 / 2.1 every sample in `MeterValues` and in a `TransactionEvent`'s `meterValue` carries `unitOfMeasure.unit`, except `Power.Factor`, which is unitless. Part 2 Appendices ch. 2 makes `Wh` the default of `unit`, so a sample without one reads as watt-hours: a 50 Hz `Frequency` sample used to be read as 50 Wh (#713). The unit comes from the measurand (`unitOfMeasurandV2x` in `MeterValueBuilder.ts`): `Hz` for `Frequency`, `A` for `Current.*`, `W` / `var` for `Power.Active.*` / `Power.Reactive.*`, `Wh` / `varh` / `VAh` for `Energy.Active.*` / `Energy.Reactive.*` / `Energy.Apparent.*`, `V`, `Percent` for `SoC`. The signed energy register reports `kWh`. OCPP 1.6 output is unchanged: 1.6 has no `Hz`, so `Frequency` stays without a unit there (errata 3.86).

## Measurand lists on 2.x

`SampledDataCtrlr.TxUpdatedMeasurands` and `AlignedDataCtrlr.Measurands` are MemberLists over `MeasurandEnumType`. On OCPP 2.0.1 / 2.1 `SetVariables` checks every member against the enum of the station's version (the vendored Part 3 schema): a member outside it (`Temperature` and `RPM` are 1.6 measurands, `Foo` is nothing) answers `attributeStatus: Rejected` with `attributeStatusInfo.reasonCode: InvalidValue` (B05.FR.07) and keeps the previous list. An empty list is valid. The same list still reaches the station by other routes (persisted state, scenarios, `a sample override), so the 2.x handler also drops measurands outside the enum before it builds a sample and logs a warning: a schema-invalid `MeterValues`or`TransactionEvent` `meterValue`is never sent (#714). OCPP 1.6 is unchanged:`ChangeConfiguration`still accepts`Temperature`and`RPM`. Code: `transport/v201/measurandEnum.ts`, `setVariablesV201.ts`.

## OCPP 2.x StatusNotification reports connectors only

B01.FR.05 sends a StatusNotification "for each Connector", and G03 / G04
Note 2 say the message only supports connector statuses; EVSEs and connectors
are numbered from 1. The 2.0.1 / 2.1 station therefore sends no
StatusNotification for the station scope (the OCPP 1.6 `connectorId` 0 main
controller, formerly `{ evseId: 0, connectorId: 0 }`) after boot, after a
station-wide ChangeAvailability or for a `TriggerMessage(StatusNotification)`
without an EVSE (#703). OCPP 1.6 `connectorId: 0` is unchanged. Station
availability is not reported separately; a `ChargingStation.AvailabilityState`
NotifyEvent (G04.FR.05, a MAY) is not sent.

## One CALL in flight on 2.x (OCPP-J §4.1.1)

OCPP-J 2.0.1 / 2.1 Part 4 §4.1.1: a Charging Station "SHALL NOT send a CALL message to the other party unless the CALL message it sent before has been responded to or has timed out". The 2.x handler (#708) keeps one slot per connection, as the 1.6 handler does with its serial queue:

- A CALL waits in the handler's queue until the slot is free. The slot is taken when the CALL is handed to the socket and freed by its CALLRESULT or CALLERROR, by `OCPPCommCtrlr.MessageTimeout` seconds after it was written (the pending entry stays, so a late answer is still recognised), by a write that failed, or by a close.
- Inbound CALLs are answered at once; their CALLRESULT/CALLERROR is not queued behind outgoing CALLs.
- Order is queue order, with one rule for TransactionEvent (E13.FR.03/04): a TransactionEvent does not go out while an older TransactionEvent waits out its `MessageAttemptInterval`, has a transmission queued or still awaits its answer. A resent `Started` is therefore never overtaken by `Ended`; other CALLs keep flowing meanwhile. A message discarded after its last attempt frees the next one.
- A CALL a caller gave up on (an [expert call](expert-ocpp-calls.md) whose wait ended) is taken out of the queue if it was not written yet.
- On a close, a TransactionEvent still in the queue is queued offline with the other unsettled ones, in creation order ([E11](#e11-offline-queue-for-transactionevent)); any other queued CALL is dropped and its caller told (`socket_closed`). A replay after Boot Accepted goes through the same queue, so the replayed events are sent one at a time.
- The write failures the socket reports while it stays open (a full network-simulation queue) free the slot and the next CALL goes on; a replayed TransactionEvent refused at the hand-over is held at the head of the E11 queue (#554), and one that waited for the slot and is refused only then keeps its row for the next replay.

There is no burst mode: OCPP 1.6 is serial too, and the spec has no exception.

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
- **`AlignedDataCtrlr.SendDuringIdle`** (2.x; configuration key
  `AlignedDataSendDuringIdle`, default `false`, #607): when `true`, no
  clock-aligned sample goes out for any EVSE or the main meter while **any**
  transaction runs on the station (neither `TransactionEvent(Updated)` nor
  `MeterValues`; J01.FR.20, the variable has no EVSE); with no transaction
  everything is sampled as before (2.0.1 Part 2 Appendices, AlignedDataCtrlr).
- Not implemented: connector 0 / `evseId` 0 (main meter) and per-period
  aggregation of `*.Interval` measurands.

## Periodic meter values in a 2.x transaction (#347)

OCPP 2.0.1 and 2.1 carry in-transaction sampled data
(`SampledDataCtrlr.TxUpdatedMeasurands`, mapped to `MeterValuesSampledData`)
in `TransactionEvent(Updated)`, and keep `MeterValuesRequest` for data
outside a transaction. The simulator's per-connector meter-value scheduler
sends `MeterValuesRequest` either way **by default**, because changing that
would change the wire for every existing 2.x integration.

A charge point created with `txUpdatedMeterValues: true` (`cp.create`,
`cp.update`, `cp.create_many`, the MCP `cp_create` tools) or with
`--tx-updated-meter-values` opts in. It is persisted with `--state-db`. The
[web console](../entities/web-console.md) has a checkbox for it on the Add and
Edit forms of an OCPP 2.0.1 / 2.1 charge point (#550); in Local mode it is a
setting of the shared config, so it applies to every browser charge point.

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

## Transaction-end meter data (#607)

What a billing CSMS reads from the start and end of a transaction. **Every
list below is empty by default and then the messages are byte-for-byte what
they were**: 2.x `Started` / `Ended` carry the register alone and 1.6
`StopTransaction` has no `transactionData` (unless signing adds the OCMF
entries, #315). All samples are formatted by the one MeterValues builder from
one operating point per sample, so a sample describes one instant (#327).

| Setting (1.x key / 2.x variable)                                                      | Effect when non-empty                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StopTxnSampledData` / `SampledDataCtrlr.TxEndedMeasurands`                           | 1.6: `Transaction.Begin` sample at start, `Sample.Periodic` samples on each scheduler tick, `Transaction.End` sample at stop, all in `StopTransaction.transactionData` (1.6 §3.16.1). 2.x: the `Transaction.Begin` reading taken at the start, the periodic samples and the `Transaction.End` sample in `TransactionEvent(Ended).meterValue` (so `TxEndedInterval` `0` gives Begin + End, E06.FR.11). Names outside `MeasurandEnumType` are refused by SetVariables (B05.FR.07) and never recorded. |
| `StopTxnAlignedData` / `AlignedDataCtrlr.TxEndedMeasurands`                           | `Sample.Clock` samples at clock-aligned boundaries during the transaction (1.6 §3.16.2), same carriers.                                                                                                                                                                                                                                                                                                                                                                                             |
| `TxStartedMeasurands` / `SampledDataCtrlr.TxStartedMeasurands` (2.x only)             | Extra samples with `Transaction.Begin` in `TransactionEvent(Started).meterValue`, beside the register.                                                                                                                                                                                                                                                                                                                                                                                              |
| `TxEndedInterval` / `SampledDataCtrlr.TxEndedInterval` (2.x only, seconds)            | Spacing of the periodic samples in `Ended`; `0` (default) keeps none. Judged at the scheduler tick, so it cannot be finer than the tick.                                                                                                                                                                                                                                                                                                                                                            |
| `AlignedDataTxEndedInterval` / `AlignedDataCtrlr.TxEndedInterval` (2.x only, seconds) | The clock-aligned grid of the `Ended` history; `0` (default) keeps none. 1.6 uses `ClockAlignedDataInterval`.                                                                                                                                                                                                                                                                                                                                                                                       |

- The 1.6 periodic samples are taken at every scheduler tick, the cadence of
  the MeterValues they accompany; a connector without a running scheduler
  records none.
- The 2.x `Started` / `Ended` register stays in kWh and is always sent first;
  a listed `Energy.Active.Import.Register` is not repeated.
- **`Transaction.End` is read at the stop instant**, from the operating point
  captured before the status write that leaves `Charging`, so its power equals
  the last periodic sample when the stop falls on a tick instead of reading 0
  from a connector already in `Finishing`.
- **The history is kept as formatted samples** on the transaction
  (`txEndedSamples`, at most 1,000, oldest dropped), persisted with the
  transaction (`transaction_json`, no schema change). A later change of a
  measurand list cannot reformat what was already taken.
- Not covered: SOAP (1.2 / 1.5 / 1.6S) keeps its `StopTransaction` without
  `transactionData` samples.

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

## OCPP-J 1.6 TriggerMessage and a connector that does not exist

§5.17: "the Charge Point SHALL indicate whether it will send it or not". On 1.6J
`TriggerMessage` and `ExtendedTriggerMessage` for `StatusNotification` or
`MeterValues` with a `connectorId` above 0 that names no connector are answered
`Rejected` and nothing is scheduled (#738). Connector 0, an absent
`connectorId` and the messages that take no connector (Heartbeat,
BootNotification, the status notifications) behave as before: a
`TriggerMessage(Heartbeat, connectorId 99)` still sends the Heartbeat.

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
bun apps/cli/src/main.ts \
  --cp-id CP-001 --ocpp-version OCPP-1.2 \
  --ws-url http://csms-host:8180/services/CentralSystemService \
  --soap-callback-url http://this-host:9700/ocpp/soap/CP-001/ChargePointService \
  --json
```

OCPP 1.2 has a narrower message surface: no DataTransfer (a `data_transfer` command is refused there, #348), GetConfiguration,
LocalAuthList, or Reservation messages; status values are limited to a 4-value set.

**OCPP 1.5:**

```bash
bun apps/cli/src/main.ts \
  --cp-id CP-001 --ocpp-version OCPP-1.5 \
  --ws-url http://csms-host:8180/steve/services/CentralSystemService \
  --soap-callback-url http://this-host:9700/ocpp/soap/CP-001/ChargePointService \
  --json
```

**OCPP 1.6 (SOAP):**

```bash
bun apps/cli/src/main.ts \
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

### SOAP and behaviors

[Behaviors and the charger engine](charger-engine.md) reach a SOAP station only in part:

- **`replace` does not work.** A scenario `csmsCallTrigger` with `behavior: "replace"` fails the run when the node
  arms (`behavior "replace" needs an OCPP-J station`); it never falls back to the default silently.
- **`beforeSend` is refused.** A behavior that has a `beforeSend` table is refused at load on a SOAP station
  (`Behavior x uses beforeSend, which needs an OCPP-J station`). Event hooks beyond `connected` / `disconnected` are
  not exercised on SOAP.
- **Defaults bypass the gate.** A SOAP station answers CSMS operations with the same default behaviors
  ([list](../entities/default-behaviors.md)), but they do not go through the inbound gate, so no policy, override or
  rule applies to them ([who answers a CALL](call-precedence.md)).

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

## Temperature unit spelling on OCPP-J 1.6

The `Temperature` measurand carries `unit: "Celcius"` on OCPP-J 1.6 `MeterValues.req` — the spelling of the original JSON schemas, which OCPP-J 1.6 errata (2025-04) §2.1 advises Charge Point implementers to keep, because a Central System validating against the original schema rejects `Celsius` (#745). The vendored schema accepts both. OCPP-S 1.6 (the WSDL says `Celsius`) and OCPP 2.0.1 / 2.1 send `Celsius`. The conversion is `toOcppJ16Wire` in `MeterValueBuilder.ts`, applied only by the 1.6J handler; a future sampled `transactionData` in `StopTransaction.req` must use it too.

## Inbound CALL validation on OCPP-J 1.6

An inbound CALL on an **OCPP 1.6J** charge point is checked against the vendored 1.6 request schema for its action (#593). The setting `inboundValidation` has three values. Set it with `--inbound-validation <off|warn|enforce>` ([CLI](../entities/cli.md), [daemon](../entities/daemon.md)), the `inboundValidation` field of `cp.create` / `cp.update` ([control plane](control-plane.md#cpcreate-parameters)), or, from library code, the `ChargePoint` transport option and `ChargePoint.setInboundValidation()`. The CLI persists it with `--state-db` ([State persistence](state-persistence.md)); a row from before the column restores as `warn`.

| Value     | A schema-invalid CALL                                                                         |
| --------- | --------------------------------------------------------------------------------------------- |
| `off`     | is not checked; the handler runs                                                              |
| `warn`    | (default) is logged as a warning and **traced**; the handler still runs and answers as before |
| `enforce` | is answered with a CALLERROR (OCPP-J 1.6 §4.2.3) and the handler does not run                 |

The error code follows the first kind of violation, most structural first (formats count, as for 1.6-S):

| Code                           | When                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `FormationViolation`           | the payload is not an object, has a property the schema does not declare, or breaks the structure otherwise |
| `OccurenceConstraintViolation` | a required field is missing, or an array has too few or too many items                                      |
| `TypeConstraintViolation`      | a field has the wrong JSON type                                                                             |
| `PropertyConstraintViolation`  | right type, invalid value: enum, range, length, pattern, `date-time` / `uri` format                         |

The codes use the **1.6 spelling**: `FormationViolation` (2.x says `FormatViolation`) and `OccurenceConstraintViolation` (the 1.6 specification spells it with one `r`; 2.x corrected it). The CALLERROR description names the action and the failing properties, cut to 255 characters.

Validation runs after the [inbound gate](call-precedence.md): an inbound policy, a response override and a scenario or code rule answer first, so any of them can own a malformed CALL; it guards only what reaches the default handler. An action without a request schema is left to the handler lookup (`NotImplemented`). Wire behavior under `off` and `warn` is unchanged; the golden wire fixtures did not change.

**Tracing.** Under `warn` and `enforce` a violation is traced, not only logged: the inbound CALL's [trace record](trace-format.md#validation-violations-meta) carries `meta.validation = { mode, errorCode, description }` (the code is what `enforce` answers, and what `warn` would have). The charge point writes one structured `Inbound validation: {json}` line on the `WebSocket` log channel for it; `--trace-output` and the `logLinesToTrace` adapter turn it into the `meta` field. Under `off` nothing is checked and nothing is traced.

**With SmartCharging not advertised (#594).** `NotImplemented` (no handler) comes before validation, and the `NotSupported` that `SetChargingProfile` answers when `SmartCharging` is missing from `SupportedFeatureProfiles` comes from inside the handler. So on such a station, under `enforce`, an invalid `SetChargingProfile` payload gets the constraint-violation CALLERROR and a valid one gets `NotSupported`.

## OCPP 1.6 SetChargingProfile

`SetChargingProfile.req` on **OCPP 1.6J** (and 1.6-S, through the shared handler; #594):

- **Replacement.** A profile replaces the installed one with the same `chargingProfileId`, or with the same `stackLevel` and `chargingProfilePurpose`, in the same scope (the connector's profiles, or the station store for `connectorId` 0). The `charging_profile_applied` timeline event reports `replaced: true` only when the **same id** was updated; a profile displaced by the same-slot rule is named in `replacedIds` (and in the summary: "… applied …, replacing profile 1"), see [Operational timeline](operational-timeline.md#smart-charging-profiles). OCPP 2.x keeps replacing by id only.
- **TxProfile preconditions.** A `TxProfile` for a connector without a **running** transaction (one whose `stopTime` is still unset; a closed transaction that is still attached does not count) answers `Rejected`, and so does one whose `transactionId` is not the id of the connector's active transaction. A `TxProfile` without `transactionId` binds to the active transaction. Other purposes need no transaction.
- **Smart Charging disabled.** When the configuration key `SupportedFeatureProfiles` no longer lists `SmartCharging`, `SetChargingProfile`, `ClearChargingProfile` and `GetCompositeSchedule` are all answered with the CALLERROR `NotSupported` (OCPP-J 1.6 §4.2.3) rather than a `Rejected` / `Unknown` status. On **1.6-S** there is no CALLERROR: the SOAP server turns the same refusal into a generic SOAP Fault, `Dispatch error for SetChargingProfile: SmartCharging is not supported` (likewise for the other two operations). The key is read-only for a CSMS, so this is a station setting; the default list includes `SmartCharging`.

## Inbound CALL validation on OCPP 2.0.1 / 2.1

An inbound CALL on a 2.x charge point whose payload fails the request schema of its action is answered with a CALLERROR (always on; the `inboundValidation` setting is 1.6J only). The code follows OCPP-J 2.0.1 / 2.1 Part 4 §4.3 Table 8 (#715), using the same keyword mapping as [1.6J](#inbound-call-validation-on-ocpp-j-16), most structural first:

| Code                            | When                                                                        |
| ------------------------------- | --------------------------------------------------------------------------- |
| `FormatViolation`               | the payload is not an object, or has a property the schema does not declare |
| `OccurrenceConstraintViolation` | a required property is missing, or an array has too few or too many items   |
| `TypeConstraintViolation`       | a property has the wrong JSON type                                          |
| `PropertyConstraintViolation`   | right type, invalid value: enum, range, length, pattern                     |

The description names the action and the failing properties, cut to 255 characters (Part 4 §4.2.3). The check runs after the [inbound gate](call-precedence.md), so an inbound policy, response override or scenario rule still owns a malformed CALL. The code is classified against the request schema of the station's own version (the 2.1 schema on a 2.1 station, so a 2.1-only action gets the right code too, #750). Code: `codec/validateV2x.ts`, `codec/violationKind.ts` (shared with 1.6J).

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
