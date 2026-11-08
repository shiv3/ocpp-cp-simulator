---
title: Smart charging
type: concept
summary: How the station stores, selects and evaluates charging profiles (SetChargingProfile, ClearChargingProfile, GetCompositeSchedule) on OCPP 1.6 and 2.x — which anchor a schedule counts from, when a profile ends, and which one wins.
sources:
  - packages/core/src/cp/domain/connector/ChargingScheduleResolver.ts
  - packages/core/src/cp/domain/connector/Connector.ts
  - packages/core/src/cp/domain/charge-point/ChargingProfileStore.ts
  - packages/core/src/cp/infrastructure/transport/handlers/call/SmartChargingHandlers.ts
  - packages/core/src/cp/infrastructure/transport/v201/smartChargingV201.ts
  - "issue #705"
  - "issue #706"
  - "issue #735"
  - "issue #723"
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
limit results. The station keeps profiles per connector and, for
`connectorId = 0`, in a station store; the limit it applies is resolved from
them for every MeterValue sample (see [Default behaviors](../entities/default-behaviors.md)
for the actions). This page records how a stored profile is evaluated.

## Stored fields (OCPP 1.6)

`SetChargingProfile` keeps `chargingProfileId`, `stackLevel`, purpose, kind,
`recurrencyKind`, `validFrom` / `validTo` and, from the schedule,
`startSchedule`, `duration`, `minChargingRate`, the rate unit and the periods
(`ActiveChargingProfile`). They persist as the profile's JSON in
`charging_profiles`, so a restart restores them.

## Anchor and end of a schedule (1.6)

OCPP 1.6 §7.13 defines `startSchedule` as the starting point of an absolute
schedule; `validFrom` / `validTo` only bound when the profile may apply.

| Kind                       | `startPeriod` offsets count from                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `Relative`                 | The start of the transaction (`startSchedule` is ignored).                                   |
| `Absolute`                 | `startSchedule`; without it `validFrom`; without that the transaction start.                 |
| `Recurring` Daily / Weekly | `startSchedule`, else `validFrom`, else the transaction start, wrapping every 24 h / 7 days. |

- A schedule whose `startSchedule` is still in the future is not in effect yet.
- A schedule ends when its `duration` has elapsed, counted from the same
  anchor (per cycle for `Recurring`). Profile selection skips an ended profile,
  so the next lower `stackLevel` applies (errata 3.43), and no limit applies
  when none is left.
- A `Recurring` schedule never runs a period or a duration past its cycle:
  periods with `startPeriod` at or beyond 24 h (Daily) or 7 days (Weekly) are
  ignored and the duration is capped at the cycle (errata 3.44).
- `GetCompositeSchedule` uses the same anchor and end: the end of a schedule
  inside the window is a slice boundary. The composite is built from the
  profile selected at the anchor instant, so a profile that ends inside the
  window leaves its remaining slices uncapped instead of falling through to a
  lower stack level.

Selection itself is unchanged: on a connector a `TxProfile` outranks every
`TxDefaultProfile` (connector-own and station-wide compete by `stackLevel`), and
the station's `ChargePointMaxProfile` combines with the winner through `min`.

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

## GetChargingProfiles (2.0.1 and 2.1)

The answer is `Accepted` (or `NoProfiles`) and the profiles follow in
`ReportChargingProfiles` requests, one per EVSE. `evseId` scopes the search
(K09.FR.04-06):

| `evseId` in the request | Profiles reported                                                        |
| ----------------------- | ------------------------------------------------------------------------ |
| `n > 0`                 | Only those installed on EVSE `n` (station-level profiles are not added). |
| `0`                     | Only the station-level ones (`ChargingStationMaxProfile`, EVSE 0).       |
| absent                  | All of them: the station-level group first, then each EVSE.              |

Every report carries the request's `requestId` (K09.FR.01). When the profiles
span more than one report, every report but the last has `tbc: true`
(K09.FR.02); the last one omits `tbc`, and so does the only report of a
single-group answer.
