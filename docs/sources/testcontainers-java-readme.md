---
title: "Source: examples/testcontainers-java/README.md"
type: source
summary: Prototype JVM harness (Maven + Testcontainers) that starts the simulator image, drives it over the Socket.IO control plane, runs a scenario and asserts the machine-readable verdict — the "WireMock of OCPP" idea.
sources:
  - examples/testcontainers-java/README.md
  - examples/testcontainers-java/ (CertificationScenarioIT)
  - "issues #111, #110, #179"
related:
  - ../concepts/control-plane.md
  - ../entities/docker-image.md
  - ../concepts/scenario-format.md
  - ../analyses/testing-strategy.md
updated: 2026-09-03
---

# Source: `examples/testcontainers-java/README.md`

**Idea (issue #111).** A CSMS project can spin up the simulator container as
a turnkey charge-point stub, create a charge point pointed at its
CSMS-under-test, run a built-in certification scenario (#110) and assert the
machine-readable verdict (#179) — without reimplementing the CP side per
project.

**Flow of `CertificationScenarioIT`** — entirely over the documented
[Socket.IO control plane](../concepts/control-plane.md):

1. start the simulator image with Testcontainers and wait on `GET /v1/healthz`;
2. connect a Socket.IO client and `cp.create` a charge point;
3. `events.subscribe` to that CP's event room;
4. `load_scenario` (inline) and `run_scenario`;
5. poll `scenario_report` and assert `verdict == "PASS"`.

The example is self-contained: the CP's `wsUrl` points at a dead port, so an
`ocpp_absent` assertion for `Reset` is deterministically satisfied. For a real
flow, point `wsUrl` at the CSMS-under-test and `run_scenario_template` a
`TC_xxx` template.

**Run.** JDK 17+, Maven 3.9+, a Docker daemon, and the image
(`docker build -t ocpp-cp-simulator:local .` or
`OCPP_SIM_IMAGE=ghcr.io/shiv3/ocpp-cp-simulator:latest`); then `mvn verify`
from `examples/testcontainers-java/`.

**Status.** Prototype, not wired into the simulator's own CI. The identical
RPC sequence is guarded in CI by
`src/cli/server/__tests__/harnessScenarioVerdict.bun.test.ts`.
