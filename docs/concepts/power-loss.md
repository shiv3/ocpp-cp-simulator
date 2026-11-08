---
title: Power loss and transaction recovery
type: concept
summary: A power loss is neither a network loss nor an OCPP Reset — the socket vanishes, the transactions survive, and after the reboot the station resumes or ends them as the OCPP version requires; driven by `power.loss` / `power.restore`.
sources:
  - packages/core/src/cp/domain/charge-point/ChargePoint.ts (powerLoss, restorePower, runPowerRecovery)
  - packages/contracts/src/methods.ts (power.loss, power.restore)
  - packages/core/src/test/goldenWire/regressionCases.ts (power-loss-*)
  - "issue #455"
related:
  - network-simulation.md
  - operational-timeline.md
  - charging-sessions.md
  - control-plane.md
  - ocpp-versions-and-transports.md
  - ../entities/scenario-templates.md
  - ../entities/mcp-endpoint.md
updated: 2026-11-08
---

# Power loss and transaction recovery

Three events take a station off the wire, and they differ on what the CSMS sees
afterwards:

| Event                                 | Socket                         | Transactions                                                              | Boot             |
| ------------------------------------- | ------------------------------ | ------------------------------------------------------------------------- | ---------------- |
| [Network loss](network-simulation.md) | closes, the station reconnects | keep running, messages queue                                              | BootNotification |
| OCPP Reset (1.6 §5.14, 2.x B11 / B12) | closes (Hard) or stays (Soft)  | stopped first (`HardReset` / `SoftReset`), or kept (`ImmediateAndResume`) | BootNotification |
| **Power loss** (#455)                 | gone at once, nothing sent     | **not ended**; id, tag, meter and the undelivered queue survive           | BootNotification |

The primitive is a pair of control-plane methods (and MCP tools), independent
of the network-simulation layer and of Reset:

| Method          | Params                                                                  | Result                                                                     |
| --------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `power.loss`    | `{ cpId, restoreAfterMs?, transactions?, txResumptionTimeoutSeconds? }` | `{ ok: true, transactions }` or `{ ok: false, error }`                     |
| `power.restore` | `{ cpId, transactions?, txResumptionTimeoutSeconds? }`                  | `{ ok: true, outageMs, recovery, transactions }` or `{ ok: false, error }` |

Errors: `cp_not_found`, `already_powered_off`, `not_powered_off`. MCP tools:
`power_loss`, `power_restore` ([MCP endpoint](../entities/mcp-endpoint.md)).
`restoreAfterMs` is the outage duration: power returns by itself (up to one
week); without it the station stays off until `power.restore`. While off,
`connect` is refused (logged, no effect) and nothing is sent. The timeline
records `power_lost` and `power_restored`
([Operational timeline](operational-timeline.md)).

## What survives

The simulated non-volatile state is the `ChargePoint` object itself: every
connector's transaction (id, tag, meter, start time), the queue of transaction
messages that could not be delivered (also persisted with `--state-db`, see
[State persistence](state-persistence.md)), configuration, the Local
Authorization List and availability. What a real power cut would erase is
cleared as for any disconnect: pending in-flight CALLs go to the queue, charging
profiles are cleared (`ConnectionClosed`; 2.1 E17 does not require `TxProfile`
persistence), and the meter ticker stops. Scenario runs are the simulated
operator's script and keep running; a `connectionTrigger` wait survives the
outage by design.

## After the power returns

`power.restore` connects again and boots: BootNotification first (1.6 §4.2 —
no other request until it is Accepted or Pending; 2.x B01.FR.03 names a "power
outage" as a reboot reason, and the 2.x BootNotification carries `reason`
`PowerUp`). Once it is **Accepted**, the station sends, in this order, the
status fan-out, the queued transaction messages (1.6 §4.7 / errata 3.18; 2.x
E04 / E12.FR.01-02, marked offline), then the recovery of the interrupted
transactions:

| Version | Default       | Resume (`transactions: "resume"`)                                                                                                                                                                                                 | End (`transactions: "end"`)                                                                                                                                                    |
| ------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.6     | resume        | The transaction keeps its id; the meter restarts; nothing extra on the wire (1.6 has no resumption message; it is left to the implementation).                                                                                    | `StopTransaction` with `reason: PowerLoss` ("Complete loss of power", 1.6 §7.36 StopReason), `timestamp` = the moment of the loss.                                             |
| 2.0.1   | end           | The transaction continues; no event is sent — `TxResumed` is not in the 2.0.1 `TriggerReasonEnumType`.                                                                                                                            | `TransactionEvent(Ended)`, `triggerReason: AbnormalCondition`, `stoppedReason: PowerLoss`, `timestamp` = the loss (as E17.FR.21 does for 2.1).                                 |
| 2.1     | resume if due | Only when `txResumptionTimeoutSeconds` > 0 and the outage lasted at most that long (E17.FR.10, E17.FR.01): `TransactionEvent(Updated)` with `triggerReason: TxResumed` and the charging state from before (E17.FR.14, B13.FR.30). | Otherwise (timeout absent, 0, or exceeded: E17.FR.20, TC_E_114 / TC_E_115 / TC_E_116): `TransactionEvent(Ended)`, `AbnormalCondition`, `stoppedReason: PowerLoss` (E17.FR.21). |

On 2.1 a requested `resume` is therefore still subject to the timeout, and
`end` always ends. `txResumptionTimeoutSeconds` stands in for the device-model
variable `TxCtrlr.TxResumptionTimeout`, which the simulator does not expose as a
configuration key; it is accepted on every version but only 2.1 reads it.

An `end` goes through the normal stop path: after the `StopTransaction` /
`Ended` the connector reports `Finishing` and `Available`, exactly as for any
stop. If the boot is not Accepted, the recovery waits for the next Accepted
boot. A second `power.loss` before then replaces it.

### Not modeled

`TxAllowEnergyTransferResumption` (E17.FR.12-13: resuming into
`SuspendedEVSE`) and `EnergyTransferResumptionRandomRange` (E17.FR.18) are not
modeled; a resumed transaction returns in the state it had. The 2.x `offline`
flag on events produced during the outage follows the existing offline queue.
OCPP-S (SOAP) charge points have no socket to drop: the loss only silences them.

## Golden wire cases

`power-loss-resume`, `power-loss-end` and `power-loss-queued-then-end`
(`packages/core/src/test/goldenWire`) pin the frames above on 1.6 and 2.0.1;
2.1 is covered by `ChargePoint.powerLoss.test.ts`, as the golden rig speaks
1.6 and 2.0.1 only.

See also the [resilience templates](../entities/scenario-templates.md#resilience-templates-resilience-),
which wait for the loss and assert the recovery.
