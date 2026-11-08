---
title: Smart charging
type: concept
summary: How the station stores, selects and evaluates charging profiles (SetChargingProfile, ClearChargingProfile, GetCompositeSchedule) on OCPP 1.6 and 2.x — which anchor a schedule counts from, when a profile ends, and which one wins.
sources:
  - packages/core/src/cp/domain/connector/ChargingScheduleResolver.ts
  - packages/core/src/cp/domain/connector/Connector.ts
  - packages/core/src/cp/domain/charge-point/ChargingProfileStore.ts
  - packages/core/src/cp/infrastructure/transport/handlers/call/SmartChargingHandlers.ts
  - "issue #723"
  - packages/core/src/cp/infrastructure/transport/v201/smartChargingV201.ts
  - "issue #707"
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

## Validity window and schedule anchor (2.0.1 and 2.1)

`validFrom` / `validTo` (the validity window) and the schedule's
`startSchedule` (where the periods count from) are stored and reported as
separate fields, as sent: K01.FR.36 / K01.FR.37 make the profile valid when
`validFrom <= now < validTo`, and K01.FR.30 starts imposing a schedule at its
`startSchedule`. `GetChargingProfiles` reports back exactly what was set, and
leaves out a field that was not sent (a profile with only `startSchedule` has
no `validFrom`). The anchor table above applies to 2.x too: an Absolute or
Recurring schedule counts from `startSchedule`, else `validFrom`, else the
transaction start. The 2.x `duration` and `minChargingRate` of a schedule are
not stored yet.
