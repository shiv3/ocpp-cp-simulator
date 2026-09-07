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
updated: 2026-09-07
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

## Where the two runners overlap

The split above is enforced by **filename only** — `vite.config.ts` excludes
`**/*.bun.test.ts` from Vitest, and `test:bun` passes `bun.test` to `bun test`
as a path filter. Nothing stops a developer from typing the obvious command,
`bun test src/cli/__tests__`, which runs _every_ file in that directory in one
Bun process regardless of its name. On a clean tree that command failed
(#339) and neither gate saw it, because neither gate runs it.

Three distinct defects were stacked behind it, each masked by the one before:

- `client.remote.test.ts` used `vi.hoisted()`. Bun aliases the `vitest`
  module to `bun:test`, and Bun's `vi` implements only `fn`, `mock`, `spyOn`,
  `restoreAllMocks` / `resetAllMocks` / `clearAllMocks` and the fake-timer
  helpers — **no `hoisted`, `doMock`, `importActual`, `stubEnv` or
  `resetModules`**. The file therefore died at module load under Bun.
- With that fixed, real cross-file leakage appeared. Bun keeps **one module
  registry for the whole run**, so `vi.mock()` (Bun's `mock.module`) stays in
  force for every file that runs after the one that called it. The
  `RemoteChargePointService` mock installed by `client.remote.test.ts` was
  still installed when `client.socket.test.ts` ran next, so the file that
  exists to drive the _real_ service against a live socket.io server got the
  mock instead and asserted on a handshake that never happened. Vitest gives
  each file its own registry, which is why the same pair is green there.
- With _that_ fixed the directory run reported `127 pass, 0 fail` and still
  **exited 1**. `process.exitCode` is process-global and the CLI entry points
  under test write to it; the test restored it by assigning `undefined`, which
  Node treats as "clear" but **Bun ignores outright**, so the `1` set by the
  `--send` failure case survived to the end of the run. A green suite with a
  red exit code is the worst of the three: CI would have failed with nothing
  in the log to point at.

`bun run test:bun:cli` (`bun test src/cli/__tests__`) now runs in CI, so the
overlap is checked on every pull request. The rules that follow from it, for
anything added to that directory:

- use only the `vi` API listed above — the intersection of the two runners;
- restore process-global state with a **concrete** value, never `undefined`:
  `process.exitCode = undefined` is a no-op under Bun. Success cases here
  assert `exitCode: 0` rather than `exitCode: undefined` for the same reason —
  `0` means the same thing in both runners and does not depend on what an
  earlier test, or an earlier file, left behind;
- if a file calls `vi.mock()`, it must **undo it in an `afterAll`**
  (capture the real export before the mock and re-register it via
  `mock.module` from `bun:test`, guarded on the `Bun` global so Vitest skips
  it). Bun has no per-file teardown for module mocks; `mock.restore()`
  restores `spyOn` spies, not modules;
- do not import the module under test statically alongside a `vi.mock()` of
  one of its dependencies. Vitest hoists `vi.mock` above the file's imports,
  so the factory runs before any module-scope state it closes over exists
  (`ReferenceError: Cannot access '…' before initialization`) — the reason
  `vi.hoisted` was reached for. A top-level `await import("…")` placed after
  the `vi.mock` call is correct in both runners: Vitest calls the factory
  lazily on first import of the mocked module, and Bun does not hoist at all.

The cost is that the 7 non-`bun.test.ts` files in that directory are executed
twice — once by Vitest (which is where their coverage and JUnit results come
from) and once by Bun — for about 11 s. Renaming them to `*.bun.test.ts` was
rejected for exactly that reason: it would move them off Vitest's coverage
report and out of the JUnit upload. The alternative guard considered and
rejected was a test asserting that every file in the directory is picked up
by some gate; it passes on today's tree (Vitest's include-minus-exclude
already covers all 7) and so would not have caught either defect.

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
