---
title: Smart charging
type: concept
summary: How the station stores, selects and evaluates charging profiles (SetChargingProfile, ClearChargingProfile, GetCompositeSchedule) on OCPP 1.6 and 2.x.
sources:
  - packages/core/src/cp/infrastructure/transport/v201/smartChargingV201.ts
  - "issue #706"
  - "issue #735"
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
