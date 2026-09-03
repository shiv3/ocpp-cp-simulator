---
title: Network simulation
type: concept
summary: Phase-1 in-process fault injection for WebSocket charge points — seeded latency/jitter, manual and periodic disconnects, delayed reconnect — configured at runtime (UI, RPC, MCP) as a global layer with per-CP null-tombstone overrides.
sources:
  - src/ (network-sim rule engine; issue #242)
  - src/cli/server/__tests__/networkSimMcp.bun.test.ts
related:
  - control-plane.md
  - ../entities/mcp-endpoint.md
  - ../entities/web-console.md
  - state-persistence.md
  - scenario-format.md
updated: 2026-09-03
---

# Network simulation

Phase 1 of network condition simulation adds in-process fault injection for
WebSocket charge points: configurable latency (with jitter), forced
disconnects, and delayed reconnection. Configuration is **off by default** and
applies globally (all CPs) or per-charger with null-tombstone override
semantics. The same seed always produces the same fault sequence
(deterministic via a seeded PRNG).

**Configuration** — via the browser UI (`/v3/settings` for global,
`/v3/cp/:id` for per-charger), the daemon's [RPC methods](#rpc-methods), or the
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
      "messageType": "CALL"
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

## Persistence

Configs are stored in the [state database](state-persistence.md) (if
`--state-db` is configured) under keys `networkSim:global` and
`networkSim:cp:<cpId>`. Configs survive daemon restart and are automatically
applied before a restored CP reconnects. A corrupt stored value is logged and
treated as absent (graceful degradation).

## Protocol timer behaviors

- **Delayed BootNotification**: A CALL delayed by latency rules does not
  release the boot gate until the response is received. A boot acceptance gate
  blocks transitions until BootNotification receives CALLRESULT.
- **Periodic disconnects**: Periodic rules may fire before boot acceptance
  completes. This is **tolerated** — not a protocol violation, merely a fault
  condition that CSMS must handle.
- **Heartbeat idle tracking**: Heartbeat timeout tracking anchors to the
  moment the frame is **physically written** to the socket (after all latency
  delays). A 30-second heartbeat interval becomes (30s + applied latency), so
  do not set heartbeat intervals below 60s when injecting significant latency.

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
