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
  - packages/k6-runtime/src/behaviorHost.ts
  - apps/cli/src/exportK6/runExportK6Behavior.ts
  - scripts/verify/browser/run.ts
  - scripts/bench/engineScale.ts
  - "issues #566, #569, #575, #600, #618"
related:
  - ../concepts/scenario-format.md
  - ../entities/cli.md
  - ../sources/bench-readme.md
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
  on?: BehaviorEvents; // connectorStatus, transactionStarted/Stopped, connected, disconnected, callResult, callReceived
  beforeSend?: Record<string, BeforeSend>; // station-initiated CALLs, keyed by action
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
- `accepted(action)` / `rejected(action)`: the valid canned response of this station's version
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
  the station disposes, or (for the handler and `after` of a user behavior's CALL) the connection closes, a pending wait
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
- **Connection close.** What a close ends is the behavior of ca01d302, kept (rule 4). The follow-up of
  an answer a _user_ behavior gave ends when the connection closes. Of the _default_ behaviors only the
  firmware trains (`default.firmware`, `default.signedFirmware`) end: their timers were cleared on a
  close. The GetLog and GetDiagnostics uploads were not tied to the socket and go on across a reconnect;
  their statuses go out once the station is connected again. A follow-up binds to the connection when it
  _starts_, not when the CALL arrives: a close while the answer is still in the pipeline cancels nothing,
  and the train then runs (its first status goes to the dead socket) as it did before. Both end when the
  behavior is unloaded or the station is disposed. (An earlier version bound every default follow-up
  to the connection from the arrival of the CALL; the golden cases `getlog-answered-while-dropping`,
  `firmware-answered-while-dropping` and `firmware-hard-reset-midway`, recorded on the base commit, caught
  it.)
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
virtual timers or settle synchronously). Browsers: verified in stage D2 (see [Verification results](#verification-results));
k6 runs on real time and promises only explanation through seed and trace.

### Loading code

- CLI and daemon: `--behavior <file>`, repeatable (stage D1: done, see its Status). The daemon needs `--allow-behavior-code` and refuses
  the combination with `--unsafe-remote`. Loaded at start by dynamic import, bundled with `Bun.build`, into a library
  by behavior id. Which charge point runs which behavior is data, chosen by id (stage E: done); `--watch-behaviors` and
  `behavior.reload` re-read the same files (stage E: done).
- `ocpp-cp-sim behavior build <file>` type-checks and writes one ESM bundle with `--external 'k6/*'`.
- Web (stage D2: done): `LocalChargePointService.loadBehaviorBundle(id, blob | text)` loads a built bundle through
  `import(blobUrl)`, in the local runtime only.
- k6 (stage D2: done): `export-k6 --behavior <file>` generates a static import. The k6 host implements `ctx` over the
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

Status (stage D1): loading behavior code. Decisions the design left open:

- **Loading.** `--behavior <file>` (repeatable) goes through `apps/cli/src/behavior/`: `Bun.build` bundles the
  file (`target: "bun"`, ESM, `k6` and `k6/*` external), the bundle is written to a temporary directory,
  imported and removed. The default export is one behavior or an array. Every charge point of the process gets
  every behavior, in the order given: the single-CP session's, and in a daemon the bootstrapped, the restored
  and the RPC-created ones (`CPRegistry` option `behaviors`, applied in `instantiate`, so a `cp.update` rebuild
  loads them again). One module instance serves all stations, which is one more reason for the rule against
  module-scope state. A load error stops the start (exit 1) with the file's name; a duplicate id across files
  is refused.
- **The authority flags.** A daemon needs `--allow-behavior-code`; `--allow-behavior-code` with
  `--unsafe-remote` is refused whether or not `--behavior` is given (a daemon that runs code from disk must not
  drop its network protections). `startServer` also refuses `behaviors` without `allowBehaviorCode`, so other
  callers meet the same door. A single-CP session needs no opt-in: the operator ran it. `--behavior` is refused
  with the client modes. No RPC method, MCP tool or OCPP message loads code; `behaviorCodeIsNotRemote.bun.test.ts`
  shows a `load_scenario` full of code-like fields is data.
- **`behavior build`.** First the syntax check (`for await`, async generators, `using`, over every non-library
  source of the TypeScript program), then the type check (strict, `lib.es2017.d.ts` only, no ambient types, so
  `AbortController`, `structuredClone`, `performance` are errors; `k6` and `k6/*` imports need no types), then
  `Bun.build` with a plugin that lowers every project source with `ts.transpileModule` to ES2017 (Bun itself
  does not lower) and checks the syntax again for `.js` sources. The syntax check goes first because the ES2017
  library reports the same constructs as "cannot find name".
- **ESLint config.** `@ocpp-cp-sim/contracts/eslint-behavior` (`packages/contracts/eslint/behavior.js`, plain
  JavaScript so that a user's config can import it without a TypeScript loader). Syntax rules only: it needs the
  user's parser. Module-scope state is reported as `let` / `var`, `new Map|Set|WeakMap|WeakSet|Array|Object`,
  and an empty `[]` or `{}`; a non-empty constant table is allowed.
- **The template.** `examples/behaviors/flaky-firmware.ts` and its test. It does not list `virtual-time` in
  `requires`: that capability means "needs a virtual clock" and a station on real time refuses the behavior
  (found by the end-to-end run, where the first version failed to load).
- **Persistence.** One additive table `engine_state` (schema 23), a JSON row per charge point holding the
  statuses and `behaviors[id]` (`PersistedEngineState`). The engine calls an `onPersist` listener after every
  processed event and whenever a behavior yields (`ctx.sleep`, `until`, `send`, end of a handler, `main` or
  follow-up); the service compares the JSON and writes only changes, so a behavior's `ctx.state` writes settle
  at its next yield and a crash loses at most what it wrote since. The row is read in the service constructor
  (`engine.restoreState`): statuses are set without sending anything, `ctx.state` is filled in place, and the
  state of a behavior that is not loaded yet or this run is kept as an orphan, adopted when it loads and kept in
  the row if it never does. A row that does not parse is ignored. The row also survives a `cp.update`.
- **Resume order.** `engine.resume()` moved out of `restoreConnectorRuntimeFromDatabase` into
  `CLIChargePointService.resumeEngine()`, which `CPRegistry.restoreFromDatabase` calls after
  `reconcileChargingSessions`. The reconcile only reads the connectors and writes the session history, so the
  order is safe, and an `onResume` that starts a transaction now sees the restored sessions settled.
- **Harness without real I/O.** `runBehavior` defaults to `transport: "memory"`: a `MemoryWebSocket`
  (`goldenWire/memoryTransport.ts`) replaces `globalThis.WebSocket` for the fake CSMS's address only and
  delivers frames through promise jobs; `FakeCsms.settle` waits for event-loop turns (`setImmediate`, the same
  hop `VirtualClock` uses) instead of real milliseconds. A single `advance(6 hours)` over a behavior that waits
  for each answer works. `transport: "socket"` keeps the real WebSocket. The golden wire test is unchanged and
  still on the real socket. Limit: the HTTP upload sink used by diagnostics and logs (`Rig.uploadUrl`) is still
  a real server, so a test of those two uploads is not free of real I/O.
- **Not in D1.** Web loading of a bundle, `export-k6 --behavior` and a k6 `ctx` host (stage E).

Status (stage D2): k6, browser and scale. Decisions the design left open:

- **k6 host.** `BehaviorHost` (`packages/k6-runtime/src/behaviorHost.ts`) implements `BehaviorContext` over
  `OcppChargePoint`, which is the `ScenarioHost` the interpreter drives. The charge point got three small
  additions: `setCallHandler` (a host claims the inbound CALLs of its rules; every other CALL still goes to the
  auto-responder), `sendRaw` and `cpId`. `onCall` rules are `replace` only; a rule holds one open exchange and a
  second CALL gets `onBusy` (default CALLERROR `GenericError`); `after` runs once the frame went out. Waits are
  timers of the host (`k6/timers`, injected as a port so the host is testable), tracked so that stopping rejects
  them with `BehaviorStopped`. The types are mirrored in `behaviorTypes.ts` (the k6 runtime may not import another
  package); `behaviorTypes.test.ts` holds the mirror and the contract assignable to each other.
- **What the k6 host does not provide, and refuses at export** (`runExportK6Behavior.ts`): `requires` of
  `physical`, `virtual-time`, `ocpp2.x` (it provides `ocpp1.6` and `raw-frames`); `mode: "extend"` and
  `ctx.defaultBehavior` (the k6 auto-responder has no follow-up effects to extend); `ctx.connector` and the
  physical verbs. The ctx check is syntactic over the built bundle (a property of the same name is flagged
  too); the members also throw at run time. The export imports the built bundle in Bun to read `requires` and
  the rules, so a behavior that imports `k6` modules cannot be exported (it says so). Responses are not
  schema-checked on k6.
- **An iteration always ends.** Env: `RUN_FOR_MS` (a length), `CHARGERS_PER_VU` (ids get `-1`, `-2`, …), `SEED`.
  Without `RUN_FOR_MS`, a behavior with a `main` ends with its mains, one without serves CALLs for 60 s. On a
  `steady` / `soak` profile the iteration also stops 2 s before the end of `DURATION`, so k6's `gracefulStop`
  is never needed, and an iteration that would start in the last 2 s waits the run out instead of looping.
  A `main` that waits on something outside the host is abandoned after 1.5 s and the iteration is reported failed.
- **`ctx.random(...).int` is inclusive at both ends**, as the contract says. The core adapter passed the
  core stream's `[min, max)` through; `ChargerEngine` now adds one to the upper bound. The k6 stream uses the
  same algorithm and key as the core one, so the same seed, charge point id and stream name draw the same numbers
  (`behaviorHost.test.ts`).
- **Web.** `LocalChargePointService.loadBehaviorBundle` / `unloadBehavior`. Programmatic only: no console UI was
  added (the settings page has no natural place for a code loader, and the design keeps a UI for writing behaviors
  out of scope); `scripts/verify/browser/page.ts` has the minimal file input the check uses. Behaviors are not
  persisted by the page. `behaviorsOfModule` moved to `application/engine/behaviorModule.ts` so the CLI, the export
  and the web service share it.
- **`drainMicrotasks` hops with a `MessageChannel` where `setImmediate` is absent** (browsers). `setTimeout(0)` was
  the fallback; see the measurement below.

### Status (stage E): hooks, send interception, assignment, reload

Everything below is additive. With no behavior that uses these features, the wire traffic is unchanged: the golden
wire test passes with the fixtures of its first 157 cases untouched (`testing-strategy.md` lists what its
normalization hides and the 175 cases added later), and the hot paths cost one boolean check
(`hooked` / `intercepting` on the engine). Decisions the design left open:

**Event hooks (`Behavior.on`).**

| Hook                         | Payload                                                        | Raised when                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connectorStatus`            | `{ connectorId, from, to }`                                    | A connector's status record changes (every writer, local ones included; a write that keeps the value raises nothing, a restore raises nothing)                               |
| `transactionStarted`         | `{ connectorId, transactionId, idTag }`                        | The connector gets a transaction record; on 1.6 `transactionId` is `0` until the CSMS answers, on 2.x the station's UUID                                                     |
| `transactionStopped`         | `{ connectorId, transactionId, idTag, reason? }`               | The record gets its stop time (or is removed while running), once per transaction                                                                                            |
| `connected` / `disconnected` | `{ at }` / `{ at, code?, reason? }`                            | The socket really opened / closed. The synthesized `connected` of a repeated `connect()` is not one. SOAP: when the callback is up                                           |
| `callResult`                 | `{ action, messageId, outcome: "result" \| "error", payload }` | The CSMS answered a station-initiated CALL, any of them (automatic messages, `ctx.send`, the `ocppCall` node). An error carries `{ errorCode, errorDescription }` as payload |
| `callReceived`               | `{ action, messageId, payload }`                               | The CSMS sent a CALL, before the gate looks at it. Observation only: it cannot change the answer                                                                             |

- **Delivery.** Events go on one FIFO queue and are delivered in a microtask after the turn that caused them,
  so a hook never runs inside the event (or inside the handler that raised it) and the state it sees is the state
  after the change (`ctx.connector()` shows the new status; the payload carries `from` / `to` for hooks that run
  later than the change). Hooks of several behaviors run in load order. A hook may be async; the engine does not
  await it. A hook that throws or rejects is logged as a warning and the charger carries on. An event raised while a
  hook runs (the hook wrote a status, sent a CALL) joins the queue and its hooks run after the running hook returns,
  so a hook's own writes never nest, and the wire order is: the traffic of the event, then the traffic of the hook.
  The order depends only on program order, so the same seed gives the same effects on a `VirtualClock`
  (`hooks.bun.test.ts`, 16 cases, one of them hashes two runs).
- Payloads of `callResult` / `callReceived` are copies; a hook cannot change what the engine holds.
- Dormant behaviors (loaded for a scenario's `useBehavior`) do not get hooks or `beforeSend`.

**Send interception (`Behavior.beforeSend`).**

- One choke point per transport: `sendRequest` on 1.6 and `send` on 2.x. Every station-initiated CALL passes it:
  automatic messages, `ctx.send`, `ocppCall` nodes and control-plane expert calls. The expert path asks before the
  call is tracked, so the `sentFrame` it reports is the frame that went out. `ctx.raw` writes a frame as given and is
  outside. A CALL the boot gate suppresses never reaches it. A SOAP station refuses a behavior with `beforeSend`
  at load (`Behavior x uses beforeSend, which needs an OCPP-J station`).
- The key is the wire action. On a 2.x station `StartTransaction` and `StopTransaction` also name `TransactionEvent`
  with `eventType` `Started` / `Ended`; the payload handed over is always the one of the station's own version. Other
  1.6 and 2.x names that differ (`MeterValues` in a 2.x transaction rides `TransactionEvent`) are not translated.
- Signature `(payload, ctx) => payload | { drop: true } | undefined`, synchronous. `payload` is a copy;
  returning nothing leaves the CALL as it was (mutating the copy changes nothing). A returned promise, a throw or a
  non-object is a warning and the CALL goes on unchanged. Behaviors chain in load order, each seeing the result of
  the one before. A rewritten payload goes through the existing outgoing schema warning (a warning, the CALL is
  still sent).
- **One rule on both versions: every transmission is intercepted once, starting from the payload as the station
  built it.** A resend after a CALLERROR (1.6 and 2.x transaction retries) and a replay from the offline queue are
  new transmissions, so a behavior sees them again; the queue and the request history keep the payload _as built_,
  never the rewritten one, so a rewrite is applied once to what goes on the wire and a behavior never rewrites its
  own output. A CALL handed over while the socket is down is not transmitted: beforeSend does not see it until it
  is replayed (a CALL already queued behind another when the socket closes may be seen twice, once for the
  attempt that never left and once on the replay). The answer is matched with the CALL as built, so rewriting a
  `StartTransaction` `idTag` or `timestamp`, or an `Authorize` `idTag`, does not cut the CALL from its answer.
- A `beforeSend` drop of a replayed 2.x `TransactionEvent` removes its row from the offline queue (it is not a
  refusal by the socket, which keeps the row at the head).
- A `ctx.send` made from inside a `beforeSend` waits one microtask, so it is queued after the CALL being intercepted.
- **Dropped CALL.** Nothing is queued and nothing is written. Whoever waits is told through the path a CALL that
  never reached the wire already had: `OcppCallNoAnswerError("dropped")` for `ctx.send` / `ocppCall` / expert calls,
  the DataTransfer waiter's rejection, a lost first transmission for a 2.x `TransactionEvent`. The serial queue of 1.6
  is not held (no slot is taken), and a dropped Heartbeat still re-arms the idle timer, otherwise the periodic
  Heartbeat would stop for good. A dropped `StartTransaction` leaves the transaction without a CSMS id, as an
  unanswered one would; later CALLs go out (`beforeSend.bun.test.ts`: Heartbeat, MeterValues, StartTransaction).

**Per-charger assignment.**

- `--behavior` fills a `BehaviorLibrary` (`apps/cli/src/behavior/BehaviorLibrary.ts`): behavior id to behavior, in load
  order. A charge point's `behaviors: string[]` selects from it by id: absent runs every loaded behavior (today's
  behavior), `[]` none. Unknown ids are `invalid_params` naming the loaded ids, before anything is created or
  persisted. It is accepted by `cp.create`, `cp.create_many`, `cp.update` (omitted keeps the current list), blueprints
  (`blueprintSchema`, through `params`), the CLI (`--use-behavior <id>` for the charge points the command line starts)
  and `cp.behaviors.set` (in place, `null` = all). `behavior.list` shows the library.
- It persists with the charge point (`charge_points.behaviors`, schema v24; `NULL` = all). On restore an id that is
  no longer loaded is dropped with a warning.
- **No code over the wire.** `behaviors` is `string[]` and is only ever looked up in the library; a string that looks
  like source or a path is an unknown id. The tests feed source text, a path and a `data:` URL to `cp.create` and
  `cp.behaviors.set` and check that nothing ran, that `behavior.reload` and `behavior.list` refuse any parameter
  (strict schemas), and that no method named like a loader exists (`behaviorAssignment.bun.test.ts`).
- Changing the selection at run time unloads the behaviors no longer selected (their `ctx.state` is dropped with
  them) and loads the new ones after those already running, so the load order of a charge point can differ from the
  library order after a change.

**Reload.**

- `BehaviorLibrary.reload()` re-reads the paths given at start (`behavior.reload` takes no parameters;
  `--watch-behaviors` watches the directories of the files, 150 ms debounce, and calls the same function). A file
  whose bundle hash equals the loaded one is skipped; a file that fails to build or load, or whose set of behavior ids
  changed, keeps its old version and the error is logged and returned. Reloads run one at a time. Each read imports
  a bundle from a fresh `mkdtemp` directory, removed afterwards, so the module cache never serves an old version.
- `ChargerEngine.replaceBehavior(next)` validates `next` first (`requires`, `beforeSend` on SOAP, rule registration;
  any failure leaves the old version untouched), then swaps the rules. An exchange in flight finishes on the old code
  (its closure holds it); a CALL after the swap gets the new one. Hooks and `beforeSend` resolve the behavior at
  delivery, so they switch at once. `ctx.state` survives (it is keyed by id). A running `main` and the hooks'
  context are asked to stop (`ctx.stopping` turns true, waits still work) and are cut off after
  `ChargerEngine.RELOAD_GRACE_MS` (5 s, the station's clock); the new `main` starts when the old one returned or the
  grace time is over. Unloading, disposing or reloading again during the grace time cuts the old work off at once.
  The scenario rules of a dormant behavior keep the old version until their run ends.
- Web: `loadBehaviorBundle` again with a bundle whose behavior id is already loaded on that charge point replaces it
  under the same rules (checked in Chromium).

**`ctx.accepted(action)` / `ctx.rejected(action)`** try `{ status: "Accepted" }` (`"Rejected"`) and, for `accepted`,
`{}` against the bundled response schema of the action for the station's version and return the first that is valid.
`UpdateFirmware` is `{}` on 1.6 and `{ status: "Accepted" }` on 2.x. An action with no bundled schema, or whose response
needs more than a status or has no such status, throws `ctx.rejected("UpdateFirmware"): the UpdateFirmware response on
OCPP-1.6J has no Rejected answer; build the response by hand`. Either version's spelling of the action is understood.
The template `flaky-firmware.ts` uses it.

**k6.** Provided: `connected`, `disconnected`, `callResult`, `callReceived`, `beforeSend` (the k6 client asks the host
inside `call()`, the one place every CALL is queued, so the automatic Heartbeat is covered) and `accepted` / `rejected`
(the export writes the 1.6 answers into the entry script). Refused at export, never ignored: `connectorStatus`,
`transactionStarted`, `transactionStopped` (no connector or transaction model). Assignment and reload do not apply
to k6 (one export is one set of behaviors).

Tests that target code this stage changes: none was deleted or weakened. `methods.test.ts` counts the explicit methods
(46 to 49), the MCP tool lists of `mcp.test.ts` and `mcpToolSchemaParity.test.ts` gained three tools, and handler unit
tests with hand-written station doubles needed nothing: the transports read the engine through `behaviorTapOf`, which
passes everything through for a double without an engine.

## Verification results

All numbers were measured in the stage D2 container (4 cores, 11 GiB RAM, Linux x86_64, Bun 1.3.14), on
2026-11-07. The tools are in the repository; none of the runs needed a change to the design.

| Item                             | How                                                                                                                                                                                                                                                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| k6, 5 VUs                        | `export-k6 --behavior examples/behaviors/flaky-firmware.ts`, then `VUS=5 DURATION=25s RUN_FOR_MS=14000 SEED=d2 k6 run behavior.k6.ts` against `scripts/verify/fakeCsms16.ts --update-firmware` over a real WebSocket                                        | **Pass.** k6 v2.3.0 (go1.26.8). The CSMS recorded 120 frames: 5 charge points x 2 iterations, each iteration one BootNotification, one `UpdateFirmware` answered `{}`, and the four `FirmwareStatusNotification`s `Downloading`, `Downloaded`, `Installing`, `Installed` at the behavior's seeded delays (+0.5 s, +1.9 s, +0.5 s, +3.8 s for CP-1). `scenario_success` 100 % (10 of 10), `ocpp_calls` 50, 0 interrupted iterations                          |
| k6, 1 VU, several chargers       | `examples/behaviors/heartbeat-loop.ts`, `VUS=1 CHARGERS_PER_VU=8 DURATION=14s`                                                                                                                                                                              | **Pass.** 8 charge points on one VU, 192 frames, 11 Heartbeats each at one-second spacing, `scenario_success` 100 %, 0 interrupted, the VU finished at 14.0 s                                                                                                                                                                                                                                                                                               |
| k6, `gracefulStop`               | `scripts/verify/behaviors/hang.ts` (a `main` awaiting a promise that never settles), `VUS=2 DURATION=8s`                                                                                                                                                    | **Pass.** 4 iterations, 0 interrupted: two of 7.5 s (stopped at `DURATION` − 2 s = 6 s, the hung `main` abandoned after 1.5 s) and two of 0.5 s (the wait-out of the last seconds). The run ended at 8.0 s; a hung iteration would have kept it open for k6's default 30 s `gracefulStop` more. The hang was reported, not hidden: `scenario_success` 0 % and `main of "hang" did not stop in time`                                                         |
| k6, refusals                     | `behaviorExport.bun.test.ts`                                                                                                                                                                                                                                | **Pass.** `requires` `physical` / `ocpp2.x`, `mode: "extend"`, `ctx.plugIn`, a destructured `connector`, a missing file and `--scenario` together with `--behavior` each exit 1 with the reason and write nothing. The runtime copies import no `sleep` from `k6`                                                                                                                                                                                           |
| Browser, behavior                | Playwright (`playwright-core` 1.65.0) driving the preinstalled Chromium 158 (revision 1254, nothing to install): the page loads `flaky-firmware.bundle.js` from a file input with `import(blobUrl)` on `LocalChargePointService`, connects to the fake CSMS | **Pass.** The CSMS saw BootNotification, two StatusNotifications and the four `FirmwareStatusNotification`s of the same behavior. `typeof setImmediate` is `"undefined"` in the page                                                                                                                                                                                                                                                                        |
| Browser, determinism             | The V1 fleet of `virtualFleet.ts` run in the page and on Bun, effects hashed with SHA-256                                                                                                                                                                   | **Pass: identical.** 25 chargers x 1 h: `c745d5ba…` (the pinned hash of the Bun test); 200 x 1 h: `dbe7112e…`; 1,000 x 6 h: `e2babcf3…`, 1,317,480 effects, 980,637 timers; Chromium 9.9 s, Bun 8.6 s                                                                                                                                                                                                                                                       |
| Browser, `setImmediate` fallback | Same fleet, 25 chargers x 1 virtual hour                                                                                                                                                                                                                    | **The first fallback failed on speed, not on correctness.** With `setTimeout(0)` the hash matched but took **17.3 s** in Chromium (38 ms on Bun): a browser clamps nested timers to 4 ms per macrotask hop. `drainMicrotasks` now uses a `MessageChannel`: 200 chargers x 1 h in 284 ms (Bun 182 ms), same hashes. `clock.browserHop.bun.test.ts` covers the path                                                                                           |
| Scale, bare behavior loops       | `bun scripts/bench/engineScale.ts --mode bare`, one process per row                                                                                                                                                                                         | 1,000: 1.1 KB heap and 13 KB RSS per charger, 0.18 s per virtual hour. **10,000: heap +11 MB (1.2 KB each), RSS 99 to 148 MB, 2.9 s per virtual hour**, 595,684 timers                                                                                                                                                                                                                                                                                      |
| Scale, real `ChargePoint`        | `--mode cp`, in-memory socket, 1.6J, no database                                                                                                                                                                                                            | **10,000 real `ChargePoint` instances fit, using about 1.3 GB at peak of the 11 GiB.** 1,000: heap 54 KB per charger, RSS 150 KB, 2.0 s per virtual hour; 2,000: 52 KB, 133 KB, 4.4 s; 5,000: 50 KB, 127 KB, 12.7 s; **10,000: heap 495 MB (49 KB per charger), RSS peak 1,312 MB (it fell to 736 MB after a GC), 31.9 s per virtual hour** for 625,100 messages and 1,195,100 timers. Time per charger-hour grows from 2.0 ms at 1,000 to 3.2 ms at 10,000 |
| Scale, real sockets              | `--mode cp-ws --n 1000`                                                                                                                                                                                                                                     | The same 1,000 charge points on real WebSockets to a CSMS in another process: heap 55 KB per charger, RSS 139 KB per charger (memory transport: 150 KB), 3.6 s per virtual hour (the hour is virtual; the sockets idle)                                                                                                                                                                                                                                     |

What the scale numbers do not cover: a database per charge point (the daemon's `CPRegistry` adds SQLite rows and
the `engine_state` JSON), a log sink (the logger had every type off), a UI, and the CSMS's own memory; the
a real WebSocket per charger cost no more in this process (139 KB against 150 KB of RSS per charger at 1,000; the socket buffers live in the kernel). A daemon with 10,000
charge points would add its persistence to the 49 KB per charger measured here; at that size it was not tried.
Real-time behavior at 10,000 chargers (event loop lag of the fleet against a real CSMS) is also not measured:
`fleet-bench.ts` is the tool for that.

Found while measuring, fixed in the same stage:

- The scenario export did not load on k6 2.3.0: its generated imports had no file extension
  (`./ocpp-runtime/index`) and k6 resolves none. Every import of the runtime now names its `.ts` file; the one
  assertion and the golden snapshot of the entry script changed by those characters. The scenario export itself
  was loaded by k6 afterwards (its scenario run was not exercised against a CSMS that answers its triggers).
- `ctx.random(...).int` was exclusive at the top in the core host and inclusive in the contract (fixed above).
- The browser fallback of `drainMicrotasks` (fixed above).
- Not found failing, but not exercised: the `spike` and ramping profiles with behaviors, mTLS, and k6 versions other
  than 2.3.0 (the generated README says `k6 >= 1.6`; that floor was not re-tested).

### Stage E

Measured on 2026-11-07 in the stage E container (Bun 1.3.14, k6 v2.3.0, Chromium 158 through `playwright-core` 1.65.0).

| Item                        | How                                                                                                                                                                                                                                                                                                                                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The real daemon, end to end | `bun scripts/verify/e2e/behaviorsDaemon.ts`: `main.ts --http-port … --allow-behavior-code --watch-behaviors` with three behavior files, a local CSMS over a real WebSocket, two charge points created over `cp.create` with different `behaviors`; the CSMS records every frame                                                             | **Pass, 15 checks.** CP-A (`disconnect-on-charging` + `answer-reset`) answered `Reset` `Accepted`, CP-B (`reset-rejects`) `Rejected`. CP-A's MeterValues carried `1000` for the energy register where CP-B's carried `0` (the example's `beforeSend`); the CSMS received CP-A's malformed frame `[9,"misbehave","NoSuchAction",{}]` 2.8 s after Charging. An unknown id was refused naming the three loaded ids                                                           |
| Reload without a restart    | The script edits `answer-reset.ts` (`accepted` to `rejected`) while the daemon runs                                                                                                                                                                                                                                                         | **Pass.** The next `Reset` to CP-A was answered `Rejected`; same daemon pid, each charge point still on its first connection (1 open each). A syntax error in the file kept the old version (still `Rejected`) and the daemon logged `keeping the old version`. `behavior.reload` then applied the fixed file to 1 charge point (`applied: 1`); a `file` parameter was refused. `cp.behaviors.set` moved CP-B to `answer-reset` in place (`Accepted`, still 1 connection) |
| k6                          | `export-k6 --behavior scripts/verify/behaviors/k6-hooks.ts`, `VUS=1 DURATION=12s RUN_FOR_MS=6000` against `fakeCsms16.ts --update-firmware`                                                                                                                                                                                                 | **Pass.** `UpdateFirmware` answered `{}` (`ctx.accepted` on 1.6). The CSMS saw `Downloading`, `Installing`, `Installed`, each with `requestId: 42` (`beforeSend` rewrite) and no `Downloaded` (dropped, nothing sent, the behavior went on). The hooks `connected`, `callReceived` and `callResult` fired; 3 iterations, 0 interrupted                                                                                                                                    |
| Browser                     | `scripts/verify/browser/run.ts`: the page loads `flaky-firmware.bundle.js` twice into the same charge point                                                                                                                                                                                                                                 | **Pass.** The second load replaced the behavior (no "already loaded" error, one behavior serving); the CSMS saw the four `FirmwareStatusNotification`s; the determinism hashes of D2 were unchanged                                                                                                                                                                                                                                                                       |
| Tests                       | `bun run typecheck`, `lint`, `check:boundaries`, `format:check` green. `bunx vitest run`: 6 files / 80 tests fail, all `CloseEvent is not defined`, the baseline (5403 passed against 5260). `bun run test:bun`: 2096 pass, 1 skip, 0 fail (baseline 1719). Golden wire: 157 cases plus the uniqueness test (158 tests), fixtures untouched | New: `hooks` 16, `beforeSend` 15, `reload` 8, `responseHelpers` 6, `behaviorLibrary` 6, `behaviorAssignment` 10, the example 3, k6 host 8 + export 2, contracts 5, CLI flags 5                                                                                                                                                                                                                                                                                            |

Not covered: `--watch-behaviors` on a network file system (`fs.watch` recursive on Linux), a reload while thousands of
exchanges are in flight, hooks on SOAP stations beyond `connected` / `disconnected`, and the `callResult` hook for a
timed-out CALL (there is no answer to report; the waiter's own timeout is the signal).
