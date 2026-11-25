---
title: Reusable OCPP protocol stack
type: analysis
summary: Design for #978 — where the OCPP-J/SOAP protocol code lives today and what ties it to the simulator, the target modules (model, rpc, transports, toolkit), the seams to cut, what the new domain-free packages/ocpp-rpc proves and does not, decisions on the RFC's open questions, and the phase → issue plan.
sources:
  - "issue #978"
  - packages/ocpp-rpc/src/index.ts
  - packages/ocpp-rpc/src/RpcEndpoint.ts
  - packages/ocpp-rpc/src/frames.ts
  - packages/ocpp-rpc/src/dialects.ts
  - packages/ocpp-rpc/src/malformedFrames.ts
  - packages/ocpp-rpc/src/__tests__/RpcEndpoint.test.ts
  - packages/ocpp-rpc/src/__tests__/webSocket.bun.test.ts
  - scripts/check-package-boundaries.ts
  - scripts/check-direct-time.ts
  - packages/core/src/cp/infrastructure/transport/
  - packages/core/src/cp/infrastructure/transport/ws/wsNetworkSim.ts
  - "OCPP-J 1.6 specification §4.1.3, §4.2.3 and errata sheet §3.3"
  - "OCPP 2.0.1 Edition 4 and OCPP 2.1 Edition 2 Part 4 §4.1.3, §4.2.3, §4.2.4, §4.3, §4.4, errata 2026-09"
  - packages/trace/src/logEntryToTrace.ts
related:
  - ../concepts/ocpp-versions-and-transports.md
  - ../sources/vendored-ocpp-schemas.md
  - ../overview.md
  - ../concepts/network-simulation.md
  - ../concepts/trace-format.md
  - ../concepts/charger-engine.md
updated: 2026-11-24
---

# Reusable OCPP protocol stack

RFC [#978](https://github.com/shiv3/ocpp-cp-simulator/issues/978) asks to make
the simulator's OCPP stack reusable by other TypeScript applications (a gateway,
a TCK, a CSMS) without importing the simulator domain, incrementally, with the
simulator as the primary consumer. This page is the design that RFC asks for
first: the current state, the target modules, the seams to cut, the first
extracted package (`packages/ocpp-rpc`) and the follow-up issues. The versions
and transports themselves are described in
[OCPP versions and transports](../concepts/ocpp-versions-and-transports.md);
the model package's schemas in
[vendored OCPP schemas](../sources/vendored-ocpp-schemas.md); the workspace
rules in [Overview → package boundaries](../overview.md#source-layout-and-package-boundaries).

## Current state

All paths below are under `packages/core/src/cp/` unless stated otherwise.

| Concern                  | Where it lives                                                                                                                                                                                                                                                                                       | Simulator coupling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model                    | `packages/ocpp` (generated types, validators, vendored OCA schemas)                                                                                                                                                                                                                                  | None, but not publishable: private at `0.0.0`, exports `"./*": "./src/*.ts"`, extensionless relative imports, JSON imported without import attributes, `ajv` / `ajv-draft-04` declared only in the root manifest                                                                                                                                                                                                                                                                                  |
| OCPP-J frame codec       | `packages/ocpp-rpc` now; still re-implemented in `infrastructure/transport/ws/wsNetworkSim.ts` (`dispatchIncomingFrame`), `transport/network-sim/FrameContext.ts`, `RawFrameSender.ts` (`messageIdOf`), `packages/k6-runtime/src/frames.ts` and the mock CSMS helpers                                | `k6-runtime/src/frames.ts` is copied verbatim into a k6 export and must stay import-free                                                                                                                                                                                                                                                                                                                                                                                                          |
| Correlation and timeouts | `CallWaiters` (now a `realClock` subclass of ocpp-rpc's) covers only DataTransfer and expert calls (`ExpertCalls.ts`, `RawFrameSender.ts`); the real correlation is `transport/v16/serialCallQueueV16.ts` + `RequestHistory` (`v16/outboundRequestsV16.ts`) and `transport/v201/callPipelineV201.ts` | Both `SerialCallQueueV16` and `CallPipelineV201` hold a `ChargePoint`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| WebSocket transport      | `infrastructure/transport/OCPPWebSocket.ts` and `ws/` (opener, close handling, ping, `reconnectScheduler.ts`), `profile/subprotocols.ts`                                                                                                                                                             | `OCPPWebSocket` builds a `NetworkSimController` in its constructor; `domain/transport/ChargePointSocket.ts` mixes transport and fault control; `ws/reconnectScheduler.ts` arms raw `setTimeout` / `Date.now()`; the negotiated subprotocol (`ws/socketWrappers.ts`) is compared with the offered list after open ([#1061](https://github.com/shiv3/ocpp-cp-simulator/issues/1061), [WebSocket subprotocol check](../concepts/ocpp-versions-and-transports.md#subprotocol-the-csms-selected-1061)) |
| Fault vocabulary         | `CloseCause` and the `GenerationToken` interface in `domain/transport/networkSim.ts`, `Settlement` in `transport/network-sim/NetworkSimPipeline.ts`, `GenerationTokenImpl` in `ws/closeClassification.ts`                                                                                            | The WebSocket close path (`ws/closeHandler.ts`, `ws/connectionOpener.ts`) imports them through the `network-sim` barrel                                                                                                                                                                                                                                                                                                                                                                           |
| SOAP                     | `infrastructure/transport/soap/` (`soapEnvelope.ts`, `dialect.ts`, `OCPPSoapHandler.ts`, `OCPPSoapServer.ts`, `soapRequestQueue.ts`, `v16RegistryDispatch.ts`)                                                                                                                                       | Envelope and dialect code depend only on `fast-xml-parser` and `OcppVersion`, but that type lives in core's `domain/types/OcppVersion.ts`; the handler, server, queue and registry dispatch hold `ChargePoint`                                                                                                                                                                                                                                                                                    |
| Inbound dispatch         | `OCPPMessageHandler.ts`, `OCPPMessageHandlerV201.ts`, `inbound/InboundCallGate.ts`, `handlers/`                                                                                                                                                                                                      | Handlers receive the `ChargePoint`                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Observation              | `packages/trace/src/logEntryToTrace.ts` parses the `Sent: `, `Received: ` and `Inbound validation: ` log lines; `packages/trace/src/TraceCorrelator.ts` correlates the resulting records itself                                                                                                      | The protocol layer has to keep writing those exact log lines until a frame observer replaces them                                                                                                                                                                                                                                                                                                                                                                                                 |

Two constraints hold across every step:

- **Determinism.** Outgoing message ids come from the charge point's seeded
  `rng("message-id")` stream (`OCPPMessageHandler.ts`, `OCPPMessageHandlerV201.ts`),
  and timers from its `SimClock` ([Charger engine](../concepts/charger-engine.md#clock-and-random)).
  An extracted primitive never draws its own ids: the caller supplies them
  (`nextMessageId` has no default). Its timers are an injected clock that
  falls back to the platform timers when none is given, so it is deterministic
  only when the caller injects one, as the simulator does with its `SimClock`.
- **Byte-identical wire.** The golden-wire suite pins the frames the simulator
  writes; an extraction changes no byte and re-records no fixture.

## Target modules

The RFC's logical boundaries, with the network simulation kept on the
application side. "Module" is a logical boundary; whether each becomes an npm
package is open question 1 below.

| Module                | Responsibility                                                                                   | Status                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ocpp-model`          | Versioned types, schemas, enums, validation                                                      | `packages/ocpp`, unrenamed; publishable form is [#1053](https://github.com/shiv3/ocpp-cp-simulator/issues/1053)                                                         |
| `ocpp-rpc`            | Frame codec, CALL / CALLRESULT / CALLERROR correlation, timeouts, error-code dialects            | **`packages/ocpp-rpc`, consumed by core** (this page); the version-specific correlators move onto it in [#1054](https://github.com/shiv3/ocpp-cp-simulator/issues/1054) |
| `ocpp-transport-ws`   | Opening, subprotocol negotiation, security profiles 1–3, ping, reconnect primitive               | In core; [#1057](https://github.com/shiv3/ocpp-cp-simulator/issues/1057), after [#1056](https://github.com/shiv3/ocpp-cp-simulator/issues/1056)                         |
| `ocpp-transport-soap` | SOAP 1.2 envelopes, WS-Addressing, HTTP, the 1.2 / 1.5 / 1.6S dialects                           | In core; [#1058](https://github.com/shiv3/ocpp-cp-simulator/issues/1058)                                                                                                |
| `ocpp-toolkit`        | Charging station and CSMS APIs: handler registration, inbound dispatch, a `HandlerContext`       | In core; [#1059](https://github.com/shiv3/ocpp-cp-simulator/issues/1059)                                                                                                |
| `network-sim`         | Latency, loss, disconnects and modem state, as a decorator around a transport link (application) | In core, built inside `OCPPWebSocket`; becomes an injected decorator in #1056                                                                                           |

Dependency direction: `ocpp-rpc` → `ocpp-model`; each transport → `ocpp-rpc`
(WebSocket) or `ocpp-model` (SOAP); `ocpp-toolkit` → the transports; the
simulator → all of them, and only the simulator → `network-sim`.

## The seams

Each seam is a cut that removes one simulator dependency without changing
behaviour:

1. **An injected fault link.** `NetworkSimController` talks to the socket through
   its `ControllerHost` interface (`transport/network-sim/NetworkSimController.ts`),
   which `OCPPWebSocket` builds itself. Turning that host into a link the
   application wraps around the transport takes fault injection out of the
   transport (#1056).
2. **Split `ChargePointSocket`** into a transport port and a fault-control port, and
   move `Settlement` / `GenerationToken` / `CloseCause` out of the network-sim
   vocabulary into the transport's own close classification (#1056).
3. **A frame-observer port.** Trace and timeline consumers subscribe to sent and
   received frames instead of parsing log lines, which frees the protocol layer
   from the log format ([#1055](https://github.com/shiv3/ocpp-cp-simulator/issues/1055)).
4. **A generic correlator.** `SerialCallQueueV16` (1.6: transaction messages queued
   behind the one in flight, with retries) and `CallPipelineV201` (2.x: one CALL in
   flight, `MessageTimeout`)
   keep their version semantics but sit on ocpp-rpc primitives instead of holding a
   `ChargePoint` (#1054); `RawFrameSender` follows.
5. **A `HandlerContext` without `ChargePoint`.** Handlers get the payload, the message
   id and the services they need; the simulator adapts its `ChargePoint` to that
   context (#1059).

## `packages/ocpp-rpc`

`@ocpp-cp-simulator/ocpp-rpc` is the first extracted module: private, string
exports like its siblings, portable (no `bun:`, `node:` or `Bun.*`), and its only
workspace dependency is `@ocpp-cp-simulator/ocpp`, for the schema validator. Its
curated entry point is [`src/index.ts`](../../packages/ocpp-rpc/src/index.ts); the
manifest still exports `"./*"`, so every consumer imports
`@ocpp-cp-simulator/ocpp-rpc/index` by convention, not by enforcement.

| Export                                                                                            | What it does                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OCPPMessageType`, `encodeCall`, `encodeCallResult`, `encodeCallError`                            | Write the simulator's exact bytes: same key order, CALLERROR `details` default to `{}`                                                                                                                                                                                                           |
| `encodeCallResultError`, `encodeSend`                                                             | OCPP 2.1 CALLRESULTERROR (`details` default to `{}`) and SEND frames                                                                                                                                                                                                                             |
| `decodeFrame(raw, { ocpp21? })`, `decodeParsedFrame(parsed, raw, …)`                              | A typed `RpcFrame` or an `RpcDecodeError` (`not-json`, `not-array`, `invalid-message-type`, `unknown-message-type`, `invalid-message-id`, `invalid-action`, `invalid-error`, `wrong-length`, with the `messageId` and `messageType` it could read); never throws. The type is read before the id |
| `malformedFrameReply(error, dialect)`, `UNREADABLE_MESSAGE_ID`                                    | The CALLERROR a rejected frame is due, or `null` ([Malformed frames](#malformed-frames))                                                                                                                                                                                                         |
| `decodeFrame` and the OCPP 2.1 types                                                              | Decodes the 2.1 SEND and CALLRESULTERROR too, unless `ocpp21: false` (a 1.6 or 2.0.1 reader), which reads them as `unknown-message-type`                                                                                                                                                         |
| `CallWaiters`, `RpcClock`, `platformClock`                                                        | Pending-call registry with timeouts on a minimal `{ setTimeout, clearTimeout }` clock; defaults to the platform timers                                                                                                                                                                           |
| `RpcEndpoint`                                                                                     | One side of an OCPP-J link, station or CSMS alike: `handle(action, handler)`, `call(action, payload)`, `receive(raw)`, `close(reason)`; it owns no socket, `send` and `receive` are the link                                                                                                     |
| `RpcEndpoint` on OCPP 2.1, `RpcUnsupportedMessageTypeError`                                       | `send(action, payload)`, `sendCallResultError(…)`, `handleSend(action, handler)`, the `onCallResultError` option; on 1.6 and 2.0.1 the two writes throw the error                                                                                                                                |
| `OCPP16_RPC_DIALECT`, `OCPP2X_RPC_DIALECT`, `OCPP21_RPC_DIALECT`, `violationKind`                 | Each version's error codes (`FormationViolation` in 1.6, `FormatViolation` in 2.x, …), kept separate rather than generalized; only the 2.1 dialect has SEND and CALLRESULTERROR                                                                                                                  |
| `ocppSchemaValidator(version)`                                                                    | Adapts `@ocpp-cp-simulator/ocpp`'s validators to the endpoint's `validate` hook                                                                                                                                                                                                                  |
| `RpcCallError`, `RpcTimeoutError`, `RpcClosedError`, `RpcInvalidResponseError`, `RpcHandlerError` | The typed outcomes of `call`, and the error a handler throws to choose its CALLERROR                                                                                                                                                                                                             |

`RpcEndpoint` takes `send`, `nextMessageId`, `dialect` and optionally `clock`,
`callTimeoutMs` (default 30 s), `validate`, `onProtocolError` and
`onCallResultError`. Its contract:

- `nextMessageId` must never return an id twice for the endpoint's lifetime,
  timed-out calls included: a reused id lets a late answer to the old call
  settle the new one.

- A CALL with no handler is answered `NotImplemented` **before** validation runs.
  A CALL that fails `validate` is answered with the dialect's violation code and
  the validator's description.
- A handler that throws `RpcHandlerError(code, description, details)` is answered
  with that code; any other throw is answered `InternalError` with the generic
  description `Handler for <action> failed`, never the exception's message. So is
  an answer that cannot be encoded (a cyclic result or `RpcHandlerError`
  details), with empty details `{}`.
- `call` resolves with the CALLRESULT payload, or rejects with `RpcCallError`
  (CALLERROR), `RpcInvalidResponseError` (CALLRESULT failing `validate`),
  `RpcTimeoutError`, `RpcClosedError`, or the error `send` threw.
- Malformed frames, answers that match no pending call (including a late answer
  to a timed-out call) and answers `send` could not write (`reply-send-failed`)
  go to `onProtocolError`. A malformed frame is then answered with the CALLERROR
  `malformedFrameReply` gives, if any ([Malformed frames](#malformed-frames),
  [#1060](https://github.com/shiv3/ocpp-cp-simulator/issues/1060)); the rest are
  never answered.
- OCPP 2.1 message types ([#1118](https://github.com/shiv3/ocpp-cp-simulator/issues/1118))
  exist only on `OCPP21_RPC_DIALECT`. On the 1.6 and 2.0.1 dialects, an inbound
  type 5 or 6 stays an unanswered `unknown-message-type`, and `send` and
  `sendCallResultError` throw `RpcUnsupportedMessageTypeError` before an id is
  taken. On 2.1:
  - `send` writes a SEND under the next `nextMessageId` id, shared with CALLs
    (Part 4 §4.1.2). Nothing waits for it, so it may go while a CALL is in
    flight.
  - An inbound SEND goes to its `handleSend` handler, never to a CALL handler,
    and is **never answered** (§4.2.4). A missing handler, an invalid payload or
    a failed handler only reach `onProtocolError` (`unhandled-send`,
    `invalid-send`, `send-handler-failed`, with the violation or the error as
    `cause`).
  - An inbound CALLRESULTERROR goes to `onCallResultError` and settles no
    pending call: its id is the one of the peer's CALL.
  - A CALLRESULT that fails `validate` is **not** answered on its own (decided on
    #1066). `sendCallResultError` sends one on request, with the code the call's
    `RpcInvalidResponseError` carries.
- `close(reason)` rejects every pending call with `RpcClosedError`, and the endpoint
  then ignores frames and does not answer handlers that finish later.
- `ocppSchemaValidator` admits a payload on the lenient check (no `format`
  keywords), so a 1.6 `expiryDate: "not-a-date"` reaches the handler. Core mixes
  the two today (strict for 1.6 requests since #285, lenient admission for 2.x
  requests, warn-only for responses); the package's rule is settled with
  [#1059](https://github.com/shiv3/ocpp-cp-simulator/issues/1059), when core's
  inbound dispatch moves onto it.

**What core consumes today.** `transport/callFrame.ts` delegates to `encodeCall`;
`ws/frameSender.ts` writes CALLRESULT and CALLERROR with `encodeCallResult` /
`encodeCallError`; `domain/types/OcppTypes.ts` re-exports `OCPPMessageType`;
`transport/CallWaiters.ts` subclasses ocpp-rpc's `CallWaiters` with `realClock`
as its default `SimClock`; `codec/violationKind.ts` re-exports the classification
and `codec/validateV16.ts` / `validateV2x.ts` read the dialects' code tables.
Message ids and the three log lines are untouched, and the golden-wire suite
passed without a re-recorded fixture.

**Boundary enforcement.** `scripts/check-package-boundaries.ts` lists
`ocpp-rpc` as portable and lets it import `ocpp` only; a test case rejects an
`ocpp-rpc` → `core` import, which is the RFC's "no dependency on the simulator
domain" criterion made executable. `scripts/check-direct-time.ts` scans
`packages/ocpp-rpc/src/CallWaiters.ts` and `RpcEndpoint.ts`, so a direct
`setTimeout` there fails `bun run check:boundaries`; the platform default is
isolated in `platformClock.ts`.

## Malformed frames

[#1060](https://github.com/shiv3/ocpp-cp-simulator/issues/1060): what a peer
answers to an incoming text frame that is not OCPP-J for its version. Both
`RpcEndpoint.receive` and the simulator's inbound path
(`transport/ws/wsNetworkSim.ts`, `dispatchIncomingFrame`) apply the same rule,
`malformedFrameReply` in `packages/ocpp-rpc/src/malformedFrames.ts`, with the
version's dialect.

### What the specifications say

OCPP-J 1.6 (specification 2015-10-08, errata sheet 2025-04):

- §4.1.3: "When a server receives a message with a Message Type Number not in
  this list, it SHALL ignore the message payload."
- §4.2.3: "We only use CallError in two situations: 1. An error occurred during
  the transport of the message. […] 2. The call is received but the content of
  the call does not meet the requirements for a proper message. This could be
  missing mandatory fields, an existing call with the same unique identifier is
  being handled already, unique identifier too long, etc." Its UniqueId "must
  be the exact same id that is in the call request".
- Errata §3.3 adds to §4.2.3: "When a server needs to report a 'failure to
  process the message', the server SHALL use a Message Type: CallError
  (MessageTypeNumber = 4)."
- Table 7 has no RPC framework code: the closest are `FormationViolation`
  ("Payload for Action is syntactically incorrect or not conform the PDU
  structure for Action"), `ProtocolError` ("Payload for Action is incomplete")
  and `GenericError` ("Any other error not covered by the previous ones").
  1.6 says nothing about a frame whose id cannot be read.

OCPP 2.0.1 Edition 4 and OCPP 2.1 Edition 2, Part 4 (2025-12-03):

- §4.2.3 (both): situation 2 adds "invalid JSON or OCPP syntax etc."; "When a
  server receives a corrupt message, the CALLERROR SHALL NOT directly include
  syntactically invalid JSON (For example, without encoding it first). When
  also the MessageId cannot be read, the CALLERROR SHALL contain "-1" as
  MessageId." and "When a message contains any invalid OCPP and/or it is not
  conform the JSON schema, the system is allowed to drop the message."
- §4.3 Table 8 (both): `RpcFrameworkError` "Content of the call is not a valid
  RPC Request, for example: MessageId could not be read."; `ProtocolError`
  "Payload for Action is not conform the PDU structure"; `FormatViolation`
  "Payload for Action is syntactically incorrect"; `MessageTypeNotSupported`
  "A message with an Message Type Number received that is not supported by this
  implementation."
- §4.1.3 (both): "When a system receives a message with a Message Type Number
  not in this list, it SHALL ignore the message payload."
- §4.4 in 2.0.1 Edition 4: "When an OCPP 2.0.1 implementation receives a
  message with an unknown message type, it SHALL respond with an CALLERROR with
  errorCode: MessageTypeNotSupported." In 2.1 Edition 2, §4.4 instead repeats
  §4.1.3: ignore it.
- Errata 2026-09 for both editions: §4.4 is removed in 2.0.1 ("contradictory to
  section 4.1, which states to ignore unknown message types") and 2.1, and
  `MessageTypeNotSupported` is deprecated: "As of OCPP 2.1 a message type number
  that is not supported is silently ignored […]. This is therefore no longer a
  valid error code."
- 2.1 §4.2.4: "The receiver SHALL NOT respond to a SEND message with a
  CALLRESULT or CALLERROR message."

### Decision table

| Frame received                                                                             | 1.6                                             | 2.0.1                                 | 2.1                                      |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------- | ---------------------------------------- |
| Not JSON (`not-json`)                                                                      | `[4,"-1","GenericError",…,{}]`                  | `[4,"-1","RpcFrameworkError",…,{}]`   | `[4,"-1","RpcFrameworkError",…,{}]`      |
| JSON, not an array (`not-array`)                                                           | same                                            | same                                  | same                                     |
| First element missing or not a number (`invalid-message-type`)                             | CALLERROR under the id if readable, else `"-1"` | same, `RpcFrameworkError`             | same, `RpcFrameworkError`                |
| Numeric type not of this version: 1, 7, 2.5 … (`unknown-message-type`)                     | ignored                                         | ignored                               | ignored                                  |
| 5 or 6 (CALLRESULTERROR, SEND)                                                             | ignored (unknown type)                          | ignored (unknown type)                | decoded; malformed ones are not answered |
| CALL with an unreadable id: not a string, or `""` (`invalid-message-id`)                   | `[4,"-1","GenericError",…,{}]`                  | `[4,"-1","RpcFrameworkError",…,{}]`   | `[4,"-1","RpcFrameworkError",…,{}]`      |
| CALL with a missing or empty action (`invalid-action`), or not 4 elements (`wrong-length`) | `[4,"<id>","GenericError",…,{}]`                | `[4,"<id>","RpcFrameworkError",…,{}]` | `[4,"<id>","RpcFrameworkError",…,{}]`    |
| Malformed CALLRESULT or CALLERROR (any reason, `invalid-error` included)                   | not answered                                    | not answered                          | not answered                             |

`…` is a fixed description naming the problem (`Message is not valid JSON`,
`CALL does not have 4 elements`, …); the received frame is never echoed, so the
answer cannot carry invalid JSON. `errorDetails` is `{}`. A valid CALL keeps its
existing answers (`NotImplemented`, the violation codes, `InternalError`).

Decisions where the text is ambiguous or contradicts itself:

1. **Unknown message type: ignored on every version.** 1.6 §4.1.3, 2.0.1 / 2.1
   §4.1.3 and the 2026-09 errata say ignore; only 2.0.1 Edition 4 §4.4 (removed
   by the errata) asked for `MessageTypeNotSupported`. Ignoring also cannot loop
   between two peers that both reject the other's type.
2. **The RPC framework code on 1.6 is `GenericError`.** 1.6 has no
   `RpcFrameworkError`, and `FormationViolation` / `ProtocolError` describe the
   payload of an action, which a frame without a readable envelope does not
   have. 2.x uses `RpcFrameworkError` for every envelope problem, also for a
   CALL of the wrong length or without an action, rather than `ProtocolError` /
   `FormatViolation`, which Table 8 reserves for the payload.
3. **`"-1"` on 1.6 too.** 1.6 does not say which id answers an unreadable frame,
   while errata §3.3 makes a CallError the way to report a failure to process
   one. The 2.x rule is the same framework's later clarification and what CSMS
   implementations send in practice (`RawFrameSender` already accepts it), so
   1.6 follows it.
4. **Only a CALL, or a frame whose type cannot be read, is answered.** A
   CALLERROR is an "error response to a request message"; answering a broken
   CALLRESULT or CALLERROR with one would answer an answer, and a SEND is never
   answered (2.1 §4.2.4). A malformed CALLRESULT on 2.1 is not answered with a
   CALLRESULTERROR either: Part 4 allows dropping it, and
   `sendCallResultError` stays an explicit call (decided on #1066). Every reply
   is itself a well-formed CALLERROR, which the peer does not answer, so two
   such peers cannot loop.
5. **Not covered.** A message id longer than 36 characters, or an existing call
   with the same id, are 1.6 / 2.x §4.2.3 examples of situation 2 but are not
   checked by the codec; frames that pass `decodeFrame` keep their existing path.

**Simulator inbound path.** `dispatchIncomingFrame` still logs `Received:` first
and still offers every array of 3 to 5 elements to the #393 interceptor
(`RawFrameSender`) before checking it, so an expert raw send sees the same
replies as before. A frame `decodeParsedFrame` rejects is then logged as
`Invalid message format: <reason>`, never reaches the version's message handler,
and its CALLERROR, if due, goes out through `FrameSender.sendRaw`: the
network-simulation pipeline and the `Sent:` log line, like any other frame. The
dialect follows the station's version (`rpcDialectOf`). Before this change
every array of 3 to 5 elements reached the message handler, which ignored an
unknown type and took a three-element CALL for a CALL of the action
`CallResult`; the rest was logged and dropped. No golden wire fixture sends a
malformed frame, so none changed.

## What the proof proves

Tests in `packages/ocpp-rpc/src/__tests__/` import only the public entries of
`ocpp-rpc` and `ocpp`:

- two in-memory endpoints exchange an OCPP 1.6J and an OCPP 2.0.1
  `BootNotification`, validated on both sides with `ocppSchemaValidator`; the CSMS
  can call the station too;
- the CALLERROR paths: `NotImplemented`, `RpcHandlerError`, `InternalError`, a
  schema violation (`FormationViolation` for 1.6, `FormatViolation` for 2.0.1) and
  an invalid CALLRESULT;
- a timeout on an injected fake clock, a late answer reported as unmatched, close,
  and `send` failures on both sides;
- on an OCPP 2.1 dialect, in memory: a SEND sent while a CALL is in flight and
  never answered, whatever happens to it on the other side; an inbound
  CALLRESULTERROR that leaves a pending call with the same id alone; an explicit
  `sendCallResultError` after an invalid CALLRESULT; and on 1.6 and 2.0.1, types
  5 and 6 refused on the way out and unknown on the way in;
- `webSocket.bun.test.ts` runs a `Bun.serve` CSMS and a `WebSocket` station on
  `127.0.0.1` (its own constant: core's `LOOPBACK` is out of bounds for the package)
  and exchanges a 1.6J `BootNotification` over a real socket;
- `frames.test.ts` pins the encoded bytes of all five frame types and each
  decode error.

**What it does not prove.** Nothing is installed outside the monorepo: the
package resolves through workspace links, and `packages/ocpp` is not publishable
yet. The RFC's Phase 4 box "verify consumption from an independently installed
package" stays unchecked until #1053 and
[#1063](https://github.com/shiv3/ocpp-cp-simulator/issues/1063) (standalone
station and CSMS examples installed from packed tarballs). No SOAP exchange is
covered, the 2.1 message types are exchanged in memory only, and the WebSocket
test is a test, not a transport:
it wires a raw socket to `send` / `receive` by hand.

## Decisions

The RFC's six open questions, decided by the RFC's author in #1066. The
maintainer can still ask for a change on that pull request.

1. **Separate npm packages: yes, one package per module, published when it is
   mature.** The goal is to be ready to ship a module as soon as it is stable
   enough, not to publish everything at once. `ocpp` and `ocpp-rpc` come first
   (#1053), as they have no runtime dependencies beyond `ajv`. The transports
   follow once they are extracted. A single package with subpath exports was
   rejected: every consumer would install every transport's dependencies.
2. **Connection management: the toolkit owns the technical base, the product
   owns the policies.** The toolkit gives what a charging-station or CSMS product
   needs to be built: open, close, ping, and a reconnect with backoff driven by
   an injected clock. The product (here, the simulator) owns the policies: the
   `RetryBackOff*` variables, offline queues and their replay, and every fault
   simulation. Offline queues stay out of the toolkit because their semantics
   are version- and role-specific.
3. **Clients: both.** One generic `RpcEndpoint`, because CALL / CALLRESULT /
   CALLERROR are generic, plus thin typed clients per OCPP version, generated
   from the schemas next to the types (`scripts/generate-ocpp.ts`, #1074). Typing is a
   requirement: anything that knows an action name is typed per version.
4. **Smallest API: what the proof uses now, role wrappers once stable.** Today
   that is `RpcEndpoint` + a dialect + a validator + a transport that supplies
   `send` and calls `receive`, for both roles. Station and CSMS wrappers
   (connection lifecycle, boot gating, one endpoint per connection on the
   server, connection identity and authentication) come with #1063, once the
   API is stable.
5. **SOAP and JSON: a transparent transport is the target, shared handlers
   first.** The aim is that a product does not care which transport carries a
   call. In the short term SOAP and JSON share the model package and the handler
   signature (action, typed payload → typed response or error), each with its
   own transport, because SOAP pairs a request with its HTTP response rather than
   with a message id on a shared socket, and the SOAP versions (1.2, 1.5, 1.6)
   are no longer current. The SOAP extraction (#1058) evaluates whether
   `RpcEndpoint` can sit over SOAP without forcing its semantics.
6. **An independent repository: once stable.** The packages move out only after
   they are published and their API has held. Until then the simulator's
   golden-wire and e2e suites are the stack's best guard.

## Phases and issues

All are sub-issues of #978.

| Phase                   | Issue                                                                       | Work                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1 — model package       | [#1051](https://github.com/shiv3/ocpp-cp-simulator/issues/1051)             | Closed by #1065: `scripts/fetch-ocpp-schemas.sh` writes to `packages/ocpp/vendor/`                     |
| 1 — model package       | [#1052](https://github.com/shiv3/ocpp-cp-simulator/issues/1052)             | OCA (CC BY-ND) attribution missing from the CLI and web third-party notices                            |
| 1 — model package       | #1053                                                                       | Publishable `packages/ocpp`: build, curated exports, declared ajv, tarball install check               |
| 2 — protocol primitives | done here                                                                   | `packages/ocpp-rpc`: codec, `CallWaiters`, `RpcEndpoint`, dialects, validator                          |
| 2 — protocol primitives | [#1118](https://github.com/shiv3/ocpp-cp-simulator/issues/1118)             | OCPP 2.1 SEND and CALLRESULTERROR in the codec and the endpoint; core's inline copies removed          |
| 2 — protocol primitives | #1054                                                                       | Generic correlator under `SerialCallQueueV16` / `RequestHistory`, `CallPipelineV201`, `RawFrameSender` |
| 2 — protocol primitives | #1055                                                                       | Frame-observer port replacing log-line parsing in trace                                                |
| 2 — protocol primitives | done here ([#1060](https://github.com/shiv3/ocpp-cp-simulator/issues/1060)) | Spec-conformant replies to malformed frames ([Malformed frames](#malformed-frames))                    |
| 2 — protocol primitives | [#1062](https://github.com/shiv3/ocpp-cp-simulator/issues/1062)             | Mock CSMS helpers and the `wsNetworkSim` inline CALLERROR on the ocpp-rpc codec                        |
| 2 — protocol primitives | #1059                                                                       | Inbound dispatch on ocpp-rpc handler registration (the `ocpp-toolkit` station API)                     |
| 2 — protocol primitives | #1074                                                                       | Typed per-version clients over `RpcEndpoint`, generated from the schemas (decision 3)                  |
| 3 — transports          | #1056                                                                       | Network faults as an injected link decorator; `ChargePointSocket` split                                |
| 3 — transports          | #1057                                                                       | Extract `ocpp-transport-ws`                                                                            |
| 3 — transports          | #1058                                                                       | Extract `ocpp-transport-soap`                                                                          |
| 3 — transports          | [#1061](https://github.com/shiv3/ocpp-cp-simulator/issues/1061)             | Verify the negotiated subprotocol after open (done)                                                    |
| 4 — independent use     | #1063                                                                       | Standalone station and CSMS examples from packed tarballs (blocked by #1053, #1057, #1058)             |
