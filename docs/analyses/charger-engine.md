---
title: Charger engine design
type: analysis
summary: Design of the charger engine — one owner of charge point state, behaviors written as TypeScript modules behind a narrow ctx port, one inbound gate, and an injectable clock — and the staged migration from handler-embedded behavior.
sources:
  - packages/core/src/cp/domain/charge-point/ChargePoint.ts
  - packages/core/src/cp/infrastructure/transport/OCPPMessageHandler.ts
  - packages/core/src/cp/infrastructure/transport/OCPPMessageHandlerV201.ts
  - packages/core/src/cp/infrastructure/transport/network-sim/ResponseEffectQueue.ts
  - packages/core/src/cp/application/scenario/ScenarioExecutor.ts
  - packages/k6-runtime/src/interpreter.ts
  - "issues #566, #569, #575, #600, #618"
related:
  - ../concepts/scenario-format.md
updated: 2026-11-07
---

# Charger engine design

## Problem

Charge point behavior lives in OCPP handlers and in `ChargePoint`. One behavior is spread over the 1.6
handler, the 2.x handler, `ChargePoint`, `Connector`, the scenario runtime and the k6 responder, so
versions drift: 1.6 `UpdateFirmware` sends notifications, 2.x only acknowledges. `ConnectorStateMachine`
is initialized but production code sends it no transitions; `updateConnectorStatus` writes
`connector.status` directly, from about ten files. Time and randomness are read directly, so a run
cannot be replayed. Scenarios cannot replace behavior generically (#566).

## Target

```
Driver (scenario, console, EV model) ─┐
Behavior module (TypeScript) ─────────┤
                                      ▼
                     ctx (BehaviorContext port): time, wait, random, send, state, physical verbs
                                      ▼
Charger engine: single event queue, sole writer of charger state, default behaviors
                                      ▼
InboundCallGate / CallExchange  ◄──►  OCPP adapters (1.6 JSON, 2.x, SOAP): translation only
```

Rules:

1. **Behavior is code.** Behaviors are plain TypeScript modules, not a JSON DSL. Default behaviors are
   written against the same `ctx` API as user behaviors. Users override a part; they never reimplement
   a charger.
2. **Calculations stay as services.** `ChargingScheduleResolver`, `MeterValueBuilder`, charging curves,
   `CertificateStore`, `ConfigurationStore`, authorization cache, OCPP codecs and network simulation are
   not rewritten.
3. **JSON scenarios stay.** They keep GUI editing, pause / step / resume, and fleet declaration. They
   drive the engine and may select behaviors. Existing files keep working unchanged.
4. **No behavior change unless configured.** With no behavior configured, the bytes on the wire and
   their order are the same as before. In particular 2.x `UpdateFirmware` stays ack-only by default.
5. **No code over the wire.** Socket.IO, MCP and OCPP accept JSON only (#569 forbids executable
   content). Code loads only from local files at start, behind an explicit flag. Plain execution has
   no isolation: `vm`, Worker and ShadowRealm are not called isolation anywhere.

## Parts

### Clock and random (`packages/core/src/cp/shared/clock.ts`, `rng.ts`)

```ts
export interface SimClock {
  now(): number; // epoch ms
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}
```

`RealClock` wraps the platform. `VirtualClock` keeps one queue ordered by (time, charger id, sequence)
and offers `advanceBy(ms)`, `advanceTo(t)` and `runUntilIdle()`. Between two timers these `await` a
full microtask drain so that async behaviors settle before time moves on. `RngStreams(seed)` derives
a stream from `hash(seed, chargerId, streamName)`, so adding a charger or a stream does not change the
numbers of another.

`ChargePoint` takes an optional clock and seed; the default is `RealClock`, which keeps behavior
identical. All `domain/` and `application/` code uses the injected clock. Socket keep-alive and
reconnect timers in `infrastructure/transport` may stay on real time only where a comment explains why.
A CI check lists direct `Date.now`, `new Date()`, `setTimeout`, `setInterval` and `Math.random` in
`domain/` and `application/` against a shrinking exemption list.

Status (stage A): `clock.ts` and `rng.ts` exist, `ChargePoint` takes them as its last constructor
argument (`{ clock, seed }`), and the check is `scripts/check-direct-time.ts`, run by
`bun run check:boundaries`. Decisions the design left open:

- **`TimerHandle`** is an opaque branded type. `RealClock` returns the platform's own timer object
  and reads `Date` and the timer functions from the global object at call time, so fake timers
  still steer it. `RealClock.now()` reads through `new Date().getTime()`, the way the code it
  replaced read `new Date()`, so a test that stubs the global `Date` constructor steers it too.
- **`VirtualClock`** is itself the root `SimClock`; `scoped(chargerId)` returns the view whose timers
  carry the charger id used by the (time, charger id, sequence) order. The microtask drain between
  two timers is one macrotask hop (`setImmediate`, else `setTimeout(0)`, captured at load so fake
  timers cannot replace it): it is the only way to be sure every queued continuation has run. A
  virtual run therefore must not wait on real I/O of its own process. A timer callback that throws
  fails the `advance*` call that fired it. `runUntilIdle` ends with an error after `maxTimers`
  timers, because an interval never lets the queue run dry.
- **`RngStreams`** hashes `(seed, chargerId, streamName)` with cyrb128 into an sfc32 generator.
  `systemRngStreams` is the unseeded variant (`Math.random`, `crypto.randomUUID`), which is what a
  charge point without a seed uses, so the default stays as before. `Rng` has `next`, `int`,
  `pick` and `uuid`.
- **What the check covers**: `Date.now`, argument-less `new Date()` (default parameters too),
  `performance.now`, `Math.random`, `crypto.randomUUID` and `getRandomValues`, and the global
  `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`. Exempt, with reasons in the script:
  the repositories' row bookkeeping stamps, the log flush pacing, and the `now` defaults of the pure
  schedule resolvers (their production callers pass the clock). Not covered: `infrastructure/`
  (the 2.x handler still mints transaction UUIDs with `crypto.randomUUID`) and the apps.

### CallExchange and InboundCallGate

`CallExchange` is one inbound CALL. State: `open | answered | suppressed | abandoned`. The first answer
is sent; a later answer is not sent and throws. `respond()` and `respondError()` return a promise of
`ExchangeSettlement` that always resolves: `{ delivered: true }` or `{ delivered: false, reason }`.
`ResponseEffectQueue.register` gains an optional `onDropped` so that a dropped or stale effect reports
back. Existing callers are unaffected.

`InboundCallGate` replaces the policy and override blocks duplicated in the 1.6 and 2.x handlers. Order:

1. `incomingCallReceived` (unchanged)
2. `inboundPolicy`
3. `responseOverride`
4. `BehaviorRegistry.resolve()`, synchronous
5. default path (2.x validates its payload here)

Step 4 runs before validation, as policies do, so a behavior can own a malformed CALL. The gate is
synchronous: 2.x must not defer a CALLRESULT by a microtask (#456). Action matching uses
`csmsActionMatches`. SOAP: a `replace` rule on a SOAP station fails the run at arm time, it never
silently falls back; a SOAP station does get default behaviors, which do not go through the gate in
this version.

Status (stage A): `infrastructure/transport/inbound/CallExchange.ts` and `InboundCallGate.ts` exist,
`application/behavior/BehaviorRegistry.ts` is a stub whose `resolve()` always answers `default`, and the
1.6 and 2.x WebSocket handlers answer every inbound CALL through them. `ResponseEffectQueue.register`
takes the optional `onDropped(reason)` with `stale | disposed | disconnect`. The 2.x path stays
synchronous (#456): the gate and `respond()` write in the turn they are called, and only the returned
promise is asynchronous. The SOAP handler is untouched. Decisions the design left open:

- **Two ways to answer.** `respond()` / `respondError()` observe the answer: the transport gets a
  settlement hook and the promise says whether the frame was written. `reply()` / `replyError()`
  do not, and give the transport no hook unless the answer carries an effect. The handlers' default
  path and the gate use `reply`: a frame dropped with no hook is logged by the network simulation as a
  discard, and a hook would change that, which rule 4 forbids. `ExchangeSettlement.reason` is a
  transport drop reason (`socket_closed | disposed | write_failed | queue_overflow`), `stale`
  (connection changed, or abandoned) or `suppressed`.
- **Stale and disconnect.** An answer on a connection that changed is not sent, runs no effect, and the
  CALL is announced `NoResponse` (the 2.x handler already did this; the 1.6 handler used to announce
  `CallResult` for a frame its socket then dropped, so that event now says `NoResponse`; nothing on
  the wire differs). When the socket's close transaction finalizes, the gate abandons the exchanges
  still open, which announces them at that moment instead of when the late answer arrives. A later
  answer settles `stale` and does not throw; a second answer to an answered or suppressed CALL throws
  `CallExchangeError`. A write that throws synchronously leaves the exchange open, so the catch
  block can still answer with a CALLERROR as before.
- **Ports.** The gate does the sequencing; what differs per version is how a policy or override is
  looked up. A 1.6 CALL is looked up under its own name with `getInboundCallPolicy` and
  `consumeResponseOverride` only; a 2.x CALL under its name and its 1.6 aliases, the one-shot
  consumed under every spelling, and an override on an action whose answer is not `{ status }`
  (`V201_ACTIONS_WITHOUT_STATUS_RESPONSE`) consumed with a warning while the real handler answers.
- **Registry input.** `resolve()` gets the action, the payload and the connector id the CALL names
  (`connectorId`, else `evse.connectorId`).

### Behavior API (`packages/contracts`, types only)

```ts
export interface Behavior {
  api: 1;
  id: string;
  requires?: readonly BehaviorCapability[]; // "ocpp1.6" | "ocpp2.x" | "physical" | "virtual-time" ...
  onCall?: Record<string, CallBehavior>; // keyed by action, either version's spelling
  main?(ctx: BehaviorContext): Promise<void>;
  onResume?(ctx: BehaviorContext): Promise<void>;
}

export type CallBehavior = {
  mode: "replace" | "extend";
  match?: Record<string, unknown>; // deepPartialMatch
  onBusy?: CallAnswer; // default: CALLERROR GenericError
  handle(
    req: unknown,
    ctx: BehaviorContext,
  ): CallOutcome | Promise<CallOutcome>;
};

export type CallOutcome =
  | { response: unknown; skipValidation?: boolean; after?: () => Promise<void> }
  | {
      error: { code: string; description: string };
      after?: () => Promise<void>;
    }
  | { noResponse: true; after?: () => Promise<void> };
```

`extend` runs the default behavior: `ctx.defaultBehavior(req)` returns the default response and
registers its effect, and the handler may wrap it. `after` runs once the response settled, and is
skipped with a warning if it was not delivered.

`BehaviorContext`:

- `now()`, `sleep(ms)`, `until(promise, { ms })`, `random(stream)`, `stopping`
- `state`: user data that must be JSON-serializable; held by the engine
- `send(action, payload, opts?)`: a station-initiated CALL through the normal path
- `raw(frame)`: explicit opt-in for non-compliant traffic, via `RawFrameSender`
- physical verbs, independent of OCPP version: `plugIn`, `unplug`, `authorize`, `startCharging`,
  `stopCharging`, `setConnectorStatus`
- `notify`: version-neutral notifications such as `firmwareStatus(status)`, `logStatus(status)`
- `connector(id)`, `charger`: read-only snapshots
- `log(message)`

Behavior modules import types only. They must not use module-scope mutable state, `Date`,
`Math.random` or timers; an ESLint config shipped for behaviors reports these. The API must work on
k6: no `AbortController`, `URL`, `structuredClone`, `queueMicrotask`, `performance`, async generators or
`for await`.

Status (stage B): the types are in `packages/contracts/src/behavior.ts` (import them as
`@ocpp-cp-sim/contracts/behavior`; they are not re-exported from the package index, whose names would
collide). Decisions the design left open:

- **`CallAnswer`** (what `onBusy` is) is a `CallOutcome` without `after`.
- **`ctx.defaultBehavior(req)`** is synchronous and returns the default response. It is available in
  `extend` handlers only and throws elsewhere. A default behavior that answers with an error makes it
  throw. The default's follow-up (its `after`) runs when the response settled, before the handler's own
  `after`.
- **`after` and no answer.** `after` runs once the response settled on the wire. For `noResponse` there
  is nothing to settle, so it runs at once. When the response is not delivered (stale connection, socket
  closed) it is skipped with a warning.
- **extend mode.** `ctx.defaultBehavior(req)` runs the default behavior of the CALL's action on the `req`
  the handler passes (it may be a changed copy) and registers its follow-up. Calling it commits to that
  follow-up: a handler that then answers something else still gets the default's effect. The request is
  not schema-checked first (the registry runs before 2.x validation, so a behavior can own a malformed
  CALL); a default that cannot read a malformed `req` fails and the CSMS gets `InternalError`. The
  tests are `packages/core/src/test/behavior/extend.bun.test.ts`.
- **Response checking.** A `response` is checked against the bundled JSON schema of the action's
  response (`<action>Response<V16|V201|V21>`), using the wire spelling of the CALL. A violation answers
  CALLERROR `InternalError` and logs a warning; `skipValidation: true` sends it as given. An action with
  no bundled response schema is not checked.
- **`requires` is enforced.** `loadBehavior` refuses a behavior whose `requires` the station cannot
  meet (`ocpp1.6` on a 2.x station, `ocpp2.x` on 1.6, `virtual-time` on a real-time clock). A behavior
  that calls a physical verb or `ctx.raw` without listing `physical` or `raw-frames` gets an error at the
  call. `raw-frames` is a capability name added to the design's list.
- **Waits.** `ctx.sleep` and `ctx.until` run on the charge point's clock. When the behavior is unloaded,
  the station disposes, or (for a CALL's handler and `after`) the connection closes, a pending wait
  rejects with `BehaviorStopped`, which the engine swallows. `ctx.until` rejects with `BehaviorTimeout`.
- **`ctx.random(stream)`** draws from the charge point's streams under the name `<behaviorId>/<stream>`,
  so two behaviors never share numbers by accident.

### BehaviorRegistry (`application/behavior/`)

One per charge point. Holds rules from two providers: code behaviors, and scenario rules.

- Owner: `{ kind: "code", behaviorId }` or `{ kind: "scenario", scenarioId, connectorId, nodeId }`.
- Selection: exact connector match, then oldest registration; a warning names the losers. A CALL
  without a connector matches any rule.
- A rule holds at most one open exchange. A second matching CALL gets `onBusy` at once and never
  reaches the default path.
- Scenario rules end with their run, released by owner. Code rules last as long as the behavior is
  loaded.

### Scenario schema 1.5 (additive)

- `csmsCallTrigger.behavior`: `"observe"` (default, as today) or `"replace"`, plus `onBusy`.
- `callResponse` node: `kind: "result" | "error" | "none"`, `payload`, `errorCode`, `errorDescription`,
  `skipValidation`. It waits for settlement.
- `{ "$from": "call.payload.requestId" }` as a whole value in `ocppCall` and `callResponse` payloads,
  resolved against the exchange of that branch. A missing path fails the run.
- `useBehavior` node: selects a behavior already loaded on the station by id. Data only.
- The exchange is branch-scoped: pass a flow context through `executeSequentialFlow`, so parallel
  branches from Start can own different calls. Ownership lasts from first reaching the node until the
  run ends.

Runtime contract:

| Case                               | Behavior                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| Disconnect before answering        | exchange `abandoned`, `incomingCallCompleted` is `NoResponse`, the run fails like other waits |
| Run ends or stops unanswered       | CALLERROR `InternalError` with a warning; silence needs `kind: "none"`                        |
| Answer after reconnect             | not sent, settles `stale`                                                                     |
| Send failed or dropped             | `callResponse` receives `delivered: false` and fails the run                                  |
| Time before answering              | never timed out by the simulator; delay nodes and `timeout` bound it                          |
| `callResponse` without an exchange | fails the run                                                                                 |

Status (stage B): all of the above is implemented, and the schema is 1.5
([Scenario format](../concepts/scenario-format.md#csmscalltrigger-replace-callresponse-from-and-usebehavior-schema-15)).
Decisions the design left open:

- **Where the rule lives.** A `csmsCallTrigger` with `behavior: "replace"` registers a scenario rule with the
  station's `BehaviorRegistry` when the node arms (`ScenarioRuntime.waitForCsmsCallReplacing`). The rule's
  `connectorId` is the run's connector and only **ranks** (exact connector first, then oldest registration);
  filtering is `match`, i.e. the node's `payload` condition. A CALL that names no connector matches every
  rule. The rule ends when the exchange it took is answered (or abandoned), when the wait is withdrawn
  before a CALL arrived (timeout, continue), or when the run ends. Withdrawing a wait that already took a CALL
  does not drop the rule, so a second CALL still gets `onBusy`.
- **Flow context.** `ScenarioExecutor` passes a `Flow { exchange, answered }` through
  `executeSequentialFlow` / `executeSingleNode` / `executeNode`; every branch from Start gets a fresh one.
  `$from` is resolved by `resolveFromExchange` (`resolveFrom.ts`) against the branch's exchange: roots are
  `call.action`, `call.messageId` and `call.payload.<path>`.
- **Run end.** The executor's `finally` calls `callbacks.onRunEnded()`; the runtime releases the owners the run
  armed and answers the still-open exchanges CALLERROR `InternalError` with a warning.
- **`callResponse`** checks a `result` payload against the action's response schema (same check as a code
  behavior, `responseValidation.ts`) unless `skipValidation`; a violation throws, the run fails and the CALL is
  answered `InternalError` at the run's end. `kind: "none"` is reported as delivered. A second `callResponse`
  for the same CALL fails the run.
- **`useBehavior`** needed a meaning for "selects": `cp.loadBehavior(behavior, { dormant: true })` loads a
  behavior without serving it (no rules, no `main`); a run that reaches `useBehavior` registers its rules
  under the run as owner, so they end with the run. A behavior that is not dormant already serves; the node
  then only checks it exists. An unknown id fails the run.
- **SOAP.** The wait fails when the node arms (`behavior "replace" needs an OCPP-J station`).
- **`export-k6`** refuses `behavior: "replace"`, `onBusy`, `callResponse`, `useBehavior` and an `ocppCall`
  payload holding `$from`, each with its own message. The schema's `schemaVersion` stamp became `1.5`.
- The tests are `packages/core/src/test/behavior/scenario15.bun.test.ts` (one test per row of the table above,
  on a virtual clock against the fake CSMS) and `ScenarioExecutor`-level `callResponse.test.ts`, which holds the
  rows that need a stub: a send that failed or was dropped, and SOAP.

### Charger engine (`application/engine/`)

`ChargerEngine` is one per charge point. It owns `ChargerState`, a JSON-serializable record of
connector status, availability, transaction, firmware, log and reservation state. Every mutation goes
through `engine.dispatch(event)`, processed in order on one queue. Handlers and `ChargePoint` translate
to events and do not write state.

`ChargePoint` remains as a facade with its public API. `Connector` fields become read views of the
engine state. `ConnectorStateMachine` is deleted; `ALLOWED_CONNECTOR_STATUS_TRANSITIONS` stays, and is
enforced only as a warning so that scenarios can keep forcing transitions. `StateManager` is reduced to
recording `StateHistory` from engine output. `ChargePointEvents` keep their names and payloads, emitted
from engine output. Persistence stores engine state.

Default behaviors move one at a time into `application/engine/behaviors/`: firmware, signed firmware,
diagnostics and logs, reset, availability, reservation, unlock, then transaction and connector status.
Each move deletes the old code in the same commit. Calculations are called as services.

Resume: state is restored, and `onResume` runs. Async positions are not restored.

Status (stage B): `ChargerEngine` and `ChargerState` are in `application/engine/`; `ChargePoint` owns one
(`cp.engine`) and offers `cp.loadBehavior(behavior)` and `cp.unloadBehavior(id)`. Decisions the
design left open:

- **State so far.** `ChargerState` holds `schema`, the last firmware, signed firmware, log and
  diagnostics status the station reported (`{ status, requestId }`), and `behaviors`, the `ctx.state`
  of every loaded behavior. Stage C added `connectors` (see "Status (stage C)"). Transactions and
  reservations move into it with their default behaviors later; transactions are in it since stage C2
  (reservations stay in `ReservationManager`).
  `engine.snapshot()` returns a deep copy after checking it is JSON-serializable.
- **The queue.** `engine.dispatch(event)` is synchronous: an event dispatched while the queue is idle is
  reduced and acted on before the call returns, so a notification still goes out in the turn that asked
  for it (the wire order does not change); one dispatched meanwhile runs right after the current event.
  Events: `notified` (firmware / signed firmware / log / diagnostics status, reduced into the state, then
  sent), `behavior.loaded`, `behavior.unloaded`, `connection.closed`, `disposed`. `ctx.state` is the
  one thing a behavior mutates in place; it is not an event.
- **Default behaviors** are `Behavior` objects registered with `engine.registerDefault`, keyed by wire
  action and written against the same `ctx`. Handlers call `engine.runDefault(action, payload)` and get
  `{ response, effect }`: the effect starts the behavior's `after` once the response settled, through the
  existing `ResponseEffectQueue`. A default answers synchronously (#456). The ones moved so far reach
  `ChargePoint` internals through the station they were built for, because the connector and
  transaction paths are not engine-owned yet.
- **Moved so far** (each with its old code deleted): `default.firmware` (`UpdateFirmware`: the 1.6 status
  train with the one-shot `SimulatedFirmwareUpdateFailure`, the 2.x acknowledgement that stays
  ack-only; a user behavior opts in to a 2.x train) and `default.signedFirmware` (`SignedUpdateFirmware` on
  1.6: the signed status train carrying `requestId`), `default.diagnostics` (`GetDiagnostics` on 1.6:
  file name, then `Uploading` and `Uploaded` or `UploadFailed` around a real multipart POST) and
  `default.logs` (`GetLog`: the 1.6 `Uploading`, two seconds, `Uploaded` sequence; on 2.x ack-only with a
  file name, a user behavior opts in). The diagnostics behavior imports `infrastructure/file_upload`, the one
  place where `application/` reaches into `infrastructure/`; the upload is platform I/O the engine does not
  own, and `default.reset` (`Reset`: the 1.6 `Accepted` and reset after the answer; the 2.x
  `Rejected` / `Scheduled` / `Accepted` rules and the reset after the answer) and `default.availability`
  (`ChangeAvailability`: 1.6 applies the change while it builds the answer, 2.x once the answer settled) and `default.reservation` (`ReserveNow` and `CancelReservation` over
  `ReservationManager`; 1.6 moves the connector to `Reserved` / `Available` while it builds the answer, 2.x once
  the answer settled) and `default.unlock` (`UnlockConnector`: 1.6 stops a transaction in flight first, 2.x
  refuses to).

  Connector status (stage C1) and transactions (stage C2) are engine-owned now; the behaviors above call
  `ChargePoint`'s facades for them, which dispatch into the engine.

- **Start of a follow-up.** `after` starts in the turn the response settled, up to its first wait, as the
  effects it replaced did (`Uploading` still goes out in the turn of the settlement). Its later steps run
  as promise continuations, so a test that drives them with synchronous fake timers needs the async
  variant (`advanceTimersByTimeAsync`).
- **Connection close.** The follow-up (`after`) of an answer ends when the connection closes, as the
  timers of the old firmware simulation did. It also ends when the behavior is unloaded or the station is
  disposed.
- **Test harness.** `runBehavior()` is `packages/core/src/test/behavior/runBehavior.ts`; see the
  [testing strategy](testing-strategy.md#behavior-tests). Time is virtual, but the socket and the fake
  CSMS are real I/O, so the effect hash covers the ordered, normalized frames and not their timing.

### Determinism

Virtual-time mode runs on Bun and browsers against an in-process fake CSMS or a trace replay: one queue,
a fixed tie-break, seeded streams. Same seed, same effects. Real-time mode (k6, a real CSMS) promises
only explanation through seed and trace.

**V1 (verified on Bun 1.3.14).** `packages/core/src/cp/shared/__tests__/virtualTime.determinism.bun.test.ts`
runs 1,000 simulated chargers with behavior-shaped `async` loops on a `VirtualClock`: random sleeps,
two steps raced against a deadline (`until`), periodic timers, a 40-deep promise chain,
`queueMicrotask`, `try`/`finally`. The ordered effects of the whole fleet are hashed.

- The same seed gives an identical hash on two runs, and a different seed a different one. A control
  run on unseeded streams gives two different hashes, so the hash is not blind. A pinned hash of a
  25-charger run holds across processes.
- Adding a charger to a run leaves the effects of every other charger unchanged (per-charger hashes).
- Six virtual hours of 1,000 chargers (about 977,000 timers) run in about 6 s of real time.

So async functions are deterministic on Bun as long as every wait goes through the clock and every
random draw through a stream; the macrotask hop between two timers is what settles the continuations.
The design stands; no fallback is needed. The condition is the one stated above: a virtual-time run
has no real I/O of its own process in flight (the in-process fake CSMS must itself be driven from
virtual timers or settle synchronously). Not verified here: browsers (the same `setTimeout(0)` fallback
is used where `setImmediate` is absent) and k6.

### Loading code

- CLI and daemon: `--behavior <file>`, repeatable. The daemon needs `--allow-behavior-code` and refuses
  the combination with `--unsafe-remote`. Loaded at start by dynamic import, bundled with `Bun.build`.
- `ocpp-cp-sim behavior build <file>` type-checks and writes one ESM bundle with `--external 'k6/*'`.
- Web: load a built bundle from a local file through `import(blobUrl)`, in the local runtime only.
- k6: `export-k6 --behavior <file>` generates a static import. The k6 host implements `ctx` over the
  existing `ScenarioHost`, OCPP 1.6J only. A behavior whose `requires` the host cannot meet is refused
  at export. Never degrade silently.
- A test harness `runBehavior()` drives a behavior on a `VirtualClock` with a fake CSMS, and asserts the
  same seed gives the same effect hash.

## Out of scope

QuickJS or any sandbox, remote delivery of code, an external-process plugin protocol, a console UI for
writing behaviors, and retiring `export-k6`'s separate implementation.

Status (stage C1): connector status, availability and error info are engine state, with one writer.
Decisions the design left open:

- **State.** `ChargerState.connectors[id]` is a `ConnectorRecord` (`domain/connector/ConnectorRecord.ts`):
  `status`, `availability`, `scheduledAvailability`, `errorCode`, `errorInfo`, `vendorErrorCode`. The record
  type and its reducer live in the domain so that `Connector` can use them without importing the engine.
- **Events.** `connector.added`, `connector.removed` and `connector.write` (a `ConnectorWrite`: `status`,
  `availability`, `scheduledAvailability`, `errorCode`, `errorInfo`, `vendorErrorCode`, `restore`).
  `engine.attachConnector(connector)` runs when `ChargePoint` creates a connector; `detachConnector` when it
  removes one (the connector keeps its last record in a private cell).
- **Connector writes nest.** The one exception to "runs right after the current event": a `connector.*`
  event is reduced and acted on at once, even from inside the listeners of an earlier write. Today's code
  nests exactly so (a `statusChange` listener may call `updateConnectorStatus`), and the order of
  StatusNotifications on the wire follows that nesting; a deferred write would also break
  read-after-write. Errors a listener or the outbox throws reach the caller of the write, as before.
- **Three scopes of a status write** (the wire depends on them): `local` (a bare `connector.status = …`:
  only the connector's own `statusChange` listeners), `event` (also `ChargePointEvents.connectorStatusChange`;
  the offline teardown), `full` (also the connection-timeout timer and the StatusNotification;
  `ChargePoint.updateConnectorStatus`, which now only dispatches). The timer and notification are
  `ChargePoint.afterConnectorStatus`, called by the engine.
- **`Connector` is a read view.** Its getters read the record from the engine; its setters (kept so that
  callers and tests need not change) dispatch a `connector.write`. A connector with no charge point keeps
  the record in a private cell with the same reducer. Only code under `application/engine/` may use the
  setters: `scripts/check-single-writer.ts` (in `check:boundaries`) fails on any other non-test write. It is
  syntactic: the receiver's text must mention "connector". The exemption list is empty.
- **Transition table.** `ConnectorStateMachine` is deleted. `ALLOWED_CONNECTOR_STATUS_TRANSITIONS` moved to
  `domain/connector/ConnectorTransitions.ts`; the engine logs a warning for a `full` write outside it
  (including legitimate flows the table never listed, e.g. Preparing to Finishing on ConnectionTimeOut) and
  applies the write anyway.
- **`StateManager`** keeps `StateHistory` and records `connectorStatusChange` and the charge point's own
  status changes. It no longer has a state machine, `initializeConnector`, `transitionConnectorStatus` or the
  state snapshots.
- **Not in C1.** Transactions, persistence of engine state and resume: see stage C2.

Status (stage C2): transactions, persistence and resume. Decisions the design left open:

- **State.** The transaction is a field of the connector's record: `ConnectorRecord.transaction` is a
  `TransactionRecord` (`domain/connector/TransactionRecord.ts`), plain JSON: the same shape as `Transaction`
  with `startTime` / `stopTime` as ISO strings and unset fields absent (never `undefined`). Two writes:
  `transaction.set` (begin, replace, remove) and `transaction.patch` (field changes; an `undefined` value
  deletes the key). `restore` may carry a transaction. They nest like every `connector.*` event.
- **`Connector.transaction` is a live view.** One `Transaction` object (with `Date`s) per transaction, wrapped
  in a `Proxy`: reads are plain property reads, an assignment to a field dispatches a `transaction.patch`, and
  `applyWrite` keeps the object in step with the record, so holders of the object see every change and its
  identity lasts as long as the transaction does. Assigning `connector.transaction = x` stores a copy of `x`
  (the view is a different object than `x`). Code uses `connector.patchTransaction({...})`,
  `assignTransactionId(id)` and `detachTransaction()`; `infrastructure/transport/handlers/patchTransaction.ts`
  does the same for a `Transaction` that may be detached.
- **`default.transaction`** (`application/engine/behaviors/transaction.ts`) holds `startTransaction`,
  `stopTransaction` and `cleanTransaction` (moved out of `ChargePoint`, which keeps one-line facades with
  its public API), and answers `RemoteStartTransaction`, `RemoteStopTransaction` (1.6) and
  `RequestStartTransaction`, `RequestStopTransaction` (2.x) with the `AuthorizeRemoteTxRequests` and scenario
  delegation behavior of before. The handlers translate. `ChargePoint` hands the module a `TransactionPorts`
  (`sendTransactionEvent`, `startConnectionTimeout`) for the two things it keeps private. Meter value
  calculation (`Connector`, `MeterValueBuilder`) and charging profile resolution (`clearChargingProfiles`)
  stay services.
- **The scenario registry stays.** `_scenarioHandledConnectors`, `_scenarioStopHandledConnectors`,
  `noteDefaultHandledRemoteStart` / `Stop` and `takeDefaultHandled…` are kept. `ScenarioRuntime` arms and reads
  them for parking and for the "raced the default" warning; routing the same through registry rules would move
  who answers and when the warning fires, so it is not a wire-neutral swap. The behavior reads them.
- **Single writer.** `check-single-writer.ts` also guards `connector.transaction`, `connector.transactionId`
  and every `Transaction` field when the receiver's text mentions `transaction` or `tx`.
- **Physical verbs.** `ctx.startCharging` / `stopCharging` use the `ChargePoint` facades, so they run the
  transaction default; `ctx.unplug` calls `evDisconnected` (a running transaction is stopped or suspended per
  `StopTransactionOnEVSideDisconnect`) instead of forcing `Available`. Test: `physical.bun.test.ts`.
- **Persistence.** The `connector_runtime` row format is unchanged (`transaction_json` is the record shape,
  so earlier rows load). `snapshotRuntime` reads the connector's record; the restore write carries the
  transaction into the engine state; `restoreConnectorRuntimeFromDatabase` ends with `engine.resume()`, so
  `onResume` runs once, after the state is back. Only connector rows persist; the `ctx.state` of behaviors and
  the notification statuses do not (a new table is needed; stage D).
- **Reservations stay** in `ReservationManager`: it owns a map of `Date`-carrying records, an expiry
  interval and a callback, and is used on its own by scenarios and tests; moving it needs a store port and a
  codec like the transaction's, which is not a small change.
