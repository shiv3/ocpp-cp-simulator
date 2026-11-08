---
title: Charger engine
type: concept
summary: The contract of the charger engine as shipped — one owner of charge point state, behaviors as TypeScript modules behind a narrow ctx port, one inbound gate, an injectable clock — with the behavior API, its stability, the delivery timings, the security line and the limits.
sources:
  - packages/core/src/cp/application/engine/ChargerEngine.ts
  - packages/core/src/cp/application/engine/ChargerState.ts
  - packages/core/src/cp/application/behavior/BehaviorRegistry.ts
  - packages/core/src/cp/infrastructure/transport/inbound/CallExchange.ts
  - packages/core/src/cp/infrastructure/transport/inbound/InboundCallGate.ts
  - packages/core/src/cp/shared/clock.ts
  - packages/core/src/cp/shared/rng.ts
  - packages/contracts/src/behavior.ts
  - packages/k6-runtime/src/behaviorHost.ts
  - apps/cli/src/behavior/BehaviorLibrary.ts
  - apps/cli/src/exportK6/runExportK6Behavior.ts
  - apps/web/src/components/scenario/ScenarioEditor.tsx
  - "issues #566, #569, #575, #600, #618"
related:
  - call-precedence.md
  - scenario-format.md
  - ../entities/default-behaviors.md
  - ../entities/cli.md
  - ../entities/daemon.md
  - ../analyses/scenario-or-behavior.md
  - ../analyses/charger-engine-migration.md
  - ../analyses/testing-strategy.md
updated: 2026-11-08
---

# Charger engine

The charger engine is the part of the simulator that owns what a charge point _is_ and _does_: its state,
its default reactions to the CSMS, and the narrow API through which scenarios, the console and user code
change either. This page is the contract as shipped. How it got here (stages, decisions, measurements, the
reviews) is in the [migration history](../analyses/charger-engine-migration.md); where this page and the code
disagree, the code wins and this page is the bug.

Read next: [what the station does by default](../entities/default-behaviors.md), [who answers a
CALL](call-precedence.md), [Scenario or behavior?](../analyses/scenario-or-behavior.md), and for the flags
the [CLI](../entities/cli.md#behavior-code---behavior-and-behavior-build) page.

## Stability

**`api: 1` is a preview.** The behavior contract (`@ocpp-cp-sim/contracts/behavior`, `Behavior.api: 1`) is
usable and tested, but it is not final until the charger-engine work is on `main` and has been used outside
this repository. Until then a breaking change to it bumps `api` (a behavior with another `api` is refused at
load), and the change is listed in the [log](../log.md). The word _experimental_ below marks the members most
likely to change; the type comments in the contract say the same.

| Member                                          | Status                                                                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.raw`                                       | **Experimental.** Bypasses validation and `beforeSend` on purpose; needs `raw-frames`                                                                      |
| `ctx.setConnectorStatus`                        | **Experimental.** Writes a status without the checks the physical verbs keep; needs `physical`. Prefer `plugIn`, `unplug`, `startCharging`, `stopCharging` |
| `onResume`                                      | **Experimental.** Runs when the boot is accepted; async positions are not restored; never runs on a station that does not boot or for a dormant behavior   |
| `useBehavior` and dormant behaviors             | **Experimental.** The meaning of "selects" (all or none, below) may change                                                                                 |
| Browser `loadBehaviorBundle` / `unloadBehavior` | **Experimental.** Programmatic only; no console UI, nothing is persisted by the page                                                                       |
| `ctx.defaultBehavior`, `mode: "extend"`         | Preview, expected to stay; the set of actions that can be extended grows with the defaults                                                                 |
| `beforeSend`, `on` hooks                        | Preview, expected to stay; the 2.x key table below may gain sugar, never lose a key                                                                        |
| Everything else in the contract                 | Preview                                                                                                                                                    |

## Rules

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

1. **Behavior is code.** Behaviors are plain TypeScript modules, not a JSON DSL. Default behaviors are
   written against the same `ctx` API as user behaviors. Users override a part; they never reimplement a
   charger.
2. **Calculations stay as services.** `ChargingScheduleResolver`, `MeterValueBuilder`, charging curves,
   `CertificateStore`, `ConfigurationStore`, the authorization cache, OCPP codecs and network simulation are
   not rewritten.
3. **JSON scenarios stay.** They keep GUI editing, pause / step / resume, and fleet declaration. They drive
   the engine and may select behaviors. Existing files keep working unchanged.
4. **No behavior change unless configured.** With no behavior configured, the bytes on the wire and their
   order are the same as before. In particular 2.x `UpdateFirmware` stays ack-only by default. This is
   judged by the [golden wire test](../analyses/testing-strategy.md#golden-wire-test), whose fixtures are
   recorded on the base commit, never on the branch.
5. **No code over the wire.** Socket.IO, MCP and OCPP accept JSON only (#569 forbids executable content).
   Code loads only from local files named on the command line, behind an explicit flag; see [Loading code and
   the trust line](#loading-code-and-the-trust-line).

### Where this is going

One engine. The scenario executor is meant to become a client of the same `ctx` (a node is a `ctx` verb:
see the mapping in [Scenario or behavior?](../analyses/scenario-or-behavior.md#json-node-and-ctx-verb)), so
that JSON and code converge instead of drifting; until then they share the gate, the registry and the
default behaviors, which is where they meet. The k6 runtime keeps its own host
(`packages/k6-runtime/src/behaviorHost.ts`) over its client until a measurement shows a reason to unify it;
`export-k6` refuses what that host cannot run, never degrades. The single-writer rule, the three write scopes,
the connector setters and the transaction `Proxy` are compatibility measures with a removal target, listed
under [Transitional](#transitional).

## Parts

### Clock and random

```ts
export interface SimClock {
  now(): number; // epoch ms
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}
```

`RealClock` wraps the platform and reads `Date` and the timer functions from the global object at call time,
so fake timers still steer it; `now()` reads through `new Date().getTime()`, so a test that stubs the global
`Date` constructor steers it too (debt: this is compatibility with existing tests, not design). `VirtualClock`
keeps one queue ordered by (time, charger id, sequence) and offers `advanceBy(ms)`, `advanceTo(t)` and
`runUntilIdle()`. Between two timers these `await` a full microtask drain (one macrotask hop: `setImmediate`,
else a `MessageChannel`, captured at load) so that async behaviors settle before time moves on. It refuses a
non-finite target and a storm of zero-delay timers, runs advances one after the other and clamps an interval to
1 ms. `RngStreams(seed)` derives a stream from `hash(seed, chargerId, streamName)` (cyrb128 into sfc32), so
adding a charger or a stream does not change another's numbers; `Rng.int(min, max)` throws unless `max > min`.
The unseeded variant (`Math.random`, `crypto.randomUUID`) is what a station without a seed uses, so the
default stays as before.

`ChargePoint` takes an optional `{ clock, seed }`; the clock is read-only after construction. All `domain/` and
`application/` code uses it, and so do the two JSON message handlers with the waiters and senders they own
(`CallWaiters`, `ExpertCalls`, `RawFrameSender`): their timestamps, the 30 s CALL timeout, the
`TransactionEvent` resend and timeout timers, the 2.x `GetCompositeSchedule` anchor and the generated-at
stamps of reports (`ChargePoint.nowDate()`), and their message and transaction ids (streams `message-id` and
`transaction-id`). `scripts/check-direct-time.ts` (in `check:boundaries`) lists direct `Date.now`, `new Date()`,
`setTimeout`, `setInterval` and `Math.random` in those places against a shrinking exemption list.

**What virtual time covers, exactly.** Everything above, and the engine and the behaviors. It does _not_ cover
the rest of `infrastructure/transport`: the WebSocket (reconnect back-off, ping and pong timers, the network
simulation's delays), the SOAP handler and the certificate-refresh machinery keep platform timers, as does the
real socket to a fake CSMS. A virtual-time run therefore has to be driven so that nothing waits on those (the
in-memory socket of `runBehavior()` has none), and `effectHash` normalizes the timestamps and ids of the wire:
it proves the order of effects, not the values, which the tests in
`packages/core/src/test/regression/virtualWire.bun.test.ts` check. A seeded run draws message ids and
transaction ids from the seed, so two runs of one seed agree. The platform timers of the transport are the next
determinism boundary.

### CallExchange and InboundCallGate

`CallExchange` is one inbound CALL. State: `open | answered | suppressed | abandoned`. The first answer is
sent; a later answer is not sent and throws. `respond()` and `respondError()` return a promise of
`ExchangeSettlement` that always resolves: `{ delivered: true }` or `{ delivered: false, reason }`; `reply()` and
`replyError()` observe nothing and give the transport no hook unless the answer carries an effect (a hook would
change how the network simulation logs a discard, which rule 4 forbids). A CALL is announced once
(`incomingCallCompleted`) even when its first write threw and the caller answers again with a CALLERROR.

`InboundCallGate` runs, once for every OCPP version: `incomingCallReceived`; `inboundPolicy`;
`responseOverride`; `BehaviorRegistry.resolve()`; then the default path (2.x validates its payload here).
Step 4 runs before validation, so a rule can own a malformed CALL. The full order and what wins is in
[Who answers an inbound CALL](call-precedence.md).

**Synchronous means the selection, not the handler.** The gate chooses who answers in the turn the CALL
arrived, and the default path answers in that turn: a 2.x CALLRESULT is never deferred by a microtask (#456).
A _user_ handler (`handle(req, ctx): CallOutcome | Promise<CallOutcome>`) may answer later, as an async
function does; the exchange stays open meanwhile and holds its rule busy. What must not be async is the
selection and the default behaviors, which answer synchronously.

SOAP: a `replace` rule on a SOAP station fails the run at arm time and never falls back silently; a
`beforeSend` behavior is refused at load; a SOAP station does get default behaviors, which do not go through
the gate. See [OCPP versions and transports](ocpp-versions-and-transports.md#soap-and-behaviors).

### Behavior API

Types only, in `packages/contracts/src/behavior.ts` (import `@ocpp-cp-sim/contracts/behavior`; it is not
re-exported from the package index, whose names would collide). `api: 1` is a [preview](#stability).

```ts
export interface Behavior {
  api: 1;
  id: string;
  requires?: readonly BehaviorCapability[]; // "ocpp1.6" | "ocpp2.x" | "physical" | "raw-frames" (a closed set)
  onCall?: Record<string, CallBehavior>; // keyed by action, either version's spelling
  on?: BehaviorEvents; // connectorStatus, transactionStarted/Stopped, connected, disconnected, callResult, callReceived
  beforeSend?: Record<string, BeforeSend>; // station-initiated CALLs, keyed by wire action
  main?(ctx: BehaviorContext): Promise<void>;
  onResume?(ctx: BehaviorContext): Promise<void>; // experimental
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

- **`replace`:** the handler is the whole answer; the default does not run. **`extend`:** the handler may call
  `ctx.defaultBehavior(req)`, which returns the default response and registers its follow-up; calling it commits
  to that follow-up (a handler that then answers something else still gets the default's effect). The request is
  not schema-checked first, so a default that cannot read a malformed `req` fails and the CSMS gets
  `InternalError`. `extend` needs a default: an entry that extends an action no default answers (see [the
  list](../entities/default-behaviors.md#actions-with-no-default)) is refused at load, naming the action.
- **`after`** runs once the response settled on the wire and is **skipped with a warning when the answer was not
  delivered** (a stale connection, a failed write, a queue overflow, a network close). A reboot or a state change
  in `after` therefore never happens for an answer the CSMS did not get. For `noResponse` there is nothing to
  settle and it runs at once, except on an abandoned CALL, where nothing runs. The default's follow-up (its own
  `after`) runs before the handler's.
- **Response checking.** A `response` is checked against the bundled JSON schema of the action's response (using
  the wire spelling of the CALL); a violation answers CALLERROR `InternalError` and logs a warning;
  `skipValidation: true` sends it as given. An action with no bundled schema is not checked.
- **A rule is busy from its CALL until the answer is decided** (a returned `CallOutcome`, `suppress`, or an
  abandon), not until `after` ends: `after` does not hold the rule. A second CALL that selects the rule while it
  is busy gets `onBusy` at once and never reaches a lower step.
- **`requires`** is a closed set and enforced at load: `ocpp1.6` on a 2.x station, `ocpp2.x` on 1.6, and any
  other string, are refused. (The former `virtual-time` was removed: no behavior needs to know the clock it
  runs on, and a station on real time must never refuse a behavior for it.) A behavior that uses a physical
  verb or `ctx.raw` without `physical` / `raw-frames` is **refused when its file loads**, by a syntactic scan
  for `ctx.<member>`, `ctx["member"]` and `const { member } = ctx` (the same scan `export-k6` runs); a use the
  scan cannot see (an alias of `ctx`) fails at the call with the same message.

`BehaviorContext`, one line per member and the error each can throw:

| Member                                                           | What it does                                                                                                                                                                                                                                             | Throws                                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `now()`                                                          | Epoch ms on the station's clock                                                                                                                                                                                                                          | —                                                                            |
| `sleep(ms)`                                                      | Wait on the clock                                                                                                                                                                                                                                        | `BehaviorStopped`                                                            |
| `until(promise, { ms })`                                         | The promise's value, or a timeout after `ms`                                                                                                                                                                                                             | `BehaviorTimeout`, `BehaviorStopped`                                         |
| `random(stream)`                                                 | A seeded stream named `<behaviorId>/<stream>`; `int(min, max)` is inclusive at both ends                                                                                                                                                                 | —                                                                            |
| `stopping`                                                       | True once the behavior was unloaded or the station disposed, and (for a reload) once the old code is asked to stop                                                                                                                                       | —                                                                            |
| `state`                                                          | `readonly` in the contract: change its keys, never assign it (core refuses). JSON only; held by the engine and persisted                                                                                                                                 | assigning throws `TypeError`                                                 |
| `send(action, payload, opts?)`                                   | A station-initiated CALL through the normal path; passes `beforeSend`                                                                                                                                                                                    | `OcppCallNoAnswerError` (dropped, timed out), `BehaviorStopped`              |
| `raw(frame)` — experimental                                      | A frame as given, via `RawFrameSender`; needs `raw-frames`                                                                                                                                                                                               | missing capability; `BehaviorStopped`                                        |
| `plugIn`, `unplug`, `authorize`, `startCharging`, `stopCharging` | Physical verbs, independent of the OCPP version; need `physical`. `unplug` runs the EV-side disconnect (a running transaction stops or suspends per `StopTransactionOnEVSideDisconnect`)                                                                 | missing capability; `BehaviorStopped`                                        |
| `setConnectorStatus` — experimental                              | Writes a status; needs `physical`                                                                                                                                                                                                                        | missing capability; `BehaviorStopped`                                        |
| `accepted(action)`, `rejected(action)`                           | The valid canned response of this station's version (`{}` for 1.6 `UpdateFirmware`, `{ status: "Accepted" }` on 2.x); either spelling of the action                                                                                                      | when the action has no such answer (`ctx.rejected("UpdateFirmware")` on 1.6) |
| `notify`                                                         | `firmwareStatus(status, { requestId? })`, `signedFirmwareStatus(status, requestId)`, `logStatus(status, { requestId? })`, `diagnosticsStatus(status)`                                                                                                    | `BehaviorStopped`                                                            |
| `defaultBehavior(req)`                                           | In an `extend` handler: run the default, register its follow-up, return its response                                                                                                                                                                     | outside `extend`; when the default answers an error                          |
| `connector(id)`, `charger`                                       | Read-only snapshots. `connector(id).power` is `{ acceptedW, offeredW, soc, limitedBy }` from the connector's operating point (#327). `charger` is `{ id, ocppVersion, status, connectorIds }`: branch on `charger.ocppVersion` for version-specific code | —                                                                            |
| `log(message)`                                                   | Write to the station log                                                                                                                                                                                                                                 | —                                                                            |

A context that outlives its scope (a closure the behavior kept after an unload, a grace time that ended, the
connection of a CALL's handler) does nothing: the members above that act throw `BehaviorStopped`, which the
engine swallows. `ctx.state` of an unloaded behavior is a loose object, not the engine's entry.

Behavior modules import types only. They must not use module-scope mutable state, `Date`, `Math.random` or
timers (one module instance serves every station); the ESLint config `@ocpp-cp-sim/contracts/eslint-behavior`
reports these. The API must work on k6: no `AbortController`, `URL`, `structuredClone`, `queueMicrotask`,
`performance`, async generators or `for await`; `ocpp-cp-sim behavior build` checks this.

Waits (`sleep`, `until`) run on the station's clock. When the behavior is unloaded, the station is disposed, or
(for a user behavior's CALL handler and its `after`) the connection closes, a pending wait rejects with
`BehaviorStopped`.

### BehaviorRegistry

One per charge point (`application/behavior/`). It holds rules from two providers — code behaviors
(`{ kind: "code", behaviorId }`) and scenario rules (`{ kind: "scenario", scenarioId, connectorId, nodeId }`)
— and selects among them as [call precedence](call-precedence.md) says: scenario before code, then the exact
connector, then the newest scenario / the first-loaded code rule. A rule holds at most one open exchange. Scenario
rules end with their run (released by owner); code rules last while the behavior is loaded.

### Scenario schema 1.5

Additive; the format page ([Scenario format](scenario-format.md#csmscalltrigger-replace-callresponse-from-and-usebehavior-schema-15))
is the reference for fields.

- `csmsCallTrigger.behavior`: `"observe"` (default, as before) or `"replace"`, plus `onBusy`.
- `callResponse` node: `kind: "result" | "error" | "none"`, `payload`, `errorCode`, `errorDescription`,
  `skipValidation`. It waits for settlement.
- `{ "$from": "call.payload.requestId" }` as a whole payload value in `ocppCall` and `callResponse`, resolved
  against the exchange of that branch. A missing path fails the run.
- `useBehavior` node: selects a behavior already loaded on the station, by id. Data only.

The runtime contract (a disconnect before answering, a run that ends unanswered, an answer after a reconnect, a
send that failed, the time before answering, a `callResponse` without an exchange) is the table in the
[format page](scenario-format.md#csmscalltrigger-replace-callresponse-from-and-usebehavior-schema-15); there is
one test per row (`scenario15.bun.test.ts`).

**The scenario editor authors all of it.** The browser Scenario Editor
([`ScenarioEditor.tsx`](../../apps/web/src/components/scenario/ScenarioEditor.tsx)) has node forms for a
`csmsCallTrigger` with `behavior: "replace"` and `onBusy`, a `callResponse` node (kind, payload, error code,
`skipValidation`) and a `useBehavior` node, and exports them with `schemaVersion: "1.5"`. What it does not
give: `$from` has no dedicated control (type `{"$from": "call.payload.requestId"}` in the payload JSON box),
`useBehavior`'s id is free text (the console does not offer a list of the station's behaviors), and the console
has no selector that sets which behaviors a charge point runs (the RPC `cp.behaviors.set` does). So goal 3 of
#566 — override from a scenario, in the common way — is met for hand-written files and for the editor.

**Dormant behaviors: all or none.** `cp.loadBehavior(behavior, { dormant: true })` loads a behavior that
serves nothing. A run that reaches `useBehavior` _holds_ it: while at least one run holds it, the behavior is
complete — its `onCall` rules (registered under the run as owner), its `main` (started when the first holder
arrives), its `on` hooks and its `beforeSend` — and when the last holder lets go (the run ends or stops) all of
it stops: rules are released, `main` is cancelled, hooks and `beforeSend` are not delivered. Selecting it again
from the same node (a `useBehavior` in a loop) replaces its rules and does not start a second `main`. A behavior
that is not dormant already serves, and the node only checks that it exists. `onResume` never runs for a dormant
behavior. A reload of a held dormant behavior keeps the old rules until the run ends.

### The engine

`ChargerEngine` is one per charge point (`application/engine/`). It owns `ChargerState`, a JSON-serializable
record of the connectors (status, availability, scheduled availability, error info, the transaction), the last
firmware, signed firmware, log and diagnostics status reported, and `behaviors`, the `ctx.state` of every
loaded behavior. Reservations stay in `ReservationManager` (a map of dated records with an expiry interval; it is
used on its own by scenarios and tests), so `engine.snapshot()` is not the whole station. Every mutation goes
through `engine.dispatch(event)`; handlers and `ChargePoint` translate to events and do not write state. The
rule is enforced by `scripts/check-single-writer.ts` (in `check:boundaries`); it is syntactic, and its limits
(an alias passed through a function or property, `eval`, a connector reached through a parameter or `this`, the
import closure outside the scanned directories) are accepted: the golden wire test is what catches the rest.

`ChargePoint` remains the facade with its public API; `Connector` fields are read views of the engine state. The
transition table `ALLOWED_CONNECTOR_STATUS_TRANSITIONS` (`domain/connector/ConnectorTransitions.ts`) is
enforced only as a warning on `full` writes, so that scenarios can force transitions. `StateManager` only
records `StateHistory`.

**Delivery timings.** One table, because the four timings below are each justified by rule 4 and are easy to
get wrong in combination.

| Class                                                                         | Reduced                                                                                      | Listeners and acting on it                                                                                                                                   | Behavior hooks (`on`)                                                    | Nests?                                                           |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Ordinary event (`notified`, `behavior.*`, `connection.closed`, `disposed`)    | At once if the queue is idle (before `dispatch` returns), else right after the current event | In the same turn as the reduction (a notification still goes out in the turn that asked for it)                                                              | A microtask after the turn, FIFO                                         | No: one dispatched meanwhile runs right after the current event  |
| `connector.*` write (`status`, `availability`, `transaction.*`, `restore`, …) | At once, even from inside the listeners of an earlier write                                  | At once, in the writer's turn; the order of StatusNotifications on the wire follows the nesting of today's `statusChange` listeners; errors reach the caller | A microtask after the turn                                               | **Yes.** Read-after-write holds; a deferred write would break it |
| Event hook delivery                                                           | —                                                                                            | Hooks of several behaviors run in load order; an async hook is not awaited; a throw is a warning                                                             | An event a hook raises joins the queue: the hook's own writes never nest | No: the traffic of the event, then the traffic of the hook       |
| `ctx.send` made inside a `beforeSend`                                         | —                                                                                            | Waits one microtask, so it is queued after the CALL being intercepted                                                                                        | —                                                                        | —                                                                |
| Default behavior answer                                                       | —                                                                                            | Synchronous (#456); its follow-up starts in the turn the answer settled, up to its first wait                                                                | —                                                                        | —                                                                |
| Persistence of `ctx.state`                                                    | —                                                                                            | After every processed event and whenever a behavior yields; the service writes only changes                                                                  | —                                                                        | —                                                                |

**Three scopes of a status write** (the wire depends on them): `local` (a bare `connector.status = …`: only
the connector's own `statusChange` listeners), `event` (also `ChargePointEvents.connectorStatusChange`; the
offline teardown), `full` (also the connection-timeout timer and the StatusNotification;
`ChargePoint.updateConnectorStatus`).

**Default behaviors** are `Behavior` objects registered with `engine.registerDefault`, keyed by wire action,
reached through `engine.runDefault(action, payload)`, which returns `{ response, effect }`; the effect starts the
behavior's `after` once the response settled, through `ResponseEffectQueue`. What each does, per version, is in
[Default behaviors](../entities/default-behaviors.md). A follow-up binds to the connection when it _starts_,
not when the CALL arrives, and only the firmware trains end on a close (the upload behaviors and the rest are
not tied to the socket), because that is the behavior of the code the engine replaced. When the response queue
drops the effect (a close the station made, a stale generation, a dispose), the follow-up's scope ends with it.

**Lifecycle of a code behavior.**

```
              load (loadBehavior)                                    unload / dispose
 file ──────────────► serving ─────────────────────────────────────────────────────────► gone
                      │ rules registered, main started, hooks and beforeSend live,       (rules released, open CALLs answered
                      │ onResume once the boot is accepted                                InternalError, waits cut off)
                      │
                      │ reload: new rules replace the old ones in the same rank;
                      │ a CALL in flight finishes on the old code; ctx.stopping turns true for
                      │ main / hooks, which are cut off after RELOAD_GRACE_MS (5 s, the station's clock);
                      ▼ the new main starts when the old one returned or the grace time ended
 load { dormant } ──► dormant ── held by a run (useBehavior) ──► serving (until the last holder lets go) ──► dormant
```

**Resume.** State is restored (statuses set without sending anything, `ctx.state` filled in place, state of a
behavior not loaded yet kept as an orphan and adopted when it loads), and `onResume` runs when the boot is
accepted (`engine.resumeAfterBoot()`), after the restored sessions are settled. Async positions are not
restored.

**Persistence.** One JSON row per charge point in the `engine_state` table (`PersistedEngineState`: statuses and
`behaviors[id]`), and the connector rows. `ctx.state` entries are checked per behavior: a key set to
`undefined` is an absent key; an entry that is not JSON (a `Date`, a `Map`, a function, `NaN`) keeps its last
storable value with a warning in the daemon, and **throws in the test harness** (`runBehavior()`), so the slip
fails a test instead of being lost. The row survives `cp.update`.

### Event hooks (`Behavior.on`)

| Hook                         | Payload                                                        | Raised when                                                                                                               |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `connectorStatus`            | `{ connectorId, from, to }`                                    | A connector's status record changes (every writer; a write that keeps the value raises nothing, a restore raises nothing) |
| `transactionStarted`         | `{ connectorId, transactionId, idTag }`                        | The connector gets a transaction record; on 1.6 `transactionId` is `0` until the CSMS answers, on 2.x the station's UUID  |
| `transactionStopped`         | `{ connectorId, transactionId, idTag, reason? }`               | The record gets its stop time (or is removed while running), once per transaction; `reason` is the one on the wire        |
| `connected` / `disconnected` | `{ at }` / `{ at, code?, reason? }`                            | The socket really opened / closed. SOAP: when the callback is up                                                          |
| `callResult`                 | `{ action, messageId, outcome: "result" \| "error", payload }` | The CSMS answered a station-initiated CALL, any of them. An error carries `{ errorCode, errorDescription }` as payload    |
| `callReceived`               | `{ action, messageId, payload }`                               | The CSMS sent a CALL, before the gate looks at it. Observation only                                                       |

Payloads of `callResult` / `callReceived` are copies. A hook that throws or rejects is a warning and the charger
carries on. Delivery is in the table above.

### Send interception (`Behavior.beforeSend`)

- One choke point per transport (`sendRequest` on 1.6, `send` on 2.x): automatic messages, `ctx.send`, `ocppCall`
  nodes and control-plane expert calls all pass it. `ctx.raw` is outside. A CALL the boot gate suppresses never
  reaches it. A SOAP station refuses a behavior with `beforeSend` at load.
- Signature `(payload, ctx) => payload | { drop: true } | undefined`, synchronous. `payload` is a copy; nothing
  returned leaves the CALL as it was. A promise, a throw or a non-object is a warning and the CALL goes on
  unchanged. Behaviors chain in load order.
- **Keys are wire actions.** The payload handed over is always the one of the station's own version. On a 2.x
  station there are exactly two sugar keys:

  | Key you write (2.x)           | Fires for                                                                                                                                       |
  | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
  | `TransactionEvent`            | Every `TransactionEvent` (`Started`, `Updated`, `Ended`)                                                                                        |
  | `StartTransaction` (1.6 name) | A `TransactionEvent` with `eventType: "Started"`                                                                                                |
  | `StopTransaction` (1.6 name)  | A `TransactionEvent` with `eventType: "Ended"`                                                                                                  |
  | `MeterValues`                 | A `MeterValues` CALL only. **Inside a 2.x transaction the meter values ride a `TransactionEvent` (`Updated`), so use `TransactionEvent` there** |

  Every other 1.6 name that differs from 2.x is not translated.

- **Every transmission is intercepted once, starting from the payload as the station built it.** A resend after a
  CALLERROR and a replay from the offline queue are new transmissions. The queue and the request history keep the
  payload _as built_ on both versions, so a rewrite is applied once to what goes on the wire, a behavior never
  rewrites its own output, and **the answer is matched with the CALL as built**: rewriting an `Authorize` token or
  a `StartTransaction` `idTag` does not cut the CALL from its answer. A CALL handed over while the socket is down is
  not transmitted, so `beforeSend` does not see it until it is replayed.
- **Dropped CALL.** Nothing is queued, nothing is written, whoever waits is told (`OcppCallNoAnswerError("dropped")`).
  A dropped replayed `TransactionEvent` or `NotifyEvent` is spent: its row leaves the offline queue and does not
  block the ones behind it. A dropped Heartbeat still re-arms the idle timer. A dropped `StartTransaction` leaves
  the transaction without a CSMS id, as an unanswered one would.

### Assignment, reload and the library

- `--behavior <file>` (repeatable) fills a `BehaviorLibrary` (`apps/cli/src/behavior/`): behavior id to behavior,
  in load order. **What every engine refuses is refused when the file loads** and the file is left out as a
  whole: another `api`, an id that is empty, starts with `default.` or names a member of every object
  (`constructor`, `toString`, `__proto__`), an unknown `requires`, a capability used without being listed, `mode:
"extend"` on an action without a default. A charge point's `behaviors: string[]` selects from the library by
  id: absent runs every loaded behavior, `[]` none. Unknown ids are `invalid_params` naming the loaded ids.
- The four spellings of "select" are one thing:

  | Where                         | Spelling                                                                        | Scope                          |
  | ----------------------------- | ------------------------------------------------------------------------------- | ------------------------------ |
  | Command line                  | `--use-behavior <id>` (repeatable)                                              | The charge points it starts    |
  | RPC / MCP at creation, update | `behaviors: string[]` on `cp.create`, `cp.create_many`, `cp.update`, blueprints | One charge point, persisted    |
  | RPC / MCP at run time         | `cp.behaviors.set { cpId, behaviors }` (`null` = all)                           | One charge point, in place     |
  | Scenario                      | `useBehavior` node                                                              | A run (dormant behaviors only) |

- It persists with the charge point (`charge_points.behaviors`; `NULL` = all). A selection is checked before it
  is written; a refused `cp.update` leaves the old station connected and as it was. On restore an id no longer
  loaded, or one the station cannot run, is left out with a warning; any other failure skips that station with a
  warning and keeps its row; an unreadable stored value selects none.
- `behavior.list` returns the library (id, file), whether `--watch-behaviors` is on, and `defaults`: the built-in
  behaviors with the actions each answers.
- **Reload** (`behavior.reload`, `--watch-behaviors`) re-reads the files given at start. It is opt-in
  (`--allow-behavior-reload`, or implied by `--watch-behaviors`). A station takes a whole file or none of it; an
  unchanged bundle is skipped by hash; a file that fails keeps its old version. Reloads run one at a time, each
  from a fresh temporary directory.
- Changing the selection at run time unloads the behaviors no longer selected (their `ctx.state` goes with them)
  and loads the new ones after those running.

### Loading code and the trust line

- CLI and daemon: `--behavior <file>`; a daemon needs `--allow-behavior-code`, which is refused with
  `--unsafe-remote` and switches CORS to same-origin (below). A single-CP
  session needs no opt-in. `--behavior` is refused with the client modes. `ocpp-cp-sim behavior build <file>`
  type-checks (ES2017 library only) and writes one ESM bundle.
- Web: `LocalChargePointService.loadBehaviorBundle(id, blob | text)` loads a built bundle through
  `import(blobUrl)`, in the local runtime only (experimental, no UI).
- k6: `export-k6 --behavior <file>` generates a static import. The k6 host implements `ctx` over the k6 client,
  OCPP 1.6J only; `onCall` is `replace` only; it provides `connected`, `disconnected`, `callResult`,
  `callReceived`, `beforeSend`, `accepted`, `rejected`. A behavior that needs anything else is refused at export
  with the file and the reason named. Difference worth knowing: the k6 `callResult` for the boot may fire
  before `connected`, where core fires `connected` when the socket opens.

**What is trusted.** The trust line is "who can make the daemon run code". The answer is: the operator of the
command line and of the files it names, and nobody over the wire. No RPC method, MCP tool or OCPP message loads
code, a path or source text; `behaviors` is `string[]` looked up in the library. Three things widen that set,
and they are the trusted computing base:

1. **Every file the named files import, and with `--watch-behaviors` every file in their directories.** Whoever
   can write there runs code in the daemon on the next debounce. Treat those directories like the command line.
2. **A daemon with Basic Auth beyond loopback may run code.** `--allow-behavior-code` is refused only with
   `--unsafe-remote`; it is allowed with Basic Auth on another bind address. An authenticated caller can then
   `cp.behaviors.set` (select among loaded behaviors) and, with `--allow-behavior-reload`, `behavior.reload`
   (re-read the files). They cannot supply code, but they can make the daemon re-read files someone else changed.
3. **The MCP tools `behavior_reload` and `cp_behaviors_set` give an AI agent the same two levers.** Do not
   connect an agent to a daemon whose behavior directories it can write.

A daemon that runs code applies `same-origin` CORS by default, on every bind, and refuses a `Host` that is not an
IP literal, `localhost` or the bind address, so a page on another origin, or on a DNS name rebound to the daemon,
cannot call `/socket.io` or `/mcp`. `--cors-origin <origin>` widens it, `--cors-origin "*"` opens it. Plain
execution has no isolation: `vm`, Worker and ShadowRealm are not called isolation anywhere.

### Determinism

Virtual-time mode runs on Bun and browsers against an in-process fake CSMS or a trace replay: one queue, a fixed
tie-break, seeded streams. Same seed, same effects. Real-time mode (k6, a real CSMS) promises only explanation
through seed and trace. The condition is that every wait goes through the clock and every random draw through a
stream, and that nothing in the run waits on real I/O of its own process. The pinned-hash rule: **a pinned
determinism hash changes only with a written cause**; the record of the one change so far, and what is known
of it, is in the [migration history](../analyses/charger-engine-migration.md#why-the-1000-x-6-h-hash-changed).

## Transitional

Compatibility measures, kept so that callers and tests need not change, with an owner: [#575](https://github.com/shiv3/ocpp-cp-simulator/issues/575)
(`ChargePoint` size) removes them as the lines move out.

- `Connector` setters that dispatch `connector.write`, and `Connector.transaction`, a live view wrapped in a
  `Proxy` (an assignment to a field dispatches a `transaction.patch`; assigning `connector.transaction = x`
  stores a copy, so the view is not `x`). New code uses `patchTransaction`, `assignTransactionId` and
  `detachTransaction`.
- The three write scopes of a status write (`local`, `event`, `full`): one write chosen by which facade a caller
  used. The target is one scope with explicit effects.
- `_scenarioHandledConnectors`, `_scenarioStopHandledConnectors` and the `noteDefaultHandled…` marks (see
  [parking](call-precedence.md#scenario-parking-is-not-a-rule)): the second ownership mechanism for RemoteStart /
  RemoteStop. The target is scenario rules in the registry, which needs a golden case recorded on `main` for the
  intended behavior first.
- `application/` reaches into `infrastructure/` in one place (the diagnostics upload).

## Limits

- Out of scope: QuickJS or any sandbox, remote delivery of code, an external-process plugin protocol, a console UI
  for writing behaviors, and retiring `export-k6`'s separate implementation.
- Two source checks (`check-direct-time`, `check-single-writer`) are syntactic and have accepted bypasses (an alias
  of a global, `eval`, a connector through a parameter or `this`).
- Reload: a partial reload is retried in full (stations that already run the new version restart their `main`);
  a module whose top level never settles stays pending in memory; the watcher is not tested on network file
  systems.
- `onResume` does not run on a station that never boots.
- Scale numbers (10,000 real charge points, about 49 KB each) exclude a database per charge point and a UI; see
  the [migration history](../analyses/charger-engine-migration.md#verification-results).
