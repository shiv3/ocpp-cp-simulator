---
title: Testing strategy
type: analysis
summary: Which test runner / harness covers what — Vitest for jsdom + unit, Bun test for runtime-bound code, gocpp e2e for multi-version wire output, steve-verify for certification templates, Testcontainers for the external control-plane contract — and how coverage is merged.
sources:
  - package.json (test scripts)
  - .github/workflows/ci.yml
  - codecov.yml
  - e2e/README.md
  - scripts/steve-verify/README.md
  - examples/testcontainers-java/README.md
related:
  - ../entities/desktop-app.md
  - ../sources/e2e-readme.md
  - ../sources/steve-verify-readme.md
  - ../sources/testcontainers-java-readme.md
  - ../entities/csms-peers.md
updated: 2026-09-05
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

## Does anything actually launch the desktop daemon?

Yes, since #319 — and the answer used to be no, which is why the
[desktop app](../entities/desktop-app.md) shipped a daemon that exited 1 on
spawn for about 30 releases. CI compiled the sidecar (`bun build --compile`,
the "release smoke" step added for #281) but never ran it, so a failure that
only exists in the compiled binary was invisible.

`src/build/__tests__/tauriSidecarWebConsole.bun.test.ts` closes that class.
It runs under `bun run test:bun` on every pull request, takes ~12 s
(the compile dominates; the binary is built once in `beforeAll` and reused),
and it:

- compiles `src/cli/main.ts` the way `scripts/build-tauri-sidecar.sh` does;
- **parses the arguments out of `src-tauri/src/lib.rs`'s `DAEMON_ARGS`**
  rather than keeping its own copy, so the test cannot silently disagree with
  what Tauri spawns;
- reads `POLL_TIMEOUT_MS` and `HEALTH_PATH` from `public/splash.html` and
  requires health inside the same budget the splash screen gives it — a
  process that exits 1 and one that never becomes ready are the same failure
  to the user, and both fail the test;
- asserts `GET /` actually returns the console it was pointed at (a sentinel
  in a fixture `index.html`, so no `vite build` is needed), across the
  resource-dir, dist-beside-the-binary and macOS `.app` layouts;
- asserts the failure path names every directory it searched.

Not covered here: `tauri build` itself, and therefore the Rust side and the
`bundle.resources` mapping. Those need a Rust toolchain and a real bundle.
