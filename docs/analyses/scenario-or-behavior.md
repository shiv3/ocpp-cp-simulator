---
title: Scenario or behavior?
type: analysis
summary: How to choose between a JSON scenario (schema 1.5), a response override and a TypeScript behavior to change what a station does, with a comparison table, recipes for the common jobs (including disabling a default) and the mapping from scenario nodes to ctx verbs.
sources:
  - packages/contracts/src/behavior.ts
  - packages/core/src/cp/application/engine/behaviors/
  - packages/core/src/test/behavior/precedence.bun.test.ts
  - examples/behaviors/
  - "issue #566"
related:
  - ../concepts/charger-engine.md
  - ../concepts/call-precedence.md
  - ../concepts/scenario-format.md
  - ../entities/default-behaviors.md
  - ../entities/cli.md
updated: 2026-11-08
---

# Scenario or behavior?

There are three ways to change what a station does when the CSMS calls it, and a fourth for what it sends by
itself. They overlap on purpose; this page says which to reach for. Background: the station answers every CALL by
[a fixed order](../concepts/call-precedence.md) (policy, override, **running scenario**, code behavior,
[default](../entities/default-behaviors.md)), and `api: 1` of the behavior contract is a
[preview](../concepts/charger-engine.md#stability).

**Start with a scenario.** It is the common way: a JSON file, editable in the browser editor, pausable, steppable,
loadable over the control plane and MCP, and it ends by itself. Reach for TypeScript when you need a branch or a
state that a graph does not express, or something that must hold for the station's whole life.

## The choice in one table

| Need                                                                 | `responseOverride` node     | Scenario `replace` + `callResponse` (1.5)                                | TypeScript behavior                                |
| -------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| Change the status of **one** answer (`Rejected` once)                | yes: `{ status }`, one-shot | possible                                                                 | possible                                           |
| Answer with a full payload, an error, or silence                     | no (`{ status }` only)      | yes (`result`, `error`, `none`)                                          | yes                                                |
| Own one CALL inside a flow you can see and edit                      | no                          | yes                                                                      | possible, no GUI                                   |
| Change what **every** CALL of an action gets, for the station's life | no                          | no (per run, per branch)                                                 | `onCall`                                           |
| Keep the default answer and add a side effect                        | no                          | no                                                                       | `mode: "extend"`                                   |
| Change the follow-up train of a default                              | no                          | answer by hand and send your own notifications                           | `replace` and send your own, or `extend` plus more |
| React to status, transaction or connection events                    | no                          | partly (`statusTrigger`, `connectionTrigger`, `csmsCallTrigger` observe) | `on` hooks                                         |
| Rewrite or drop a message the station sends by itself                | no                          | no                                                                       | `beforeSend`                                       |
| Physical sequence (plug, authorize, charge)                          | no                          | nodes                                                                    | `main` with the physical verbs                     |
| Pause, step, resume, verdicts; fleet declaration                     | no                          | yes                                                                      | no                                                 |
| Load through the control plane / MCP                                 | yes                         | yes (data)                                                               | no: files on the command line, selected by id      |
| k6                                                                   | partly                      | refused nodes are listed                                                 | partly, `replace` only, refused members listed     |
| SOAP                                                                 | yes                         | `replace` fails when the node arms                                       | `beforeSend` refused; defaults bypass the gate     |

Three rules of thumb. If the answer is `{ status: "…" }` and once is enough, use `responseOverride`. If a person
should see and edit it, or it belongs to one test run, use a scenario. If it must always hold, needs a loop or
state, or must change what the station sends, use a behavior. And if you loaded a behavior for the whole fleet,
a scenario you run on one station still wins ([precedence](../concepts/call-precedence.md)).

## Recipes

Each recipe is the smallest thing that works; the file names are in `examples/behaviors/`.

### Override one action (always `Rejected`)

Behavior:

```ts
import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";

export default {
  api: 1,
  id: "reset-rejects",
  onCall: {
    Reset: {
      mode: "replace",
      handle: (_req, ctx) => ({ response: ctx.rejected("Reset") }),
    },
  },
} satisfies Behavior;
```

Scenario (same effect for one run): a `csmsCallTrigger` with `behavior: "replace"`, `action: "Reset"`, then a
`callResponse` with `kind: "result"` and `payload: { "status": "Rejected" }`. For a single answer, a
`responseOverride` node with `action: "Reset"`, `status: "Rejected"` is enough.

### Keep the default and add a side effect

`extend` runs the default for you and lets you wrap it. The default's follow-up (the firmware train, the reset)
still happens.

```ts
onCall: {
  UpdateFirmware: {
    mode: "extend",
    handle: (req, ctx) => {
      ctx.log("firmware update requested");
      return { response: ctx.defaultBehavior(req) };
    },
  },
},
```

`extend` exists only for actions that have a default ([the list](../entities/default-behaviors.md)); for any other
action it is refused when the file loads. Calling `ctx.defaultBehavior` commits to the default's follow-up: if your
handler then answers something else, the follow-up still runs.

### Keep the answer, change the train

There is no way to keep the default answer and suppress or alter its follow-up. Replace the action: build the
answer with `ctx.accepted(action)` and send the notifications you want with `ctx.notify` and `ctx.sleep` in the
`after` function (`examples/behaviors/flaky-firmware.ts`). `after` runs only if the answer reached the CSMS.

### Disable an action's follow-up

Replace it with the valid answer and nothing else:

```ts
onCall: {
  UpdateFirmware: { mode: "replace", handle: (_req, ctx) => ({ response: ctx.accepted("UpdateFirmware") }) },
},
```

The station answers `Accepted` (or `{}` on 1.6) and does not report any status. In a scenario: `replace` +
`callResponse` `kind: "result"`, `payload: {}` on 1.6.

### Refuse an action, or ignore it

Refuse with a CALLERROR: `{ error: { code: "NotSupported", description: "disabled in this test" } }` (behavior) or
`callResponse` `kind: "error"` (scenario). Stay silent: `{ noResponse: true }` or `kind: "none"` — the CSMS will
time out. A sticky refusal of an action for the whole run, independent of any behavior, is an `inboundPolicy` node
(`policy: "callerror"` or `"ignore"`); it also wins over everything else.

### Disable a message the station sends by itself

`beforeSend` returns `{ drop: true }`:

```ts
beforeSend: { Heartbeat: () => ({ drop: true }) },
```

What it costs: nothing is written, whoever waits is told (`ctx.send` rejects), a dropped `Heartbeat` still re-arms
the idle timer, and a dropped `StartTransaction` leaves the transaction without a CSMS id as if the CSMS had not
answered. On a 2.x station `MeterValues` inside a transaction is a `TransactionEvent`, so key the hook by
`TransactionEvent`. This is behavior-only; a scenario cannot drop traffic.

### Own a CALL from a scenario and answer with the request's data

A `csmsCallTrigger` (`behavior: "replace"`) then a `callResponse` whose payload uses `{ "$from": "call.payload.requestId" }`
reads the request. The same in code reads `req`. Both answer once; a second CALL while the first is open gets
`onBusy`.

### Tune a default from a scenario

The defaults have knobs ([which](../entities/default-behaviors.md#params)). Select the default by id and set the
param; it lasts for the run and nothing else is rewritten:

```json
{
  "type": "useBehavior",
  "data": {
    "behaviorId": "default.firmware",
    "params": { "stepMs": 30000, "failAt": "InstallationFailed" }
  }
}
```

The same knobs for the station, not for a run: `--behavior-params 'default.firmware={"stepMs":30000}'`,
`behaviorParams` on `cp.create` / `cp.update`, or `cp.behaviors.set`. A value that does not fit is refused with the
reason (`"stepMs": "30000"` is not a number), never converted. When the knob you need does not exist, that is the
signal to write a behavior (below) and select it with `useBehavior`; a node is not added per knob.

### Switch a default off from a scenario

```json
{
  "type": "useBehavior",
  "data": { "behaviorId": "default.firmware", "mode": "disable" }
}
```

For the run, `UpdateFirmware` is answered with the version's `Accepted` and nothing follows: no status
notifications. Compare "Disable an action's follow-up" above, which is the same thing as a behavior for the
station's whole life. `disable` works for any behavior id, a code behavior included (it then silences its rules for
the run), and takes no params. Because it answers `Accepted` without acting, `default.reset` disabled does not
reset and `default.transaction` disabled starts nothing; use `inboundPolicy` to refuse instead.

### Select a behavior from a scenario

Load it dormant (`cp.loadBehavior(b, { dormant: true })` in embedding code; a behavior given with `--behavior` is
already serving), then add a `useBehavior` node with its id. While the run is alive the behavior is complete (rules,
`main`, hooks, `beforeSend`); when the run ends it is idle again. For a fleet-wide choice, select with
`--use-behavior`, `behaviors` on `cp.create` or `cp.behaviors.set` instead.

### Test a behavior without a CSMS

`runBehavior()` drives it on a virtual clock against an in-memory fake CSMS and a state that cannot be stored fails
the test (`packages/core/src/test/behavior/runBehavior.ts`, [testing strategy](testing-strategy.md#behavior-tests)).

## Node ↔ ctx parity

The same job has a name in each world. Where a column is empty there is no equivalent yet; the engine's intended
end state is that the scenario executor becomes a client of `ctx` ([contract](../concepts/charger-engine.md#where-this-is-going)).
Keep this table current: when a scenario node or a `ctx` member is added, its row is added in the same change, so the
gap is visible instead of argued. A proposed new node must pass the [test for a new
node](../concepts/scenario-format.md#what-the-format-will-not-do): a behavior parameter, a wait, a verb `ctx` already
has, or a listed decision node.

| Scenario node                                | `ctx` / behavior member                                                                  | Note                                                                                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ocppCall`                                   | `ctx.send(action, payload)`                                                              | Both pass `beforeSend`                                                                                      |
| `csmsCallTrigger` `observe`                  | `on.callReceived`                                                                        | Observation only                                                                                            |
| `csmsCallTrigger` `replace` + `callResponse` | `onCall[action]` with `mode: "replace"` returning a `CallOutcome`                        | `kind: "none"` is `{ noResponse: true }`                                                                    |
| `responseOverride`                           | `onCall` `replace` returning `ctx.accepted` / `ctx.rejected`                             | The node is one-shot; the rule is permanent                                                                 |
| `inboundPolicy`                              | —                                                                                        | Sticky; wins over every behavior                                                                            |
| `delay`                                      | `ctx.sleep(ms)`                                                                          | Both on the station's clock                                                                                 |
| `connectorPlug` plugin / plugout             | `ctx.plugIn` / `ctx.unplug`                                                              | Need `requires: ["physical"]`                                                                               |
| `transaction` start / stop                   | `ctx.startCharging` / `ctx.stopCharging`                                                 | The same transaction default runs                                                                           |
| `notification` (firmware, log, …)            | `ctx.notify.firmwareStatus(…)` and friends                                               |                                                                                                             |
| `statusChange`                               | `ctx.setConnectorStatus` (experimental)                                                  |                                                                                                             |
| `statusTrigger`, `connectionTrigger`         | `on.connectorStatus`, `on.connected`, `on.disconnected`                                  | A hook fires on every event; a trigger waits once                                                           |
| `remoteStartTrigger`, `remoteStopTrigger`    | `onCall` for the remote actions                                                          | The trigger parks the default; see [parking](../concepts/call-precedence.md#scenario-parking-is-not-a-rule) |
| `callResponse` `accepted` / `rejected`       | `ctx.accepted(action)` / `ctx.rejected(action)`                                          | Schema 1.6: the answer of the CALL's own action on the station's version; no payload                        |
| `notify`                                     | `ctx.notify.firmwareStatus(…)`, `signedFirmwareStatus`, `logStatus`, `diagnosticsStatus` | Schema 1.6: fire-and-forget; `requestId` may be a `$from`                                                   |
| `switch`                                     | `if` / `===` on `ctx.connector(id)`, `ctx.charger`, `ctx.state`                          | Schema 1.6: JSON equality against constants, one edge per case plus `default`; no ordering, no arithmetic   |
| `$from` roots `charger`, `connector`         | `ctx.charger`, `ctx.connector(id)`                                                       | Schema 1.6: read-only, whole values only                                                                    |
| `delay` `until`, `jitterSeconds`             | `ctx.sleep(ms)` after `ctx.now()`, `ctx.random(stream).int(…)`                           | Schema 1.6: `until` is a floor on the wait; the jitter is seeded                                            |
| `choice`                                     | `ctx.random(stream)`                                                                     | Schema 1.6: a seeded, weighted pick of one edge; the same seed gives the same pick                          |
| `setState` and the `$from` root `state`      | `ctx.state`                                                                              | Schema 1.6: JSON, per run (a behavior's `ctx.state` is per station), shared by parallel branches            |
| `useBehavior`                                | select by id (`--use-behavior`, `behaviors`, `cp.behaviors.set`)                         |                                                                                                             |
| `useBehavior` `params`                       | `Behavior.params` read as `ctx.params`; `--behavior-params`, `behaviorParams`            | A parameter of a behavior; the layer ends with the run                                                      |
| `useBehavior` `mode: "disable"`              | `onCall` `replace` returning `ctx.accepted(action)`                                      | For the run, scenario rules outrank code                                                                    |
| `unlockOutcome`                              | `default.unlock` param `outcome`                                                         | The node sets the connector's value (persistent); the param is for the station or a run                     |
| —                                            | `beforeSend`, `on.callResult`, `on.transactionStarted` / `Stopped`, `onResume`           | Code only: hooks and rewriting have no node                                                                 |
| pause, step, resume, verdicts                | —                                                                                        | Scenario only                                                                                               |
