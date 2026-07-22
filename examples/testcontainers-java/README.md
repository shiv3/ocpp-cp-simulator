# Java + Testcontainers harness (prototype)

A minimal example of driving `ocpp-cp-simulator` as a **turnkey charge-point
stub** from a JVM test suite — the "WireMock of OCPP" idea from
[issue #111](https://github.com/shiv3/ocpp-cp-simulator/issues/111).

A CSMS project can spin up the simulator container, create a charge point
pointed at its CSMS-under-test, run a built-in certification scenario
([#110](https://github.com/shiv3/ocpp-cp-simulator/issues/110)), and assert the
machine-readable verdict ([#179](https://github.com/shiv3/ocpp-cp-simulator/issues/179))
— without reimplementing the charge-point side per project.

## What it does

`CertificationScenarioIT` drives the daemon entirely over the documented
[Socket.IO control plane](../../docs/reference/server.md):

1. start the simulator image with Testcontainers and wait on `GET /v1/healthz`;
2. connect a Socket.IO client and `cp.create` a charge point;
3. `events.subscribe` to that CP's event room;
4. `load_scenario` (an inline scenario here) and `run_scenario`;
5. poll `scenario_report` and assert `verdict == "PASS"`.

The example is **self-contained**: the CP's `wsUrl` points at a dead port, so it
never connects to a CSMS and an `ocpp_absent` assertion for `Reset` is
deterministically satisfied. To exercise a real certification flow, point
`cp.create`'s `wsUrl` at your CSMS-under-test and `run_scenario` a built-in
`TC_xxx` template (`list_scenario_templates` / `run_scenario_template`).

## Prerequisites

- JDK 17+
- Maven 3.9+
- A Docker daemon (Testcontainers needs it)
- The simulator image available locally:

  ```bash
  # from the repository root
  docker build -t ocpp-cp-simulator:local .
  ```

## Run

```bash
# from examples/testcontainers-java/
mvn verify
```

Point at a published/tagged image instead of a local build:

```bash
OCPP_SIM_IMAGE=ghcr.io/shiv3/ocpp-cp-simulator:latest mvn verify
```

## Status

This is a **prototype** authored against the documented control-plane contract;
it is not wired into the simulator's own CI (which is TypeScript). The identical
RPC sequence is covered by a TypeScript integration test that **does** run in CI
and drives the real socket server —
`src/cli/server/__tests__/harnessScenarioVerdict.bun.test.ts` — so the flow this
example demonstrates is guarded there. Contributions to grow this into a proper
Testcontainers module + thin client are welcome.
