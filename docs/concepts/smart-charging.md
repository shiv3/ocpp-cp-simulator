---
title: Smart charging
type: concept
summary: How the station stores, selects and evaluates charging profiles (SetChargingProfile, ClearChargingProfile, GetCompositeSchedule) on OCPP 1.6 and 2.x.
sources:
  - packages/core/src/cp/infrastructure/transport/handlers/call/SmartChargingHandlers.ts
  - "issue #737"
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

## GetCompositeSchedule answer (1.6)

The 1.6 `GetCompositeSchedule.conf` carries `scheduleStart` (the instant the
composite starts, now) and a `chargingSchedule` with `duration`,
`chargingRateUnit` and the periods. It does **not** carry
`chargingSchedule.startSchedule`: the 1.6 errata 3.57 says the field "must be
omitted" when a ChargingSchedule is part of a `GetCompositeSchedule.conf`
(§6.22, §7.13). The 2.x answer is a different message and is not affected.
