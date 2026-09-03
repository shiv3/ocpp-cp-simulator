---
title: Testing strategy
type: analysis
summary: Which test runner / harness covers what — Vitest for jsdom + unit, Bun test for runtime-bound code, gocpp e2e for multi-version wire output, steve-verify for certification templates, Testcontainers for the external control-plane contract — and how coverage is merged.
sources:
  - package.json (test scripts)
  - codecov.yml
  - e2e/README.md
  - scripts/steve-verify/README.md
  - examples/testcontainers-java/README.md
related:
  - ../sources/e2e-readme.md
  - ../sources/steve-verify-readme.md
  - ../sources/testcontainers-java-readme.md
  - ../entities/csms-peers.md
updated: 2026-09-03
---

# Testing strategy

## Vitest vs. Bun test

- **Vitest** (`bun run test:vitest`, `*.test.ts(x)`) is the default: jsdom
  UI/DOM tests, plain unit tests, and anything that runs fine in a
  browser-safe environment.
- **Bun test** (`bun run test:bun`, `*.bun.test.ts`) is for behavior that
  needs the real Bun runtime: the CLI entry point, the Bun HTTP/socket
  server, `bun:sqlite`, and subprocess-spawning integration tests.

Coverage (`bun run test:coverage` / `test:coverage:bun`, uploaded to Codecov
in CI) merges both reports — `coverage/lcov.info` (Vitest) and
`coverage/bun/lcov.info` (Bun) — so the **line** coverage of code exercised
only by Bun tests no longer shows as uncovered. Two limitations to keep in
mind: Bun's lcov reports line coverage only (no branch or per-function data,
unlike Vitest's v8 report), and Bun tests that spawn a subprocess (e.g. the
CLI-entry integration tests) only cover the parent process, so the child's
lines are not attributed. The merged figure is therefore a floor for
Bun-only-covered code, not a fully-representative number.

## Layers beyond unit tests

| Layer                                                                                        | Runs in CI? | What it proves                                                                                                                                          |
| -------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vitest / Bun test (above)                                                                    | yes         | Units, UI, CLI entry, socket server, `bun:sqlite`, protocol schemas, scenario schema conformance of every shipped JSON                                  |
| [gocpp e2e](../sources/e2e-readme.md) (`bun run test:e2e`)                                   | no (local)  | Real WebSocket CP ↔ independent Go CSMS across OCPP 1.6 / 2.0.1 / 2.1; `all-cases.json` under every version                                             |
| [steve-verify](../sources/steve-verify-readme.md)                                            | no (local)  | All 47 `cert16-*` templates against a real SteVe, CSMS-side actions driven over SteVe's REST API, uniqueId-correlated assertions                        |
| [Testcontainers (Java)](../sources/testcontainers-java-readme.md)                            | no (proto)  | A CSMS project can embed the Docker image and assert a scenario verdict; the same RPC sequence is guarded in CI by `harnessScenarioVerdict.bun.test.ts` |
| Scenario assertions ([Scenario format](../concepts/scenario-format.md#assertions--verdicts)) | at run time | Declarative pass/fail over the OCPP transcript of any scenario run, with conformance vs compatibility axes                                              |

The `analyze` test matrix (`src/cli/analyze/__tests__/`) is the gate that
must be re-verified whenever the pinned DebugKit version changes
([OCPP DebugKit](../entities/ocpp-debugkit.md)).
