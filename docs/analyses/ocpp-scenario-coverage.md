---
title: OCPP scenario coverage against the OCA test cases
type: analysis
summary: Whether the simulator and its scenarios can run the OCA OCPP 2.0.1 Charging Station test cases (424 of them), counted per functional block and certification profile, with the gaps grouped, ranked by the test cases they unlock and put in an implementation order.
sources:
  - packages/core/src/cp/infrastructure/transport/v201/inboundRegistryV201.ts
  - packages/core/src/cp/infrastructure/transport/v201/csmsAcksV201.ts
  - packages/core/src/cp/infrastructure/transport/v21/inboundRegistryV21.ts
  - packages/core/src/cp/application/scenario/ScenarioTypes.ts
  - packages/core/src/cp/application/scenario/ScenarioExecutor.ts
  - packages/core/schema/scenario.schema.json
  - packages/core/src/cp/domain/charge-point/ChargePoint.ts
  - "OCA OCPP 2.0.1 edition 4: Part 2 specification, Part 5 certification profiles, Part 6 test cases"
  - "OCA OCPP 2.1 edition 2: Part 5 and Part 6 (test case list only)"
  - "PRs #673, #676, #685, #686, #865, #869, #872, #873, #880, #881"
related:
  - ../concepts/scenario-format.md
  - ../concepts/security-profiles.md
  - ../concepts/charging-sessions.md
  - ../concepts/ocpp-versions-and-transports.md
  - ../entities/default-behaviors.md
  - testing-strategy.md
  - scenario-or-behavior.md
updated: 2026-11-09
---

# OCPP scenario coverage against the OCA test cases

The Open Charge Alliance certifies a Charging Station with a test tool that plays the CSMS and asks a person to do the
physical steps (plug in, present a card, reboot, pull the cable). This page answers one question: can the simulator,
driven by [scenarios](../concepts/scenario-format.md), stand in for the station in every one of those test cases, and
if not, what is missing and in what order should it be built.

**Short answer: not yet, and the gap is in the station, not in the scenario language.** Of the 424 OCPP 2.0.1 Charging
Station test cases (`TC_<block>_<nn>_CS`), 228 (54%) can be run today: the station does what the test needs and every
manual step can be scripted. Nine more (2%) become runnable when open PRs land. The other 187 (44%) are blocked: 144
only by missing station behavior, 43 by missing station behavior and a missing scenario construct, and none by the
scenario language alone. The scenario work that is planned (block-tree editor, `switch` and `choice` editors,
`$from` root `response`, `$match`, timeout edges, parallel and join) makes scenarios easier to write; it unlocks no
test case by itself, because the OCA test cases are driven by the CSMS and a scenario on the station side only
waits, acts and asserts.

## Method

- **Test case list.** The 424 `TC_*_CS` cases of OCPP 2.0.1 edition 4 Part 6 (blocks A to P), each with its use
  cases, the "manual action" lines, the reusable states it runs through, and its certification profile and
  mandatory or conditional status from Part 5. Test-case names in this page are paraphrases; the OCA texts are not
  reproduced.
- **Two ratings per test case**, made by reading the test text against the code (grep and read, nothing was run):
  - _Station_ (`impl`, `partial`, `missing`): does the simulated station do what the test needs? Handlers in
    `transport/v201/`, the station domain, the engine behaviors, the device model, the wiki pages.
  - _Script_ (`now`, `now-cp`, `new:<construct>`, `behavior`): can the manual steps be performed by a scenario,
    assuming the station behavior exists? `now-cp` means a step exists only as a control-plane or CLI method
    (`ev_ready`, `power.loss`, `get_15118_ev_certificate`, the network simulation) and not as a node. `behavior`
    means the gap is a station setting, not the language. A test the Test System drives completely is `now`: the
    scenario is waits and assertions.
- **State of a test case.** _Covered_ is station `impl` and script `now` or `now-cp`; the four cases that are `now-cp`
  (B_03, M_27, N_22, N_23) are counted as covered because the step has a control-plane method. _Covered with planned
  work_ is not covered today but is addressed by an open PR that says so. _Not covered_ is everything else.
- **Planned work** is counted separately and never as covered: station PRs #673 (TriggerMessage targets), #676
  (device model registry) and #685 (base report), #686 (reason codes), and the scenario work listed under
  [What the planned scenario features unlock](#what-the-planned-scenario-features-unlock). Only #673 and #685 change
  a rating.
- **Checked against the code.** The ratings were made on an older checkout; a sample of 65 (stratified by block and
  by station rating) was re-checked on `origin/main` at `c8b25a68`. See [Confidence](#confidence).
- **Not counted:** the OCTT tool itself (no 2.0.1 scenario templates ship; "covered" means expressible and
  supported, not that a template exists), certification as such, and the Charging Station Management System
  test cases.

## Headline numbers

| Result                                                 | Test cases | Share |
| ------------------------------------------------------ | ---------- | ----- |
| Covered today                                          | 228        | 54%   |
| Covered once the open PRs land (#673: 7, #685: 2)      | 9          | 2%    |
| Not covered: station behavior only                     | 144        | 34%   |
| Not covered: station behavior and a scenario construct | 43         | 10%   |
| Not covered: scenario construct only                   | 0          | 0%    |
| **Total**                                              | **424**    |       |

Only 4 test cases are held back by a missing node alone, and those four already count as covered because a
control-plane method does the step. Adding every missing node would not move the number; the nodes pay off only
together with station work.

### By functional block

| Block                                 | Test cases | Covered | Covered with planned work | Not covered: station only | Not covered: station and script |
| ------------------------------------- | ---------- | ------- | ------------------------- | ------------------------- | ------------------------------- |
| A Security                            | 16         | 5       | 0                         | 10                        | 1                               |
| B Provisioning                        | 48         | 20      | 2                         | 25                        | 1                               |
| C Authorization                       | 55         | 33      | 0                         | 9                         | 13                              |
| D Local authorization list management | 9          | 8       | 0                         | 1                         | 0                               |
| E Transactions                        | 47         | 23      | 0                         | 10                        | 14                              |
| F Remote control                      | 24         | 15      | 7                         | 2                         | 0                               |
| G Availability                        | 21         | 18      | 0                         | 2                         | 1                               |
| H Reservation                         | 21         | 18      | 0                         | 3                         | 0                               |
| I Tariff and cost                     | 3          | 0       | 0                         | 3                         | 0                               |
| J Meter values                        | 10         | 6       | 0                         | 4                         | 0                               |
| K Smart charging                      | 44         | 21      | 0                         | 17                        | 6                               |
| L Firmware management                 | 15         | 0       | 0                         | 15                        | 0                               |
| M ISO 15118 certificate management    | 25         | 18      | 0                         | 4                         | 3                               |
| N Diagnostics                         | 52         | 36      | 0                         | 13                        | 3                               |
| O Display message                     | 31         | 4       | 0                         | 26                        | 1                               |
| P Data transfer                       | 3          | 3       | 0                         | 0                         | 0                               |
| **All**                               | **424**    | **228** | **9**                     | **144**                   | **43**                          |

### By certification profile

A test case can belong to more than one profile, so the rows add up to more than 424.

| Certification profile               | Test cases | of which mandatory | Covered | Covered (mandatory only) |
| ----------------------------------- | ---------- | ------------------ | ------- | ------------------------ |
| Core                                | 224        | 105                | 121     | 68                       |
| Local Authorization List Management | 22         | 0                  | 18      | 0                        |
| Advanced Device Management          | 42         | 1                  | 31      | 0                        |
| Advanced User Interface             | 33         | 0                  | 4       | 0                        |
| Reservation                         | 22         | 0                  | 18      | 0                        |
| Advanced Security                   | 7          | 5                  | 4       | 4                        |
| Smart Charging                      | 37         | 34                 | 20      | 19                       |
| ISO 15118                           | 60         | 54                 | 29      | 28                       |
| Not in any Part 5 profile           | 12         | 0                  | 3       | -                        |

Of the 167 test cases that are mandatory in at least one profile, 100 are covered and 1 more is planned. Core has 105
mandatory cases, 68 covered. Smart Charging has 34 mandatory, 19 covered; ISO 15118 has 54, 28 covered; Advanced
Security 5, 4 covered. The Advanced User Interface profile (display messages) is conditional throughout and almost
entirely uncovered (4 of 33).

### OCPP 1.6 and 2.1

**1.6.** The OCA 1.6 test cases are not part of the material this analysis used, so 1.6 is rated per feature of the
specification and the security whitepaper (73 items: sections 3 to 5, the errata and the security profiles), not per
test case. Station: 60 `impl`, 10 `partial`, 3 `missing`. Script: 59 `now`, 8 `now-cp`, 4 `behavior`, 1 `new` and 1
not applicable. 51 items are covered outright and 6 more need only a control-plane step. The partial items are
small: no `MinimumStatusDuration` debounce, a local stop does not take the presenting tag (the same gap as
`presentToken` below), `RemoteStartTransaction` ignores `chargingProfile`, `GetDiagnostics` cannot upload to FTP,
a few SetChargingProfile and reboot-persistence rules. 1.6 is the only version with scenario templates
(`cert16-*`, 48 files). The two-version view is the same as for 2.0.1: the station is further along than the
scenario language, and the missing nodes (`evReady`, `powerCycle`, network offline and online) cost 1.6 as well.

**2.1.** All 424 test case ids of 2.0.1 exist in 2.1 edition 2, plus 154 new ones. The 424 are rated as for 2.0.1;
the text may have changed in places and the 2.1 edition was not re-read case by case, so treat those numbers as
approximate for 2.1. The 154 new cases were not rated one by one. By block: smart charging 32 (priority charging,
randomized delay, `limitAtSoc`, dynamic profiles, EMS control), V2X Q 25, payment and settlement C 23, tariff and
cost I 22, transactions E 14, network connection profiles B 13, diagnostics N 9, DER control R 8, battery swap S 3,
other 5. The 2.1 registry answers the features behind most of these with `NotSupported` or `Rejected`: DER control,
AFRR, periodic event streams, `ChangeTransactionTariff` (a CALLERROR), `ClearTariffs` (`NoTariff`), V2X, battery
swap, payment terminals. The ones that are probably runnable are the `ImmediateAndResume` reset cases
(B_101 to B_104, `reset.ts`) and `UsePriorityCharging` (K_118, implemented in the 2.1 registry); I expect fewer than
10 of the 154 to pass, and 2.1 is out of reach until the 2.0.1 gaps below are closed and the 2.1 features are built.

## What the planned scenario features unlock

| Feature                                                                            | Status                                                         | Test cases it unlocks                                                                                                                                                  | Why                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Block-tree editor (steps A to C), `switch` and `choice` editors, `$from` editor    | merged (#865, #872, #873, #869)                                | 0                                                                                                                                                                      | Authoring only.                                                                                                                                                                     |
| `$from` root `response`                                                            | in review (#880)                                               | 0                                                                                                                                                                      | Lets a scenario branch on the answer to its own `ocppCall`. In an OCA test case the CSMS decides and the station behavior reacts; the scenario does not branch.                     |
| `$match` matchers in `switch`                                                      | in review (#881)                                               | 0                                                                                                                                                                      | Same: richer conditions for authored scenarios.                                                                                                                                     |
| `trigger`, `config`, `variable`, `step`, `run` roots, `saveAs`, `ocppCall` timeout | planned (design in the data-flow proposal, no PR yet)          | 0 now; `config` and `variable` help check preconditions such as B_06, whose default must be set first                                                                  | Reading station settings in a scenario.                                                                                                                                             |
| Timeout edges                                                                      | in progress (branch `feat/scenario-timeout-edges`, schema 1.7) | 0 blocked; 31 cases that now use a `delay` plus an `ocpp_absent` assertion as a negative wait (for example C_02, C_05 to C_08, E_39, E_52, N_16) become explicit paths | "The station must not send X within N s" and "go on if the CSMS stays silent" (E_41, E_50). Today the wait fails the run on timeout, so the negative check is a post-run assertion. |
| Parallel and join                                                                  | in progress (branch `feat/scenario-parallel-join`)             | 0 blocked; B_41, F_14, H_10, L_12, L_14 drive two connectors in step, which one scenario per connector cannot synchronize                                              | A single scenario that waits for either of two CALLs or drives two EVSEs.                                                                                                           |

The one place where planned scenario work matters for coverage is the last column of the next section: none of the
nodes below is planned. They are small, because for each one a control-plane method already exists.

## Gaps, grouped and ranked

Ranking uses three things in this order: test cases that are mandatory in a certification profile, the number of test
cases a fix unlocks, and rough effort (S: days, M: a week or two, L: more). Effort is a judgment, not an estimate
from the backlog. "Unlocks" counts the cases whose station gap is this one; where the table says "also script", some
of those also need a scenario node from the second table, so the fix alone does not make them pass.

### Station behavior

| Rank | Gap                                        | What is missing                                                                                                                                                                                                                                                                                                                                                                                          | Unlocks             | Mandatory | Also script | Effort |
| ---- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | --------- | ----------- | ------ |
| 1    | 2.x boot security event                    | A 2.x station sends no `StartupOfTheDevice` or `ResetOrReboot` security event; both are gated to OCPP 1.6 in `ChargePoint.ts`. Every test that runs the reusable state Booted expects one. Seventeen cases depend on it (nine mandatory); five fail on nothing else (B_01, C_32, G_18, G_21, N_53)                                                                                                       | 5 now, 17 touched   | 3         | 1           | S      |
| 2    | `SecurityCtrlr.BasicAuthPassword`          | Not in the device model: SetVariables answers `UnknownVariable` where the tests expect `Accepted` or `Rejected`; no reconnect with the new password; no write-only monitoring (A_09, A_10, N_48, A_01)                                                                                                                                                                                                   | 4                   | 3         | 1           | S      |
| 3    | Network profiles, TLS trust, root handling | `SetNetworkProfile` always answers `Rejected`; no `NetworkConfigurationPriority`, profile slots, `ActiveNetworkProfile`, fallback to the previous profile, back-off bookkeeping; `AdditionalRootCertificateCheck` unmapped; roots installed by `InstallCertificate` do not join the TLS trust (`--tls-ca` only); no `InvalidTLSVersion` or invalid-CSMS-certificate events                               | 16                  | 8         | 0           | L      |
| 4    | Smart charging fidelity                    | 2.x schedule `duration` and `schedule.id` are not stored as sent (reports differ); no `transactionId` kept on a `TxProfile`; `GetCompositeSchedule` drops uncapped periods, has no station local limit, ignores stacked-profile fall-through and has no `LimitChangeSignificance`; `RequestStartTransaction` does not install its `TxProfile`; no `RateUnit` capability; no external-constraints purpose | 18                  | 15        | 1           | M      |
| 5    | Display message store                      | `SetDisplayMessage` answers `Rejected`, `GetDisplayMessages` and `ClearDisplayMessage` answer `Unknown`: no store, no priority, state or time window, no `NotifyDisplayMessages`, no virtual display                                                                                                                                                                                                     | 27                  | 0         | 1           | M      |
| 6    | Transaction start and stop points          | `TxStartPoint` / `TxStopPoint` accept `Authorized`, `EVConnected` (start) and `Authorized,EVConnected`, `EVConnected` (stop) since #697: there is no start on power-path close, energy flow, signed data or parking-bay occupancy, and no matching stop                                                                                                                                                  | 12                  | 0         | 4           | M      |
| 7    | EV-side disconnect and suspend             | `Ended` after an EV-side unplug has no `chargingState` `Idle`; `StopTxOnEVSideDisconnect` false does not give `SuspendedEV` and resume on replug; `EVConnectionTimeOut` is not armed after an unplug; the first `Updated` with `Charging` is deduped away after a cable-first or remote start (E_03, F_01)                                                                                               | 10                  | 0         | 8           | M      |
| 8    | Firmware update realism                    | The train runs and reports, but nothing is fetched or verified; signature and certificate checks are simulated by `failAt`; no reconnect after install; the first boot after install has the wrong reason; the download is not deferred during a transaction; an unsigned request is accepted; no `Rejected` when the running update cannot be cancelled                                                 | 15                  | 8         | 0           | M      |
| 9    | Device model and reports                   | `GetReport` ignores `componentCriteria`; no `NotSupported` for unsupported bases or criteria; required variables absent (`DeviceDataCtrlr`, `SecurityCtrlr.SecurityProfile`, `ClockCtrlr`); `attributeType` not echoed on unsupported attribute types; unknown component resolved before unknown variable on EVSE monitors. #676, #685 and #686 cover part of it                                         | 15 (plus 2 planned) | 5         | 0           | M      |
| 10   | Token presented during a transaction       | A running transaction ignores a second token: no group-id stop, no master pass (`MasterPassGroupId` is only checked for remote start), the local list drops `groupIdToken`, no `DisablePostAuthorize`, no `DisableRemoteAuthorization`                                                                                                                                                                   | 16                  | 0         | 8           | M      |
| 11   | ISO 15118 and Plug and Charge              | No contract authorization (`Authorize` never carries a certificate or hash data), no `NotifyEVChargingNeeds` or `NotifyEVChargingSchedule`, no EV model, no `ISO15118Ctrlr` variables                                                                                                                                                                                                                    | 16                  | 13        | 16          | L      |
| 12   | Reset and reboot semantics                 | A 2.x `Reset` re-boots on the open socket instead of reconnecting; a plugged idle connector is reported `Available` after reboot where the tests want `Occupied`; a station reset drops reservations; no boot gate that answers CALLs with `SecurityError` while rejected; no capability to declare EVSE reset unsupported                                                                               | 8                   | 4         | 1           | S      |
| 13   | Customer information and logs              | `CustomerInformation` and `GetLog` have no cannot-process or no-data state, no notification when clearing without a report, a non-empty "no data" report, no failing upload                                                                                                                                                                                                                              | 9                   | 4         | 1           | M      |
| 14   | Cost display                               | `CostUpdated`, `totalCost` and `updatedPersonalMessage` are acknowledged and dropped; no `TariffCostCtrlr`; no web-payment flow                                                                                                                                                                                                                                                                          | 4                   | 0         | 0           | M      |
| 15   | Signed and idle-time meter values          | Clock-aligned samples are never signed; `SendDuringIdle` leaves the `Started` meter value in; no `Transaction.Begin` sample on the plug-in `Updated`                                                                                                                                                                                                                                                     | 3                   | 0         | 0           | S      |
| 16   | Reservation capabilities                   | `connectorType` is ignored; no `ReservationCtrlr` enable or availability variable                                                                                                                                                                                                                                                                                                                        | 3                   | 0         | 0           | S      |
| 17   | Single-test gaps                           | Unlock on an unknown connector (F_10), local list lost on a process restart (D_07), CSR repeat count (A_23), expired root accepted (M_07), plug lock failure (G_20), `txUpdatedMeterValues` unreachable from SetVariables (J_09)                                                                                                                                                                         | 6                   | 3         | 1           | S      |

Planned station work, not counted as covered: #673 TriggerMessage targets (F_13 to F_19; it waits on a change to
the open-ocpp-tck case that asserts `NotImplemented`), #685 base report bases (B_12, B_14). #676 registers
`TxStartPoint` and `TxStopPoint` read-only, which does not give the start and stop semantics of rank 6, and #686
adds reason codes without changing a rating.

### Scenario constructs

Nodes that do not exist. Each has a control-plane method today or an observable alternative, so each is a small change
to expose it as a node. "Test cases" counts the cases whose manual step needs it; the right-hand column says how many
of those the station can already complete.

| Construct                                                            | Missing today                                                                                                                            | Test cases                                                            | Station already complete | Closes it                                |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------ | ---------------------------------------- |
| `evReady` node                                                       | EV suspends and resumes only through `ev_ready` (control plane)                                                                          | 10 (E_17, E_20, E_22, E_24 to E_27, E_37, E_38, E_54)                 | 0                        | wrap `ev_ready`                          |
| `presentToken` node                                                  | Presenting an idToken to a running transaction or without starting one; the `transaction` node's `tagId` is for start only               | 8 (C_14, C_39 to C_41, C_47 to C_49, E_45)                            | 0                        | new node on the local authorization path |
| ISO 15118 EV in `connectorPlug`, session start and stop, renegotiate | A plug-in that opens a PnC or high-level-communication session; EV-side stop; renegotiation. `get_15118_ev_certificate` is control plane | 17 (C_50 to C_55, K_53, K_54, K_56 to K_58, E_46, N_63, M_26 to M_29) | 1 (M_27)                 | needs an EV model first (rank 11)        |
| `powerCycle` node                                                    | Reboot or power cycle that reconnects; only `reset` and `power.loss` / `power.restore` exist                                             | 5 (A_01, B_02, B_03, N_53, O_20)                                      | 1 (B_03)                 | wrap `power.loss` / `power.restore`      |
| Network offline and online node                                      | Taking the station offline; `connectionTrigger` only observes                                                                            | 2 (N_22, N_23)                                                        | 2                        | wrap the network simulation              |
| `parkingBay` node                                                    | Drive-in and drive-out                                                                                                                   | 2 (E_12, E_19)                                                        | 0                        | needs the start and stop points (rank 6) |
| Single-purpose                                                       | Plug lock failure (G_20), external limit (K_52), seed customer data (N_62)                                                               | 3                                                                     | 0                        | per case                                 |

Totals: 47 test cases need a missing node (25 with no method at all, 22 with a control-plane method only); the station
is already complete for 4 of them.

## Implementation order

1. **Land the open work.** #676, #685 and #686 (device model), #673 (TriggerMessage), then the timeout edges and
   parallel and join branches. 9 test cases and the base for rank 9.
2. **The 2.x boot security event (rank 1) and `BasicAuthPassword` (rank 2).** Both are small, both mandatory in Core,
   and the first is a prerequisite for every test that reboots the station.
3. **The four small nodes**: `powerCycle`, `evReady`, network offline and online, `presentToken` (the last needs
   station work, rank 10). They cost little because the methods exist, and they remove the script column from ranks 7,
   10 and 12.
4. **Smart charging fidelity (rank 4).** The largest block of mandatory cases that the station nearly passes.
5. **Network profiles and TLS trust (rank 3).** Large, mandatory, and unlocks the Core security tests.
6. **Display messages (rank 5).** The largest single count, conditional; a message store is self-contained.
7. **Transaction start and stop points and the EV-side semantics (ranks 6 and 7), with the `parkingBay` node.**
   Touches the transaction state machine, so do it as one change with the `evReady` node already in place.
8. **Firmware realism (rank 8), reset semantics (rank 12), report and device-model completeness (rank 9), token during
   transaction (rank 10).**
9. **ISO 15118 and Plug and Charge (rank 11).** Largest effort; every case needs an EV model.
10. **Make it runnable end to end:** generate one 2.0.1 scenario per covered test case (waits and assertions, from the
    test list) so that "covered" means a template exists, as `cert16-*` does for 1.6.

Covered count if each step lands completely (an upper bound: it assumes every case of the gap passes once the gap
and its node are closed, and counts the cases that also need the boot event as waiting for step 2):

| After step                                       | Covered | Share |
| ------------------------------------------------ | ------- | ----- |
| Today                                            | 228     | 54%   |
| 1 Open work                                      | 237     | 56%   |
| 2 Boot event, `BasicAuthPassword`                | 244     | 58%   |
| 3 Small nodes                                    | 246     | 58%   |
| 4 Smart charging                                 | 263     | 62%   |
| 5 Network profiles                               | 279     | 66%   |
| 6 Display messages                               | 306     | 72%   |
| 7 Start and stop points, EV side                 | 328     | 77%   |
| 8 Firmware, reset, reports, token in transaction | 382     | 90%   |
| 9 ISO 15118                                      | 398     | 94%   |

The remaining 26 are the customer-information, cost, meter-value, reservation and single-test gaps (ranks 13 to 17).

## Confidence

- **Sample check.** 63 of 65 sampled ratings came back (two were not reported): 61 agree on the station rating, 63 on
  the script rating. Two station ratings were wrong and were corrected before the numbers above: A_14 was `partial`
  and is `impl` (the chain and validity checks of #587 landed after the rating), and G_21 was `impl` and is
  `partial` (the missing boot security event). J_09 was changed to `partial` after the same check found that
  `txUpdatedMeterValues` cannot be turned on by SetVariables. Three notes were stale without changing a rating
  (J_01, N_29, L_01).
- **Direction of the error.** No systematic over-generosity was found. The soft spot is `impl` for tests that need a
  non-default setting that the Test System cannot flip through SetVariables (J_09, H_16, B_06 need
  `txUpdatedMeterValues`, `NonEvseSpecific` and `OfflineThreshold` set first). The check found 3 in 63; extrapolated,
  expect roughly 10 of the 228 to need an operator setting.
- **Script rating `now`** is the most optimistic column: it assumes that waits and assertions on the wire transcript
  are enough for the test. The check read the test steps, it did not run a scenario against an OCA tool. Treat `now`
  as "expressible", and expect a few cases to need a small extension (an assertion, a payload match).
- **Precision.** Counts are cases, not effort or importance; a rank-5 gap with 27 cases is one store, a rank-11 gap with
  16 is a protocol stack. The ranks 14 to 17 are rough.
- **Not verified:** 2.1 changes to the shared cases, the 154 new 2.1 cases, and the OCA 1.6 test cases.

## Appendix: where the test cases are

### By gap

- **2.x boot security event** (5): B_01, C_32, G_18, G_21, N_53
- **BasicAuthPassword variable** (4): A_01, A_09, A_10, N_48
- **Network profiles, TLS trust and root handling** (16): A_04, A_05, A_06, A_07, A_19, A_20, A_21, B_45, B_46, B_47, B_49, B_50, B_57, M_09, M_30, M_31
- **Smart charging fidelity** (18): K_01, K_03, K_09, K_10, K_12, K_13, K_15, K_21, K_22, K_23, K_28, K_37, K_39, K_40, K_41, K_42, K_52, K_60
- **Display message store** (27): O_01, O_02, O_04, O_06, O_07, O_08, O_09, O_10, O_12, O_13, O_14, O_17, O_18, O_19, O_20, O_22, O_24, O_27, O_28, O_30, O_32, O_34, O_35, O_36, O_37, O_38, O_39
- **Transaction start and stop points** (12): E_01, E_02, E_07, E_08, E_09, E_11, E_12, E_14, E_19, E_22, E_27, E_35
- **EV-side disconnect and suspend semantics** (10): E_03, E_17, E_20, E_24, E_25, E_26, E_37, E_38, E_54, F_01
- **Firmware update realism** (15): L_01, L_02, L_03, L_05, L_06, L_07, L_08, L_10, L_11, L_12, L_13, L_14, L_15, L_16, L_18
- **Device model and report completeness** (15): B_11, B_13, B_15, B_16, B_18, B_19, B_34, B_37, B_53, B_54, B_55, N_04, N_07, N_37, N_38
- **Token presented during a transaction** (16): C_04, C_14, C_39, C_40, C_41, C_42, C_43, C_44, C_45, C_47, C_48, C_49, C_57, C_58, E_45, E_52
- **ISO 15118 / Plug and Charge** (16): C_50, C_51, C_52, C_53, C_54, C_55, E_46, K_53, K_54, K_56, K_57, K_58, M_26, M_28, M_29, N_63
- **Reset and reboot semantics** (8): B_02, B_21, B_22, B_24, B_28, B_29, B_30, B_41
- **Customer information and log retrieval** (9): N_12, N_21, N_26, N_28, N_29, N_32, N_33, N_34, N_62
- **Cost display and tariff** (4): C_127, I_01, I_02, I_07
- **Signed and idle-time meter values** (3): J_04, J_06, J_08
- **Reservation capabilities** (3): H_15, H_16, H_22
- **Single-test gaps** (6): A_23, D_07, F_10, G_20, J_09, M_07
- **TriggerMessage targets, planned #673** (7): F_13, F_14, F_15, F_16, F_17, F_18, F_19
- **Base report content, planned #685** (2): B_12, B_14

### By block

Test case ids drop the `TC_` prefix and the `_CS` suffix. Ratings are station / script.

<details>
<summary>A Security: 5 of 16 covered</summary>

Covered: A_11, A_12, A_14, A_15, A_22.

Not covered or planned (station / script rating, gap):

- A_01 Basic auth header on (re)connect: partial / now-cp. BasicAuthPassword variable.
- A_04 TLS with valid CSMS server cert: partial / behavior. Network profiles, TLS trust and root handling.
- A_05 Drop connection on invalid server cert: partial / behavior. Network profiles, TLS trust and root handling.
- A_06 Refuse TLS below 1.2: partial / behavior. Network profiles, TLS trust and root handling.
- A_07 Mutual TLS with client certificate: partial / behavior. Network profiles, TLS trust and root handling.
- A_09 Accept new BasicAuthPassword: missing / now. BasicAuthPassword variable.
- A_10 Reject too-short BasicAuthPassword: missing / now. BasicAuthPassword variable.
- A_23 Resend CSR when no CertificateSigned: partial / now. Single-test gaps.
- A_19 Upgrade security profile via network profile: missing / now. Network profiles, TLS trust and root handling.
- A_20 Refuse upgrade without CSMS root: missing / now. Network profiles, TLS trust and root handling.
- A_21 Refuse profile 3 without CS cert: missing / now. Network profiles, TLS trust and root handling.

</details>

<details>
<summary>B Provisioning: 20 of 48 covered</summary>

Covered: B_03, B_06, B_07, B_09, B_10, B_17, B_20, B_23, B_25, B_26, B_27, B_32, B_33, B_35, B_36, B_39, B_43, B_51, B_52, B_56.

Not covered or planned (station / script rating, gap):

- B_01 Boot accepted, all connectors reported: partial / now. 2.x boot security event.
- B_02 Boot Pending, CSMS configures then accepts: partial / now-cp. Reset and reboot semantics.
- B_30 CALL while boot Rejected gets SecurityError: missing / now. Reset and reboot semantics.
- B_34 GetVariables unsupported attribute type: partial / now. Device model and report completeness.
- B_37 SetVariables unsupported attribute type: partial / now. Device model and report completeness.
- B_11 SetVariables badly formatted values rejected: partial / now. Device model and report completeness.
- B_12 Base report ConfigurationInventory: partial / now. planned #685.
- B_13 Base report FullInventory: partial / now. Device model and report completeness.
- B_14 Base report SummaryInventory: partial / now. planned #685.
- B_15 Unsupported base report answers NotSupported: missing / behavior. Device model and report completeness.
- B_16 Custom report by criteria Enabled: partial / now. Device model and report completeness.
- B_18 Custom report criteria plus variable: partial / now. Device model and report completeness.
- B_19 Custom report unknown criteria NotSupported: missing / behavior. Device model and report completeness.
- B_21 Reset OnIdle during transaction: partial / now. Reset and reboot semantics.
- B_22 Reset Immediate during transaction: partial / now. Reset and reboot semantics.
- B_24 Reserved survives station reset: missing / now. Reset and reboot semantics.
- B_41 Reset OnIdle with two transactions: partial / now. Reset and reboot semantics.
- B_28 EVSE reset unsupported answers Rejected: missing / behavior. Reset and reboot semantics.
- B_29 EVSE reset unsupported during transaction: missing / behavior. Reset and reboot semantics.
- B_45 Migrate to new profile slot: missing / now. Network profiles, TLS trust and root handling.
- B_46 Profile fallback after failed attempts: missing / now. Network profiles, TLS trust and root handling.
- B_47 Fallback after new CSMS root fails: missing / behavior. Network profiles, TLS trust and root handling.
- B_49 Fallback then back-off retry: missing / now. Network profiles, TLS trust and root handling.
- B_50 Migrate to new CSMS with new root: missing / behavior. Network profiles, TLS trust and root handling.
- B_53 FullInventory has all mandatory DM vars: partial / behavior. Device model and report completeness.
- B_54 Custom report all instances of variable: missing / now. Device model and report completeness.
- B_55 Custom report one variable instance: missing / now. Device model and report completeness.
- B_57 Reconnect back-off after connection loss: partial / now. Network profiles, TLS trust and root handling.

</details>

<details>
<summary>C Authorization: 33 of 55 covered</summary>

Covered: C_02, C_05, C_06, C_07, C_08, C_09, C_10, C_11, C_12, C_13, C_15, C_16, C_17, C_18, C_21, C_22, C_23, C_24, C_25, C_26, C_27, C_28, C_29, C_30, C_31, C_33, C_34, C_36, C_37, C_38, C_46, C_56, C_100.

Not covered or planned (station / script rating, gap):

- C_04 Different token during tx does not stop it: partial / now. Token presented during a transaction.
- C_14 Master pass token from cache stops tx: missing / new presentToken node. Token presented during a transaction.
- C_57 Cache DisablePostAuthorize: no Authorize: missing / now. Token presented during a transaction.
- C_58 List DisablePostAuthorize: no Authorize: missing / now. Token presented during a transaction.
- C_32 Cache survives reboot: partial / now. 2.x boot security event.
- C_39 Second token same GroupId stops tx: partial / new presentToken node. Token presented during a transaction.
- C_40 GroupId stop with Local Auth List: partial / new presentToken node. Token presented during a transaction.
- C_41 GroupId stop with Authorization Cache: partial / new presentToken node. Token presented during a transaction.
- C_42 Invalid token of group does not stop: partial / now. Token presented during a transaction.
- C_43 Invalid listed group token does not stop: partial / now. Token presented during a transaction.
- C_44 Invalid cached group token does not stop: partial / now. Token presented during a transaction.
- C_45 Master pass token cannot start tx: missing / now. Token presented during a transaction.
- C_47 Master pass with UI stops all txs: missing / new presentToken node. Token presented during a transaction.
- C_48 Master pass with UI stops one EVSE: missing / new presentToken node. Token presented during a transaction.
- C_49 Master pass without UI stops all: missing / new presentToken node. Token presented during a transaction.
- C_50 PnC local contract validation Accepted: missing / new pncPlugIn node. ISO 15118 / Plug and Charge.
- C_51 PnC local contract validation Rejected: missing / new pncPlugIn node. ISO 15118 / Plug and Charge.
- C_52 PnC central contract validation Accepted: missing / new pncPlugIn node. ISO 15118 / Plug and Charge.
- C_53 PnC central contract validation fails: missing / new pncPlugIn node. ISO 15118 / Plug and Charge.
- C_54 PnC offline, ContractValidationOffline true: missing / new pncPlugIn node. ISO 15118 / Plug and Charge.
- C_55 PnC offline, ContractValidationOffline false: missing / new pncPlugIn node. ISO 15118 / Plug and Charge.
- C_127 Ad hoc QR web payment: missing / behavior. Cost display and tariff.

</details>

<details>
<summary>D Local authorization list management: 8 of 9 covered</summary>

Covered: D_01, D_02, D_03, D_04, D_05, D_06, D_08, D_10.

Not covered or planned (station / script rating, gap):

- D_07 Local list survives reboot: partial / now. Single-test gaps.

</details>

<details>
<summary>E Transactions: 23 of 47 covered</summary>

Covered: E_04, E_05, E_06, E_10, E_13, E_15, E_16, E_21, E_28, E_29, E_30, E_31, E_32, E_33, E_34, E_39, E_40, E_41, E_42, E_43, E_44, E_50, E_51.

Not covered or planned (station / script rating, gap):

- E_01 Tx starts when power path closes: missing / now. Transaction start and stop points.
- E_02 Tx starts when energy flows: missing / now. Transaction start and stop points.
- E_09 Tx starts on cable connect: missing / now. Transaction start and stop points.
- E_11 Tx starts on signed meter data: missing / now. Transaction start and stop points.
- E_12 Tx starts on parking bay occupancy: missing / new parkingBay node. Transaction start and stop points.
- E_17 EV-side unplug ends authorized tx: partial / now-cp. EV-side disconnect and suspend semantics.
- E_03 Local start, cable first: partial / now. EV-side disconnect and suspend semantics.
- E_38 EV not ready at start: partial / now-cp. EV-side disconnect and suspend semantics.
- E_52 No Authorize when remote auth disabled: missing / now. Token presented during a transaction.
- E_07 Local stop, stop point PowerPathClosed: partial / now. Transaction start and stop points.
- E_35 Remote stop, stop point PowerPathClosed: partial / now. Transaction start and stop points.
- E_37 EV unplug ends tx at PowerPathClosed: partial / now-cp. EV-side disconnect and suspend semantics.
- E_08 Token stop, stop point EnergyTransfer: partial / now. Transaction start and stop points.
- E_22 EV suspend ends tx at EnergyTransfer: missing / now-cp. Transaction start and stop points.
- E_14 Cable removal ends tx at EVConnected: missing / now. Transaction start and stop points.
- E_20 EV-side unplug ends tx, IEC 61851: partial / now-cp. EV-side disconnect and suspend semantics.
- E_54 EV-side unplug ends tx, HLC EV: partial / now-cp. EV-side disconnect and suspend semantics.
- E_19 Tx ends when EV leaves bay: missing / new parkingBay node. Transaction start and stop points.
- E_24 EV unplug deauthorizes, unlock true: partial / now-cp. EV-side disconnect and suspend semantics.
- E_25 EV unplug deauthorizes, unlock false: partial / now-cp. EV-side disconnect and suspend semantics.
- E_26 EV unplug suspends, replug resumes: partial / now-cp. EV-side disconnect and suspend semantics.
- E_27 EV unplug suspends, then cable timeout: missing / now-cp. Transaction start and stop points.
- E_45 Offline stop by token of same group: partial / new presentToken node. Token presented during a transaction.
- E_46 15118 EV ends charging session: missing / new iso15118 sessionStop node. ISO 15118 / Plug and Charge.

</details>

<details>
<summary>F Remote control: 15 of 24 covered</summary>

Covered: F_02, F_03, F_04, F_05, F_06, F_07, F_08, F_09, F_11, F_12, F_20, F_23, F_24, F_26, F_27.

Not covered or planned (station / script rating, gap):

- F_01 Remote start after cable plug: partial / now. EV-side disconnect and suspend semantics.
- F_10 Unlock unknown connector id: partial / now. Single-test gaps.
- F_13 Trigger TransactionEvent, one EVSE: missing / now. planned #673.
- F_14 Trigger TransactionEvent, all EVSE: missing / now. planned #673.
- F_15 Trigger LogStatus while idle: missing / now. planned #673.
- F_16 Trigger LogStatus while uploading: missing / now. planned #673.
- F_17 Trigger FirmwareStatus with evse: missing / now. planned #673.
- F_18 Trigger FirmwareStatus while idle: missing / now. planned #673.
- F_19 Trigger FirmwareStatus while downloading: missing / now. planned #673.

</details>

<details>
<summary>G Availability: 18 of 21 covered</summary>

Covered: G_01, G_02, G_03, G_04, G_05, G_06, G_07, G_08, G_09, G_10, G_11, G_12, G_13, G_14, G_15, G_16, G_17, G_19.

Not covered or planned (station / script rating, gap):

- G_18 EVSE unavailability survives reboot: partial / now. 2.x boot security event.
- G_20 Lock failure reported, no charging: missing / new lockFailure fault input. Single-test gaps.
- G_21 Station unavailability survives reboot: partial / now. 2.x boot security event.

</details>

<details>
<summary>H Reservation: 18 of 21 covered</summary>

Covered: H_01, H_02, H_03, H_04, H_06, H_07, H_08, H_09, H_10, H_12, H_13, H_14, H_17, H_18, H_19, H_21, H_23, H_24.

Not covered or planned (station / script rating, gap):

- H_15 Reserve by connectorType: partial / now. Reservation capabilities.
- H_16 connectorType reserve when all reserved: Occupied: partial / now. Reservation capabilities.
- H_22 Reservations disabled: Rejected: missing / behavior. Reservation capabilities.

</details>

<details>
<summary>I Tariff and cost: 0 of 3 covered</summary>

Covered: none.

Not covered or planned (station / script rating, gap):

- I_01 Running cost via CostUpdated: partial / now. Cost display and tariff.
- I_02 Final total cost after charging: partial / now. Cost display and tariff.
- I_07 Running cost via TransactionEventResponse: partial / now. Cost display and tariff.

</details>

<details>
<summary>J Meter values: 6 of 10 covered</summary>

Covered: J_01, J_02, J_03, J_07, J_10, J_11.

Not covered or planned (station / script rating, gap):

- J_04 Signed clock-aligned Ended values: missing / now. Signed and idle-time meter values.
- J_06 Clock values only while idle: partial / now. Signed and idle-time meter values.
- J_08 Begin values once EVSE known: partial / now. Signed and idle-time meter values.
- J_09 Periodic values in Updated: partial / now. Single-test gaps.

</details>

<details>
<summary>K Smart charging: 21 of 44 covered</summary>

Covered: K_02, K_04, K_05, K_06, K_07, K_08, K_11, K_14, K_16, K_19, K_24, K_29, K_30, K_31, K_32, K_33, K_34, K_35, K_36, K_38, K_47.

Not covered or planned (station / script rating, gap):

- K_01 TxDefaultProfile on one EVSE, reported back: partial / now. Smart charging fidelity.
- K_03 ChargingStationMaxProfile on EVSE 0: partial / now. Smart charging fidelity.
- K_09 Clear TxDefault mid-tx, composite reverts: partial / now. Smart charging fidelity.
- K_10 TxDefaultProfile on EVSE 0: partial / now. Smart charging fidelity.
- K_12 Unsupported rate unit: Rejected: missing / behavior. Smart charging fidelity.
- K_13 Profile survives reboot: partial / now. Smart charging fidelity.
- K_15 Smart charging unsupported: NotSupported: missing / behavior. Smart charging fidelity.
- K_21 validFrom delays profile activation: partial / now. Smart charging fidelity.
- K_22 validTo ends profile: partial / now. Smart charging fidelity.
- K_23 startSchedule in future delays limit: partial / now. Smart charging fidelity.
- K_28 TxDefaultProfile set during transaction: partial / now. Smart charging fidelity.
- K_60 TxProfile for running transaction: partial / now. Smart charging fidelity.
- K_37 RequestStart with TxProfile installs it: partial / now. Smart charging fidelity.
- K_39 Composite with no profiles: partial / now. Smart charging fidelity.
- K_40 Composite of stacked TxDefault profiles: partial / now. Smart charging fidelity.
- K_41 Composite combining Max/TxDefault/TxProfile: partial / now. Smart charging fidelity.
- K_42 Composite unsupported rate unit: Rejected: missing / behavior. Smart charging fidelity.
- K_52 Report ExternalConstraints profile: missing / new externalLimit node. Smart charging fidelity.
- K_53 ISO 15118 load leveling success: missing / new connectorPlug ISO 15118 EV option. ISO 15118 / Plug and Charge.
- K_54 ISO 15118 needs rejected, still charges: missing / new connectorPlug ISO 15118 EV option. ISO 15118 / Plug and Charge.
- K_56 ISO 15118 load leveling while offline: missing / new connectorPlug ISO 15118 EV option. ISO 15118 / Plug and Charge.
- K_57 EV-initiated schedule renegotiation: missing / new evRenegotiate node. ISO 15118 / Plug and Charge.
- K_58 CSMS-initiated schedule renegotiation: missing / new connectorPlug ISO 15118 EV option. ISO 15118 / Plug and Charge.

</details>

<details>
<summary>L Firmware management: 0 of 15 covered</summary>

Covered: none.

Not covered or planned (station / script rating, gap):

- L_01 Signed firmware update, happy path: partial / now. Firmware update realism.
- L_02 Firmware install scheduled later: partial / now. Firmware update realism.
- L_03 Firmware download scheduled later: partial / now. Firmware update realism.
- L_05 Reject untrusted firmware signing cert: partial / now. Firmware update realism.
- L_06 Report invalid firmware signature: partial / now. Firmware update realism.
- L_07 Report firmware download failure: partial / now. Firmware update realism.
- L_08 Report install verification failure: partial / now. Firmware update realism.
- L_10 Replace running update (AcceptedCanceled): partial / now. Firmware update realism.
- L_11 Refuse update when cannot cancel: missing / now. Firmware update realism.
- L_12 Defer download during tx, new tx allowed: partial / now. Firmware update realism.
- L_13 Defer download during tx, block new tx: partial / now. Firmware update realism.
- L_14 Defer install during tx, new tx allowed: partial / now. Firmware update realism.
- L_15 Defer install during tx, block new tx: partial / now. Firmware update realism.
- L_16 Update firmware during ongoing tx: partial / now. Firmware update realism.
- L_18 Reject unsigned firmware request: missing / now. Firmware update realism.

</details>

<details>
<summary>M ISO 15118 certificate management: 18 of 25 covered</summary>

Covered: M_01, M_02, M_03, M_04, M_12, M_13, M_14, M_15, M_16, M_17, M_18, M_19, M_20, M_22, M_23, M_24, M_25, M_27.

Not covered or planned (station / script rating, gap):

- M_07 Reject expired root certificate: partial / now. Single-test gaps.
- M_09 AdditionalRootCertificateCheck rejects root: missing / now. Network profiles, TLS trust and root handling.
- M_30 Reconnect with new CSMS root: missing / behavior. Network profiles, TLS trust and root handling.
- M_31 Fall back to old CSMS root: missing / behavior. Network profiles, TLS trust and root handling.
- M_26 Relay EV cert install, success: partial / now-cp. ISO 15118 / Plug and Charge.
- M_28 Relay EV cert update, success: partial / now-cp. ISO 15118 / Plug and Charge.
- M_29 Relay EV cert update, failed: partial / now-cp. ISO 15118 / Plug and Charge.

</details>

<details>
<summary>N Diagnostics: 36 of 52 covered</summary>

Covered: N_01, N_02, N_03, N_05, N_06, N_08, N_09, N_10, N_11, N_13, N_15, N_16, N_17, N_18, N_19, N_20, N_22, N_23, N_24, N_25, N_27, N_30, N_31, N_35, N_36, N_39, N_40, N_41, N_43, N_44, N_45, N_47, N_51, N_52, N_56, N_61.

Not covered or planned (station / script rating, gap):

- N_04 Report request with invalid criterion: partial / now. Device model and report completeness.
- N_07 Monitoring base with invalid value: partial / now. Device model and report completeness.
- N_12 Negative Delta value rejected: partial / now. Customer information and log retrieval.
- N_21 Hardwired notification is reported: missing / now. Customer information and log retrieval.
- N_26 Diagnostics log upload fails with retries: partial / behavior. Customer information and log retrieval.
- N_28 Customer info report without data: partial / now. Customer information and log retrieval.
- N_29 Customer info when station can't process: partial / behavior. Customer information and log retrieval.
- N_32 Clear without report: partial / now. Customer information and log retrieval.
- N_62 Clear/report by customerIdentifier: partial / now-cp. Customer information and log retrieval.
- N_63 Clear/report by contract certificate: missing / new iso15118 PnC session node. ISO 15118 / Plug and Charge.
- N_33 Clear customer info when can't process: partial / behavior. Customer information and log retrieval.
- N_34 GetLog rejected with no logs: missing / behavior. Customer information and log retrieval.
- N_37 Monitor on unknown variable: partial / now. Device model and report completeness.
- N_38 Unsupported monitor type rejected: partial / now. Device model and report completeness.
- N_48 Write-only variable event has empty value: missing / now. BasicAuthPassword variable.
- N_53 Monitors survive reboot: partial / now-cp. 2.x boot security event.

</details>

<details>
<summary>O Display message: 4 of 31 covered</summary>

Covered: O_03, O_05, O_11, O_33.

Not covered or planned (station / script rating, gap):

- O_01 Set display message accepted: missing / now. Display message store.
- O_02 Get all display messages: missing / now. Display message store.
- O_04 Clear a display message: missing / now. Display message store.
- O_06 Transaction-bound display message: missing / now. Display message store.
- O_07 Get display message by id: missing / now. Display message store.
- O_08 Get display messages by priority: missing / now. Display message store.
- O_09 Get display messages by state: missing / now. Display message store.
- O_10 Message for unknown transaction: missing / now. Display message store.
- O_12 Replace display message by id: missing / now. Display message store.
- O_13 Message shown from startDateTime: missing / now. Display message store.
- O_14 Message removed after endDateTime: missing / now. Display message store.
- O_17 Unsupported priority rejected: missing / now. Display message store.
- O_18 Unsupported state rejected: missing / now. Display message store.
- O_19 Unsupported message format rejected: missing / now. Display message store.
- O_20 Display messages survive reboot: missing / now-cp. Display message store.
- O_22 Two InFront messages: missing / now. Display message store.
- O_24 Second AlwaysFront replaces first: missing / now. Display message store.
- O_27 Transaction message with start time: missing / now. Display message store.
- O_28 Transaction message with end time: missing / now. Display message store.
- O_30 Transaction message, two InFront: missing / now. Display message store.
- O_32 Transaction message, second AlwaysFront: missing / now. Display message store.
- O_34 Get by id, state mismatch: missing / now. Display message store.
- O_35 Get by id, priority mismatch: missing / now. Display message store.
- O_36 Message shown only while Charging: missing / now. Display message store.
- O_37 Message shown only while Idle: missing / now. Display message store.
- O_38 Message shown only while Unavailable: missing / now. Display message store.
- O_39 Message shown only while Faulted: missing / now. Display message store.

</details>

<details>
<summary>P Data transfer: 3 of 3 covered</summary>

Covered: P_01, P_03, P_04.

</details>
