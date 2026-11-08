---
title: Who answers an inbound CALL
type: concept
summary: The order in which the five ways to answer a CSMS CALL are tried — inbound policy, response override, a running scenario, a code behavior, the default — and how the scenario parking of RemoteStart / RemoteStop relates to it.
sources:
  - packages/core/src/cp/infrastructure/transport/inbound/InboundCallGate.ts
  - packages/core/src/cp/infrastructure/transport/OCPPMessageHandler.ts
  - "issue #593"
  - packages/core/src/cp/application/behavior/BehaviorRegistry.ts
  - packages/core/src/cp/application/engine/behaviors/transaction.ts
  - packages/core/src/test/behavior/precedence.bun.test.ts
  - packages/core/src/cp/application/behavior/__tests__/BehaviorRegistry.test.ts
  - "issue #566"
related:
  - charger-engine.md
  - scenario-format.md
  - ../analyses/scenario-or-behavior.md
  - ../entities/default-behaviors.md
updated: 2026-11-08
---

# Who answers an inbound CALL

A CSMS CALL has one answer. Several things can want to give it: a sticky policy, a one-shot override, a
scenario that is running, a TypeScript behavior, and the station's own default. This page is the one place
that says which wins. It is decided once, for both OCPP versions, and enforced in one gate
([`InboundCallGate`](charger-engine.md#callexchange-and-inboundcallgate)) and one registry
([`BehaviorRegistry`](charger-engine.md#behaviorregistry)).

**A running scenario wins over code behaviors.** An operator who loads a scenario to own a CALL is acting
now, on this station; a code behavior was loaded at start for the station's whole life. The now beats the
always, and a scenario never has to be told about a fleet-wide `--behavior` file.

## The order

| #   | Step                      | Set by                                                                                                        | Lives                                          | Wins over        |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------- |
| 1   | Inbound policy            | `inboundPolicy` scenario node, control plane                                                                  | Until cleared (sticky, survives a reconnect)   | everything below |
| 2   | Response override         | `responseOverride` scenario node, control plane                                                               | One CALL (one-shot)                            | 3 to 6           |
| 3   | Scenario rule             | `csmsCallTrigger` with `behavior: "replace"` (schema 1.5)                                                     | Until its exchange is answered or the run ends | 4 to 6           |
| 4   | Code behavior rule        | `onCall` of a loaded `Behavior` (mode `replace` or `extend`)                                                  | While the behavior is loaded                   | 5, 6             |
| 5   | Default behavior          | [`default.*`](../entities/default-behaviors.md)                                                               | Always                                         | —                |
| 6   | Handler without a default | The OCPP handler itself ([actions with no default](../entities/default-behaviors.md#actions-with-no-default)) | Always                                         | —                |

Steps 1 and 2 are looked up under the action's own name and, on 2.x, its 1.6 alias, and they answer with a
CALLERROR / silence (1) or `{ status }` (2). Steps 3 and 4 run in `BehaviorRegistry.resolve()`, which the
gate calls synchronously and before the payload is validated, so a rule can own a malformed CALL. Step 5
is the gate's "default path" for the actions that have a default behavior; step 6 is the same path for the
rest.

On OCPP 1.6J the payload of a CALL that reaches steps 5 and 6 is then validated per `inboundValidation`
(`off` / `warn` / `enforce`, default `warn`; see
[Inbound CALL validation on OCPP-J 1.6](ocpp-versions-and-transports.md#inbound-call-validation-on-ocpp-j-16)).
Policies and overrides are consulted before validation, as on 2.x, so a policy can answer a malformed CALL.

### Within a step

Among the rules that name the CALL's action (on 2.x also its 1.6 alias) and whose `match` fits the payload:

1. **Kind first:** a scenario rule beats a code rule, whatever their ages and whatever connector either names.
2. **Then the exact connector:** among rules of one kind, those registered for exactly the connector the CALL
   names (`evseId`, else `evse.id`, else `connectorId`) beat the others. A rule's `connectorId` ranks; it does
   not filter (use `match` to filter).
3. **Then age:** among scenario rules the **newest run first** (the last scenario armed is the one the
   operator just started); among code rules the **load order**, i.e. the oldest registration first.

A CALL that names no connector (`UpdateFirmware`, `Reset` without an EVSE, ...) skips step 2: every
candidate of the winning kind is equal and age decides. A warning names the losers.

One rule holds at most one open exchange. A second CALL that selects the same rule while it is open gets that
rule's `onBusy` (default CALLERROR `GenericError`) and **does not fall through** to a lower step: a busy
scenario rule never hands its CALL to a code behavior. The exchange is open from the CALL until it is
answered (or suppressed, or abandoned); a returned `after` runs later and does not hold the rule.

### What each pair means

| Pair                                                  | Result                                                                                                                                                 | Test                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| policy over override                                  | The policy answers; the armed override is **not** consumed and answers the next CALL once the policy is cleared                                        | `precedence.bun.test.ts`         |
| override over scenario, code, default                 | The override answers one CALL; the next one goes to the scenario again                                                                                 | same                             |
| scenario over code                                    | The scenario answers, though the code behavior was loaded first. When the scenario's rule is gone (answered, run over) the code behavior answers again | same, `BehaviorRegistry.test.ts` |
| scenario over scenario                                | The newest run (exact connector first)                                                                                                                 | same                             |
| code over code                                        | The behavior loaded first                                                                                                                              | same                             |
| code over default                                     | The code behavior; with mode `extend` it can run the default itself (`ctx.defaultBehavior`)                                                            | same                             |
| a connector-less CALL                                 | As above, with no connector step                                                                                                                       | same                             |
| scenario rule for connector 2, CALL names connector 1 | Still beats code (kind ranks before connector)                                                                                                         | same                             |

## Params and disable in the order

Schema 1.6 `useBehavior` (#654) fits the order without a new step.

- **`mode: "disable"` is a step 3 rule.** It registers a scenario rule for each action of the behavior that has
  an `Accepted` answer on the station's version; the rule answers `ctx.accepted(action)` at once and starts
  nothing. Being a scenario rule it beats the behavior's own rule (step 4 or the default at step 5) and every
  other code behavior, for exactly the length of the run, and it follows the within-a-step rules like any scenario
  rule (newest run first, exact connector first; the rule names no connector, so age decides). Policy and
  override still come before it.
- **`params` are not a rule.** They change what the winning rule does, not who wins. The behavior that answers
  reads `ctx.params`: its declared defaults, then the station's selection, then each running scenario's `params`,
  oldest first so the newest run's key wins. The params are read when the CALL arrives, so a CALL that is being
  answered, and its follow-up, are not affected by a run that starts or ends later.
- **A built-in is selected without a rule.** `useBehavior` of a `default.*` id only sets a params layer; the
  default keeps answering at step 5, as it always did.

Tests: `packages/core/src/test/behavior/params.bun.test.ts` ("mode disable", "outranks a loaded code behavior").

## Scenario parking is not a rule

`RemoteStartTransaction` / `RequestStartTransaction` and `RemoteStopTransaction` / `RequestStopTransaction`
have an older mechanism: a `remoteStartTrigger` / `remoteStopTrigger` node that is waiting on a connector
registers it in the station (`_scenarioHandledConnectors`, `_scenarioStopHandledConnectors`). That is
**parking**: when the CALL reaches the transaction default, the station answers `Accepted` and hands the
request to the waiting scenario (`remoteStartReceived`) instead of starting the transaction itself. It
also keeps `noteDefaultHandledRemoteStart` marks so that a trigger armed just after the default started a
transaction can warn that it raced it.

Parking belongs to the **default** behavior (`default.transaction`), so it follows from the order above:

- It is consulted only when the CALL **reaches step 5**. A `replace` rule of step 3 or 4 takes the CALL
  before the default runs; parking is not looked at, no request is handed to the waiting scenario and no
  transaction starts unless that rule does it.
- A code `extend` rule runs the default itself (`ctx.defaultBehavior`), so parking applies exactly as without
  the rule: the extend handler sees the CALL first, the default then parks or starts.
- A `csmsCallTrigger` with `behavior: "observe"` (the default) is not a rule: it observes the CALL and the
  default answers, parking included. That is what `remoteStartTrigger` is for.
- Policy and override come first, as for any CALL: a policy that refuses `RemoteStartTransaction` leaves the
  waiting trigger waiting.

The parking sets stay as they are because routing the same traffic through registry rules would change who
answers and when the race warning fires, which is not wire-neutral (design rule 4). The tests are
`packages/core/src/test/behavior/precedence.bun.test.ts` ("parking of RemoteStartTransaction relates to the
order").

## Which one to use

See [Scenario or behavior?](../analyses/scenario-or-behavior.md) for the choice between a scenario node and
a code behavior, with recipes.
