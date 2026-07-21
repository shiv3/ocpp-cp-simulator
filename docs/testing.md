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
