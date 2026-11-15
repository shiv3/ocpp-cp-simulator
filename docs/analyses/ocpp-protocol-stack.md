---
title: Reusable OCPP protocol stack
type: analysis
summary: Design for #978 — where the OCPP-J/SOAP protocol code lives today and what ties it to the simulator, the target modules (model, rpc, transports, toolkit), the seams to cut, what the new domain-free packages/ocpp-rpc proves and does not, recommendations on the RFC's open questions, and the phase → issue plan.
sources:
  - "issue #978"
  - packages/ocpp-rpc/src/index.ts
  - packages/ocpp-rpc/src/RpcEndpoint.ts
  - packages/ocpp-rpc/src/frames.ts
  - packages/ocpp-rpc/src/__tests__/RpcEndpoint.test.ts
  - packages/ocpp-rpc/src/__tests__/webSocket.bun.test.ts
  - scripts/check-package-boundaries.ts
  - scripts/check-direct-time.ts
  - packages/core/src/cp/infrastructure/transport/
  - packages/trace/src/logEntryToTrace.ts
related:
  - ../concepts/ocpp-versions-and-transports.md
  - ../sources/vendored-ocpp-schemas.md
  - ../overview.md
  - ../concepts/network-simulation.md
  - ../concepts/trace-format.md
  - ../concepts/charger-engine.md
updated: 2026-11-15
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

| Concern                  | Where it lives                                                                                                                                                                                                                                                                                       | Simulator coupling                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model                    | `packages/ocpp` (generated types, validators, vendored OCA schemas)                                                                                                                                                                                                                                  | None, but not publishable: private at `0.0.0`, exports `"./*": "./src/*.ts"`, extensionless relative imports, JSON imported without import attributes, `ajv` / `ajv-draft-04` declared only in the root manifest                                                                                                          |
| OCPP-J frame codec       | `packages/ocpp-rpc` now; still re-implemented in `infrastructure/transport/ws/wsNetworkSim.ts` (`dispatchIncomingFrame`), `transport/network-sim/FrameContext.ts`, `RawFrameSender.ts` (`messageIdOf`), `packages/k6-runtime/src/frames.ts` and the mock CSMS helpers                                | `k6-runtime/src/frames.ts` is copied verbatim into a k6 export and must stay import-free                                                                                                                                                                                                                                  |
| Correlation and timeouts | `CallWaiters` (now a `realClock` subclass of ocpp-rpc's) covers only DataTransfer and expert calls (`ExpertCalls.ts`, `RawFrameSender.ts`); the real correlation is `transport/v16/serialCallQueueV16.ts` + `RequestHistory` (`v16/outboundRequestsV16.ts`) and `transport/v201/callPipelineV201.ts` | Both `SerialCallQueueV16` and `CallPipelineV201` hold a `ChargePoint`                                                                                                                                                                                                                                                     |
| WebSocket transport      | `infrastructure/transport/OCPPWebSocket.ts` and `ws/` (opener, close handling, ping, `reconnectScheduler.ts`), `profile/subprotocols.ts`                                                                                                                                                             | `OCPPWebSocket` builds a `NetworkSimController` in its constructor; `domain/transport/ChargePointSocket.ts` mixes transport and fault control; `ws/reconnectScheduler.ts` arms raw `setTimeout` / `Date.now()`; the negotiated subprotocol is exposed by `ws/socketWrappers.ts` but never compared with the one requested |
| Fault vocabulary         | `CloseCause` and the `GenerationToken` interface in `domain/transport/networkSim.ts`, `Settlement` in `transport/network-sim/NetworkSimPipeline.ts`, `GenerationTokenImpl` in `ws/closeClassification.ts`                                                                                            | The WebSocket close path (`ws/closeHandler.ts`, `ws/connectionOpener.ts`) imports them through the `network-sim` barrel                                                                                                                                                                                                   |
| SOAP                     | `infrastructure/transport/soap/` (`soapEnvelope.ts`, `dialect.ts`, `OCPPSoapHandler.ts`, `OCPPSoapServer.ts`, `soapRequestQueue.ts`, `v16RegistryDispatch.ts`)                                                                                                                                       | Envelope and dialect code depend only on `fast-xml-parser` and `OcppVersion`, but that type lives in core's `domain/types/OcppVersion.ts`; the handler, server, queue and registry dispatch hold `ChargePoint`                                                                                                            |
| Inbound dispatch         | `OCPPMessageHandler.ts`, `OCPPMessageHandlerV201.ts`, `inbound/InboundCallGate.ts`, `handlers/`                                                                                                                                                                                                      | Handlers receive the `ChargePoint`                                                                                                                                                                                                                                                                                        |
| Observation              | `packages/trace/src/logEntryToTrace.ts` parses the `Sent: `, `Received: ` and `Inbound validation: ` log lines; `packages/trace/src/TraceCorrelator.ts` correlates the resulting records itself                                                                                                      | The protocol layer has to keep writing those exact log lines until a frame observer replaces them                                                                                                                                                                                                                         |

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

| Export                                                                                            | What it does                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OCPPMessageType`, `encodeCall`, `encodeCallResult`, `encodeCallError`                            | Write the simulator's exact bytes: same key order, CALLERROR `details` default to `{}`                                                                                                       |
| `decodeFrame(raw)`                                                                                | A typed `RpcFrame` or an `RpcDecodeError` (`not-json`, `not-array`, `unknown-message-type`, `invalid-message-id`, `invalid-action`, `invalid-error`, `wrong-length`); never throws           |
| `CallWaiters`, `RpcClock`, `platformClock`                                                        | Pending-call registry with timeouts on a minimal `{ setTimeout, clearTimeout }` clock; defaults to the platform timers                                                                       |
| `RpcEndpoint`                                                                                     | One side of an OCPP-J link, station or CSMS alike: `handle(action, handler)`, `call(action, payload)`, `receive(raw)`, `close(reason)`; it owns no socket, `send` and `receive` are the link |
| `OCPP16_RPC_DIALECT`, `OCPP2X_RPC_DIALECT`, `violationKind`                                       | Each version's error codes (`FormationViolation` in 1.6, `FormatViolation` in 2.x, …), kept separate rather than generalized                                                                 |
| `ocppSchemaValidator(version)`                                                                    | Adapts `@ocpp-cp-simulator/ocpp`'s validators to the endpoint's `validate` hook                                                                                                              |
| `RpcCallError`, `RpcTimeoutError`, `RpcClosedError`, `RpcInvalidResponseError`, `RpcHandlerError` | The typed outcomes of `call`, and the error a handler throws to choose its CALLERROR                                                                                                         |

`RpcEndpoint` takes `send`, `nextMessageId`, `dialect` and optionally `clock`,
`callTimeoutMs` (default 30 s), `validate` and `onProtocolError`. Its contract:

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
  go to `onProtocolError` and are **never answered**. The spec-conformant replies
  (`RpcFrameworkError`, `MessageTypeNotSupported`, `ProtocolError`) are
  [#1060](https://github.com/shiv3/ocpp-cp-simulator/issues/1060).
- `close(reason)` rejects every pending call with `RpcClosedError`, and the endpoint
  then ignores frames and does not answer handlers that finish later.

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
- `webSocket.bun.test.ts` runs a `Bun.serve` CSMS and a `WebSocket` station on
  `127.0.0.1` (its own constant: core's `LOOPBACK` is out of bounds for the package)
  and exchanges a 1.6J `BootNotification` over a real socket;
- `frames.test.ts` pins the encoded bytes of all three frame types and each
  decode error.

**What it does not prove.** Nothing is installed outside the monorepo: the
package resolves through workspace links, and `packages/ocpp` is not publishable
yet. The RFC's Phase 4 box "verify consumption from an independently installed
package" stays unchecked until #1053 and
[#1063](https://github.com/shiv3/ocpp-cp-simulator/issues/1063) (standalone
station and CSMS examples installed from packed tarballs). No SOAP exchange and
no 2.1 exchange is covered, and the WebSocket test is a test, not a transport:
it wires a raw socket to `send` / `receive` by hand.

## Open questions

Each answer is a **recommendation, pending maintainer decision**.

1. **Separate npm packages?** Yes, eventually, and only once an external consumer
   (the gateway or the TCK) has used the boundaries. Start with `ocpp` and
   `ocpp-rpc` (#1053), which have no runtime dependencies beyond `ajv`; transports
   follow once extracted.
2. **Generic connection management or simulator policy?** The toolkit owns the
   primitives: open, close, ping, and a reconnect with backoff driven by an
   injected clock. The simulator owns the policies: the `RetryBackOff*` variables,
   offline queues and their replay, and every fault simulation.
3. **Version-specific clients or a generic one?** Version-specific clients
   (typed actions per version) over one thin shared `RpcEndpoint`. The endpoint
   stays generic because CALL / CALLRESULT / CALLERROR are; anything that knows an
   action name is per version.
4. **Smallest useful API, both roles?** `RpcEndpoint` + a dialect + a validator +
   a transport that calls `receive` and supplies `send`. That is what the proof
   uses for both roles; a station-side or CSMS-side wrapper adds connection
   lifecycle, not protocol.
5. **SOAP and JSON sharing concepts?** Through the model package and the handler
   signatures (action, typed payload → typed response), not through a common
   transport abstraction: SOAP pairs a request with its HTTP response, not with a
   message id on a shared socket, and forcing it into `RpcEndpoint` would be the over-generalization the RFC warns
   against.
6. **An independent repository?** Only after the packages are published and
   consumed outside this repository, as the RFC's non-goals already say. Until
   then the simulator's golden-wire and e2e suites are the stack's best guard.

## Phases and issues

All are sub-issues of #978.

| Phase                   | Issue                                                           | Work                                                                                                   |
| ----------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1 — model package       | [#1051](https://github.com/shiv3/ocpp-cp-simulator/issues/1051) | Closed by #1065: `scripts/fetch-ocpp-schemas.sh` writes to `packages/ocpp/vendor/`                     |
| 1 — model package       | [#1052](https://github.com/shiv3/ocpp-cp-simulator/issues/1052) | OCA (CC BY-ND) attribution missing from the CLI and web third-party notices                            |
| 1 — model package       | #1053                                                           | Publishable `packages/ocpp`: build, curated exports, declared ajv, tarball install check               |
| 2 — protocol primitives | done here                                                       | `packages/ocpp-rpc`: codec, `CallWaiters`, `RpcEndpoint`, dialects, validator                          |
| 2 — protocol primitives | #1054                                                           | Generic correlator under `SerialCallQueueV16` / `RequestHistory`, `CallPipelineV201`, `RawFrameSender` |
| 2 — protocol primitives | #1055                                                           | Frame-observer port replacing log-line parsing in trace                                                |
| 2 — protocol primitives | #1060                                                           | Spec-conformant replies to malformed frames                                                            |
| 2 — protocol primitives | [#1062](https://github.com/shiv3/ocpp-cp-simulator/issues/1062) | Mock CSMS helpers and the `wsNetworkSim` inline CALLERROR on the ocpp-rpc codec                        |
| 2 — protocol primitives | #1059                                                           | Inbound dispatch on ocpp-rpc handler registration (the `ocpp-toolkit` station API)                     |
| 3 — transports          | #1056                                                           | Network faults as an injected link decorator; `ChargePointSocket` split                                |
| 3 — transports          | #1057                                                           | Extract `ocpp-transport-ws`                                                                            |
| 3 — transports          | #1058                                                           | Extract `ocpp-transport-soap`                                                                          |
| 3 — transports          | [#1061](https://github.com/shiv3/ocpp-cp-simulator/issues/1061) | Verify the negotiated subprotocol after open                                                           |
| 4 — independent use     | #1063                                                           | Standalone station and CSMS examples from packed tarballs (blocked by #1053, #1057, #1058)             |
