---
title: "Source: docs/examples/scenarios (demo-charging, all-cases)"
type: source
summary: The two example scenario files shipped in the repo and the Docker image — a realistic OCPP 1.6 lifecycle demo and a node-type coverage catalogue run cross-version by the e2e suite.
sources:
  - docs/examples/scenarios/demo-charging.json
  - docs/examples/scenarios/all-cases.json
  - Dockerfile (copies them to /app/docs/examples/scenarios)
related:
  - ../concepts/scenario-format.md
  - ../entities/scenario-templates.md
  - ../entities/docker-image.md
  - e2e-readme.md
updated: 2026-09-03
---

# Source: `docs/examples/scenarios/`

Both files are cpId-independent `ScenarioDefinition` documents in the
[scenario format](../concepts/scenario-format.md), meant for
`--scenario-template-file <path> --scenario-connector all` (they are cloned per
connector). They are validated against the JSON Schema by
`src/scenario/__tests__/scenarioSchema.conformance.test.ts` and baked into the
[Docker image](../entities/docker-image.md#image-details) at
`/app/docs/examples/scenarios/`.

## `demo-charging.json` — "Demo Charging (OCPP 1.6)"

OCPP 1.6 §4.9 lifecycle demo (8 nodes). Starts on connect, stays in
`Available` after boot until the CSMS sends `RemoteStartTransaction`; from
there the domain auto-drives Preparing → Charging → Finishing → Available.
Carries `evSettings` (Tesla Model 3, 75 kWh, 250 kW, SoC 20 → 80 %). Used by
the README quick start and by `src/utils/scenarioTemplates.ts` as the
reference shape for built-in templates.

## `all-cases.json` — node-type catalogue

A single coverage reference that exercises **every** scenario node type in one
flow (25 nodes). The engine is version-agnostic: run the same file under
`--ocpp-version OCPP-1.6J`, `OCPP-2.0.1` or `OCPP-2.1` and each node emits the
wire message appropriate to that version (2.1 output is identical to 2.0.1).
It is an **integration** scenario — three nodes block until a cooperating CSMS
acts: `reservationTrigger` (ReserveNow), `remoteStartTrigger`
(RemoteStartTransaction on 1.6 / RequestStartTransaction on 2.x) and
`remoteStopTrigger` (RemoteStopTransaction / RequestStopTransaction). Per-version
notes are on each node. Not a realistic single session. Driven cross-version by
`e2e/comprehensive.gocpp.e2e.ts` ([e2e suite](e2e-readme.md)).
