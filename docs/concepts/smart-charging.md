---
title: Smart charging
type: concept
summary: How the station stores, selects and evaluates charging profiles (SetChargingProfile, ClearChargingProfile, GetCompositeSchedule) on OCPP 1.6 and 2.x.
sources:
  - packages/core/src/cp/infrastructure/transport/handlers/call/SmartChargingHandlers.ts
  - packages/core/src/cp/domain/charge-point/ChargingProfileStore.ts
  - "issue #729"
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
`connectorId = 0`, in a station store. See [Default behaviors](../entities/default-behaviors.md)
for the actions. This page records how requests are matched and answered.

## ClearChargingProfile (1.6)

Matching follows 1.6 §5.5 and §6.13 with errata 3.25 and 3.26:

| Request                          | Removes                                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id` present                     | The profile with that id, in the station store or on any connector. `connectorId`, `chargingProfilePurpose` and `stackLevel` are ignored.                   |
| no `id`, some of the other three | Every profile matching all the given fields (logical AND). `connectorId` absent searches the station store and every connector, `0` the station store only. |
| no field at all                  | Every profile, station store and all connectors.                                                                                                            |

The answer is `Accepted` when at least one profile was removed and `Unknown`
(§7.21: "No Charging Profile(s) were found matching the request") when none
was. The 2.x `ClearChargingProfile` is a separate handler and is unchanged.
