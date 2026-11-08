---
title: Smart charging
type: concept
summary: How the station stores, selects and evaluates charging profiles (SetChargingProfile, ClearChargingProfile, GetCompositeSchedule) on OCPP 1.6 and 2.x.
sources:
  - packages/core/src/cp/infrastructure/transport/v201/smartChargingV201.ts
  - "issue #705"
related:
  - charging-sessions.md
  - charger-engine.md
  - ocpp-versions-and-transports.md
  - ../entities/default-behaviors.md
updated: 2026-11-08
---

# Smart charging

A CSMS limits a connector with charging profiles: `SetChargingProfile` installs
one, `ClearChargingProfile` removes some and `GetCompositeSchedule` asks what
limit results. See [Default behaviors](../entities/default-behaviors.md) for
the actions. This page records how requests are evaluated and answered.

## SetChargingProfile preconditions (2.0.1 and 2.1)

One handler serves both versions. A request the station refuses installs
nothing and answers `Rejected` with a `statusInfo.reasonCode`:

| Request                                                                                                                              | Answer                         | Clause          |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | --------------- |
| `TxProfile` on an EVSE with no running transaction                                                                                   | `Rejected`, `TxNotFound`       | K01.FR.09       |
| `TxProfile` whose `transactionId` is not the EVSE's running transaction (the `transactionId` the station sent in `TransactionEvent`) | `Rejected`, `TxNotFound`       | K01.FR.33       |
| `TxDefaultProfile` on EVSE 0 while a `TxDefaultProfile` with the same `stackLevel` and another `id` is installed on a specific EVSE  | `Rejected`, `DuplicateProfile` | K01.FR.52       |
| `TxDefaultProfile` on an EVSE while one with the same `stackLevel` and another `id` is installed on EVSE 0                           | `Rejected`, `DuplicateProfile` | K01.FR.53       |
| `TxProfile` on EVSE 0, `ChargingStationMaxProfile` on an EVSE, unknown purposes / kinds, unrepresentable schedules                   | `Rejected` (no reason code)    | existing checks |

A `TxProfile` that matches the running transaction is accepted, applies to that
transaction only and is removed when the transaction ends. A `TxProfile`
without `transactionId` binds to the running transaction (K01.FR.03 is an
obligation of the CSMS; the station does not reject the omission). The same
`id` replaces the installed profile (K01.FR.05); two specific EVSEs may reuse a
stack level.
