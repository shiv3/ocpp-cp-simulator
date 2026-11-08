---
title: Error reporting (Sentry, opt-in)
type: concept
summary: Opt-in Sentry error reporting for the CLI/daemon (`SENTRY_DSN`, runtime) and the web console (`VITE_SENTRY_DSN`, build time) — off by default, errors only, data collection off, every event scrubbed by the shared redaction.
sources:
  - packages/contracts/src/errorReporting.ts
  - packages/contracts/src/redaction.ts
  - apps/cli/src/errorReporting.ts
  - apps/web/src/lib/errorReporting.ts
  - Dockerfile
  - "issue #794"
related:
  - ../entities/cli.md
  - ../entities/daemon.md
  - ../entities/web-console.md
  - ../entities/docker-image.md
  - log-format.md
updated: 2026-11-08
---

# Error reporting (Sentry, opt-in)

The CLI, the daemon and the web console can send their crashes and unhandled
errors to a [Sentry](https://sentry.io) project of the operator's choosing
([#794](https://github.com/shiv3/ocpp-cp-simulator/issues/794)). It is **off by default**: no DSN is shipped in the code, the npm
package, the GitHub Pages console or the published image, and without one the
Sentry SDK is never loaded.

## Turning it on

| Variable                  | Read by     | When       | Effect                                                     |
| ------------------------- | ----------- | ---------- | ---------------------------------------------------------- |
| `SENTRY_DSN`              | CLI, daemon | run time   | Enables reporting (`@sentry/bun`). Blank or unset = off.   |
| `SENTRY_ENVIRONMENT`      | CLI, daemon | run time   | Optional Sentry `environment`.                             |
| `VITE_SENTRY_DSN`         | web console | build time | Enables reporting (`@sentry/react`). Blank or unset = off. |
| `VITE_SENTRY_ENVIRONMENT` | web console | build time | Optional Sentry `environment`.                             |

The console's variables are **inlined by Vite at build time**. A `SENTRY_DSN`
given to a daemon at run time does not reach the console that daemon serves:
the bundle has to be built with `VITE_SENTRY_DSN`
(`docker build --build-arg VITE_SENTRY_DSN=…`, see
[Docker image](../entities/docker-image.md#error-reporting)). The
[desktop app](../entities/desktop-app.md) wires nothing of its own: the Tauri
shell reports nothing, but its daemon sidecar is the compiled CLI and
inherits the app's environment, so it reports when the app is started with
`SENTRY_DSN` set (an app launched from the macOS Finder does not see a
shell's variables). Its console reports only if it was built with
`VITE_SENTRY_DSN`.

The release is the build's own version: `appVersion()` on the CLI side, the
console's build label without its `v` on the other, both from
`packages/contracts/src/buildVersion.ts` (see
[Daemon → Health](../entities/daemon.md#health)).

## What is sent

- **Errors only.** No tracing (`tracesSampleRate` unset), no session replay,
  no session (release health) reports: the console drops the SDK's
  `BrowserSession` integration, the CLI / daemon its `ProcessSession` one and
  the per-request sessions of its HTTP servers (`sessions: false`).
- **CLI / daemon:** uncaught exceptions, unhandled rejections and the error a
  `Fatal:` exit reports, flushed (up to 2 s) before the process exits.
  Unhandled rejections still exit the process with code 1, as they do without
  Sentry (the SDK's `strict` mode; its default would keep the process alive).
  Logged errors (`[ERROR]` lines) are breadcrumbs, not events.
- **Web console:** uncaught errors and the three React root error hooks
  (`onUncaughtError`, `onCaughtError`, `onRecoverableError`), which still log
  to the browser console.
- The SDK never writes to stdout: JSON Lines mode output is the same with and
  without a DSN.

## What is scrubbed

The SDK's `dataCollection` option (v11's replacement for `sendDefaultPii`)
has every optional category off (`restrictedDataCollection`): no user fields,
cookies, HTTP headers or bodies, query strings or local variables. Every event
and breadcrumb then goes through `scrubErrorReport` before it leaves:

- the redaction the trace and log writers use (`redactSensitiveValue`, see
  [Log format](log-format.md)): `user:pass@` in URLs, bearer tokens, secret
  query parameters, sensitive members (`password`, `AuthorizationKey`,
  `BasicAuthPassword`, `privateKey`, `simPin`, …) and the 1.6 / 2.x
  configuration entries that carry them;
- then the request's cookies, and every member named `Authorization`,
  `Proxy-Authorization`, `Cookie` or `Set-Cookie` (any case) at any depth:
  the request's headers, and a header map logged into a breadcrumb.

The scrubbing recognises these names and forms only. A credential that is
neither, such as `Authorization: Basic …` quoted inside an error message or a
bare password in free text, is sent as it is.

The host name (`server_name`) and the stack traces are sent. The data goes only
to the project behind the DSN the operator configured.

## If the SDK fails to load

A console whose Sentry chunk fails to load (offline, blocked) renders without
reporting and logs one warning. A CLI that cannot import the SDK writes one
line to stderr and carries on.
