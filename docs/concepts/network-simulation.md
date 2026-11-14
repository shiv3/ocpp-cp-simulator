---
title: Network simulation
type: concept
summary: Phase-1 in-process fault injection for WebSocket charge points — seeded latency/jitter, manual and periodic disconnects, delayed reconnect — plus the SIM-scoped cellular service gate and byte-aware throttling (#930) — configured at runtime (UI, RPC, MCP) as a global layer with per-CP null-tombstone overrides.
sources:
  - packages/core/src/cp/infrastructure/transport/network-sim/ (rule engine; issue #242)
  - apps/cli/src/server/__tests__/networkSimMcp.bun.test.ts
  - packages/core/src/cp/domain/modem/cellularLink.ts (SIM-scoped link resolution; issue #930)
  - packages/core/src/test/goldenWire/cellularLink.bun.test.ts
related:
  - control-plane.md
  - ../entities/mcp-endpoint.md
  - ../entities/web-console.md
  - state-persistence.md
  - scenario-format.md
  - operational-timeline.md
  - power-loss.md
  - cellular-modem.md
updated: 2026-11-14
---

# Network simulation

Phase 1 of network condition simulation adds in-process fault injection for
WebSocket charge points: configurable latency (with jitter), forced
disconnects, and delayed reconnection. Configuration is **off by default** and
applies globally (all CPs) or per-charger with null-tombstone override
semantics. The same seed always produces the same fault sequence
(deterministic via a seeded PRNG).

**Configuration** — via the browser UI (`/settings` for global,
`/cp/:id` for per-charger), the daemon's [RPC methods](#rpc-methods), or the
[MCP tools](../entities/mcp-endpoint.md#network-simulation-tools). There are
**no `--network-sim-*` startup flags** in Phase 1 — configuration is applied at
runtime or persisted to the state database.

**Where it runs** — the rule engine is part of the charge-point domain, so it
works both in the daemon (Remote mode, Docker, desktop app) and in the
browser's Local mode (`LocalChargePointService` re-applies the layers live
from the settings store). The RPC / MCP methods and `--state-db` persistence
are daemon-only; Local mode keeps the layers in its own IndexedDB-backed
store. The single-CP CLI REPL / `--json` modes have no configuration surface
for it.

**Layering & null semantics** — global and per-CP layers merge with per-CP
overrides winning. Setting per-CP config to `null` deletes the override and
reverts to the global layer. A `null` global and `null` per-CP means the
feature is disabled.

**Determinism** — the rule engine is seeded; identical seed + rule order
produces identical fault timings across different instances. Useful for
reproducing issues or running A/B tests.

**WebSocket only** — OCPP 1.2/1.5/1.6 (SOAP) charge points are unaffected.
The simulation applies only to WebSocket transports
(`network_sim.disconnect.trigger` answers `soap_unsupported` for a SOAP CP).

## Rule schema and example

A layer config contains an optional seed (uint32) and a flat rules object.
Each rule must have a type:

```json
{
  "enabled": true,
  "seed": 12345,
  "rules": {
    "latency-rule": {
      "type": "latency",
      "direction": "both",
      "delayMs": 500,
      "jitterMs": 100,
      "match": { "actions": ["MeterValues", "StatusNotification"] }
    },
    "disconnect-rule": {
      "type": "manual-disconnect",
      "reconnectDelayMs": 2000
    },
    "periodic-rule": {
      "type": "periodic-disconnect",
      "intervalMs": 10000,
      "intervalJitterMs": 2000,
      "reconnectDelayMs": 1500
    }
  }
}
```

A rule accepts only its own fields; anything else is `invalid_params`
(`config.rules.<id>.<field>: unknown field`). A `latency` rule takes
`direction` (`upstream`, `downstream` or `both`), `delayMs`, `jitterMs` and
`match`: with `match.actions`, it delays only frames of those OCPP actions,
without it every frame (#497).

All bounds come from the spec: `delayMs`, `jitterMs`, `reconnectDelayMs` ∈
[0, 120000] ms; `intervalMs` ∈ [1, 2000000] ms; `intervalJitterMs` ∈
[0, 2000000] ms.

### Seeded determinism

The same seed always produces the same fault sequence within a rule set:

```js
// Both instances with seed 42 will have identical latency timing
{ "enabled": true, "seed": 42, "rules": { ... } }
```

## RPC methods

| Method                           | Params                                                        | Result / purpose                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network_sim.global.get`         | `{}`                                                          | Return the global network-sim layer config, or `null` if disabled.                                                                                                      |
| `network_sim.global.save`        | `{ "config": NetworkSimLayerConfig \| null }`                 | Validate and persist the global config. `null` disables the feature. Applies to all live WebSocket CPs.                                                                 |
| `network_sim.cp.get`             | `{ "cpId": string }`                                          | Return `{ config: NetworkSimLayerConfig \| null, resolved: ResolvedNetworkSimConfig }` for the CP.                                                                      |
| `network_sim.cp.save`            | `{ "cpId": string, "config": NetworkSimLayerConfig \| null }` | Validate and persist per-CP config. `null` deletes the override (reverts to global layer).                                                                              |
| `network_sim.disconnect.trigger` | `{ "cpId": string, "ruleId": string }`                        | Manually trigger a network-sim rule (must be a manual-disconnect rule). Errors: `cp_not_found`, `soap_unsupported`, `sim_disabled`, `rule_not_manual`, `not_connected`. |

These are daemon-level methods of the [control plane](control-plane.md#daemon-methods)
(no `cpId` envelope field; the CP is named in `params`).

## SIM-scoped service and throttling (#930)

The rules above target a charge point's socket. A **cellular outage is not a
forced disconnect with a delayed reconnect**: a suspended SIM must keep the
link down until service is restored, however the station tries to dial. This
layer is separate from the latency / disconnect rules and is driven by the
[modem and SIM model](cellular-modem.md).

**Which stations.** Only a station with a modem model whose `networkInterface`
is `cellular`. A station on `ethernet` / `wifi` keeps its session while its
unused SIM is suspended, removed or blocked, and caps do not apply to it (no
implicit failover or multi-interface routing). A station without a modem model
(the legacy default) is never touched.

**Resolution** (`resolveCellularLink`, pure): the link is available only with a
modem, a card, an `active` subscription and no `blocked` policy. The reasons
are independent and all reported: `modem_absent`, `sim_missing`,
`subscription_suspended`, `sim_network_blocked`. (`no_coverage`, proposed in
#930, is reserved: coverage is not simulated.)

**The gate.** When the link goes down the open socket is closed with the
`simulated` cause (not an error, not a station fault) and the station keeps
its power and its transactions; queued messages are salvaged as for any lost
link. While it is down, **no path opens a socket**: an operator `connect`, a
`reset`, the reconnect timer and a daemon restart (the gate is evaluated when
the charge point is built, before it connects) all end without a connection. A
`connect` is remembered and dials when service returns; an operator
`disconnect` forgets it. The down time **consumes none of the reconnect
attempt budget** (#609). On restore the station dials with a fresh budget
through the normal `connect()`. It is not rebooted and no BootNotification is
fabricated: OCPP 2.x resumes without one while its boot data is unchanged
(#702); OCPP 1.6 boots on every connect, as for any reconnect.

**Policies.** `network_sim.cellular.save` installs a persisted set, policy id →

```json
{
  "match": { "iccid": "8944501234567890123" },
  "service": "blocked",
  "upstreamBytesPerSecond": 2000,
  "downstreamBytesPerSecond": 8000,
  "enabled": true
}
```

`match` has exactly one of `simId` (the simulator's SIM identity), `iccid` or
`operator` (a label shared by a group of cards). `service` is `online`
(default) or `blocked`. Caps are optional integers (bytes per second,
1-1,000,000,000). Selection is dynamic and by the card currently in the slot:
a policy applies to stations that acquire a matching SIM later (insert,
replace) and to charge points created later, without a rule per `cpId`.
**Precedence:** there is none to get wrong, because policies only restrict:
`blocked` beats `online` (an `online` policy never reactivates a suspended
subscription or undoes a block), the lowest matching cap per direction wins,
and the result does not depend on policy order or selector. The global and
per-CP `network_sim` layers never touch the gate: a per-CP rule cannot bring a
suspended or blocked SIM back. Those layers are preserved as they were.

**Throttling.** A cap makes a frame occupy the link for `bytes / cap` seconds,
one frame at a time per direction, on top of any latency rule; deadlines are
FIFO so order is kept and a large frame delays everything behind it. It is
**byte-aware** (UTF-8 length of the OCPP-J frame) and deterministic (no
randomness; the clock is the only input). The queue is the pipeline's bounded
budget (512 frames / 2 MiB per direction): a frame over the budget is rejected
explicitly (downstream: logged `queue_overflow`; upstream: the sender's
`queue_overflow` settlement), and frames still queued when the link closes are
settled `socket_closed` with the close cause, never silently lost.

**What is and is not simulated.** An in-process, protocol-level approximation
of payload throughput on the WebSocket. Not simulated: TCP (windows, half-open
connections, retransmission), TLS and WebSocket framing overhead, radio
registration, signal quality, QoS, packet loss. OCPP-S / SOAP stations are not
gated or throttled (their transport is not a socket); their link is reported
with `enforced: false`. The policies and their persistence are daemon features;
browser Local mode honours the SIM state (a suspended SIM holds the link down)
but has no policy store. An external TCP proxy backend (Toxiproxy) was
considered in #930 and is not part of this change: the in-process engine works
in the browser and the daemon without extra infrastructure, and the policy
resolution is independent of how the caps are enforced, so a proxy backend can
be added later behind the same seam.

| Method                        | Params                           | Result / purpose                                                                                                                                                                                       |
| ----------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `network_sim.cellular.get`    | `{}`                             | `{ policies }` (empty object when none).                                                                                                                                                               |
| `network_sim.cellular.save`   | `{ "policies": object \| null }` | Validate, persist (`kv` key `networkSim:cellular`) and push to every charge point. Replaces the whole set; `null` clears it. Invalid: `invalid_params`, the previous set stays.                        |
| `network_sim.cellular.status` | `{}`                             | `{ policies, total, unavailable, throttled, cps: [{ cpId, link }] }`: the governed stations (those with a modem model) and each one's link: `available`, `reasons`, effective caps, matching policies. |

`modem.get`, the status wire and the MCP tools (`cellular_policy_get`,
`cellular_policy_set`) show the same `link`. The
[operational timeline](operational-timeline.md) records `cellular_link_lost`,
`cellular_link_restored` and `cellular_throughput_changed`, next to the
`disconnected` / `connected` entries they cause.

## Persistence

Configs are stored in the [state database](state-persistence.md) (if
`--state-db` is configured) under keys `networkSim:global` and
`networkSim:cp:<cpId>`; the cellular policy set is the single document
`networkSim:cellular`. Configs survive daemon restart and are automatically
applied before a restored CP reconnects. A corrupt stored value is logged and
treated as absent (graceful degradation).

## Faults on the operational timeline

A firing `manual-disconnect` or `periodic-disconnect` rule is recorded on the
charge point's [operational timeline](operational-timeline.md) as
`network_fault_injected` (`ruleId`, `ruleType`, `reconnectDelayMs`), before the
socket closes. It opens an incident: the `disconnected`, `reconnecting`,
`connected`, `boot_notification` and status entries that follow share its
`incidentId`, and `recovery_completed` reports how long the charge point took
to be connected, booted and back to its pre-fault connector statuses (#448).
The `[RULE:<id>] DISCONNECT forced` log line is unchanged. Latency rules are
not recorded.

## Protocol timer behaviors

- **Delayed BootNotification**: A CALL delayed by latency rules does not
  release the boot gate until the response is received. A boot acceptance gate
  blocks transitions until BootNotification receives CALLRESULT.
- **Periodic disconnects**: Periodic rules may fire before boot acceptance
  completes. This is **tolerated** — not a protocol violation, merely a fault
  condition that CSMS must handle.
- **Forced disconnects are not errors**: a disconnect a rule forces is logged
  as `[RULE:<id>] DISCONNECT forced; …` (`NETWORK_SIM`) and
  `WebSocket closed: … cause=simulated` (`WEBSOCKET`), and emits
  `disconnected`. It does not set the charge point's `error` field or emit an
  `error` event (#474).
- **A connect cuts the reconnect delay short**: an operator `connect` (or a
  reset) during `reconnectDelayMs` connects right away and cancels the
  delayed reconnect, so no second socket opens over the new one (#478).
- **Heartbeat idle tracking**: Heartbeat timeout tracking anchors to the
  moment the frame is **physically written** to the socket (after all latency
  delays). A 30-second heartbeat interval becomes (30s + applied latency), so
  do not set heartbeat intervals below 60s when injecting significant latency.

## Network loss is not power loss

A network fault keeps the station running: transactions go on, meter values
queue and replay. A station that loses _power_ vanishes without a clean stop and
recovers its transactions after the reboot; see
[Power loss and transaction recovery](power-loss.md) (#455) for that primitive
and what it sends in 1.6 and 2.x.

## Interaction with scenarios

A scenario's `connectionTrigger` node only _observes_ connection state — it
never causes a disconnect itself. Combine it with a `manual-disconnect` rule
and `network_sim.disconnect.trigger` to script "drop, wait, reconnect"
sequences (see [Scenario format → connectionTrigger](scenario-format.md#connectiontrigger-notes)).

## Documented limitations

These require future proxy-mode work:

- Cannot reproduce TCP-level half-open connection states.
- TLS-level handshake failures are out of scope.
- Browser Ping/Pong frames and their failures are not simulated.
