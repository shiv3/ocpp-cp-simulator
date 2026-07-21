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
`coverage/bun/lcov.info` (Bun) — so code exercised only by Bun tests no
longer shows as uncovered.
