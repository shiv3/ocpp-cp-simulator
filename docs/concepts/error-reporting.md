---
title: Error reporting (opt-in, pluggable)
type: concept
summary: Opt-in, vendor-neutral error reporting — an `ErrorReporter` contract, adapters selected with `OCPP_SIM_ERROR_REPORTER` (CLI/daemon, run time, built-in name or module) and `VITE_ERROR_REPORTER` (console, build time, built-ins); Sentry is the built-in adapter. Off by default, errors only, every event scrubbed by the shared redaction.
sources:
  - packages/contracts/src/errorReporting.ts
  - packages/contracts/src/sentryOptions.ts
  - packages/contracts/src/redaction.ts
  - apps/cli/src/errorReporting.ts
  - apps/cli/src/errorReporters/sentry.ts
  - apps/web/src/lib/errorReporting.ts
  - apps/web/src/lib/errorReporters/sentry.ts
  - Dockerfile
  - "issue #794"
related:
  - ../entities/cli.md
  - ../entities/daemon.md
  - ../entities/web-console.md
  - ../entities/docker-image.md
  - log-format.md
updated: 2026-11-09
---

# Error reporting (opt-in, pluggable)

The CLI, the daemon and the web console can send their crashes and unhandled
errors to an error tracker of the operator's choosing
([#794](https://github.com/shiv3/ocpp-cp-simulator/issues/794)). It is **off by default**: nothing is selected or
configured in the code, the npm package, the GitHub Pages console or the
published image, and without a selection no adapter and no vendor SDK is
loaded.

Reporting is vendor-neutral. The apps catch the errors and hand them to an
`ErrorReporter`; an **adapter** implements that interface for one vendor.
[Sentry](https://sentry.io) is the first built-in adapter; others (Datadog,
…) plug in the same way.

## Turning it on

| Variable                  | Read by          | When       | Effect                                                                                    |
| ------------------------- | ---------------- | ---------- | ----------------------------------------------------------------------------------------- |
| `OCPP_SIM_ERROR_REPORTER` | CLI, daemon      | run time   | Selects the adapter: a built-in name (`sentry`) or a module specifier. Blank/unset = off. |
| `VITE_ERROR_REPORTER`     | web console      | build time | Selects a built-in adapter (`sentry`). Blank/unset = off.                                 |
| `SENTRY_DSN`              | Sentry (CLI)     | run time   | Required by the Sentry adapter.                                                           |
| `SENTRY_ENVIRONMENT`      | Sentry (CLI)     | run time   | Optional Sentry `environment`.                                                            |
| `VITE_SENTRY_DSN`         | Sentry (console) | build time | Required by the Sentry adapter.                                                           |
| `VITE_SENTRY_ENVIRONMENT` | Sentry (console) | build time | Optional Sentry `environment`.                                                            |

Sentry for the CLI / daemon:

```sh
OCPP_SIM_ERROR_REPORTER=sentry SENTRY_DSN=https://…@….ingest.sentry.io/… \
  ocpp-cp-sim --cp-id CP001 --ws-url wss://…
```

A selected adapter that is not configured (`sentry` without a DSN), cannot be
loaded, does not export `createErrorReporter` or fails to start leaves
reporting off: the CLI writes one `Error reporting disabled: …` line to
stderr (never stdout) and carries on, the console logs one warning and
renders.

The console's first paint waits for a selected adapter for at most
`ERROR_REPORTER_WAIT_MS` (300 ms) in `apps/web/src/lib/errorReporting.ts`:
an optional reporter must not keep the console blank. Past that bound the
console renders and the adapter keeps loading in the background. Errors
raised meanwhile are logged at once and handed to the adapter once it has
started (the first `ERROR_REPORTER_BUFFER_SIZE`, 20, are kept; later ones
are only logged); if it never starts, they stay logged only. Bounding the
wait for the saved language's chunk (`i18nReady`) is left to a follow-up.

The console's variables are **inlined by Vite at build time**. Variables
given to a daemon at run time do not reach the console that daemon serves:
the bundle has to be built with `VITE_ERROR_REPORTER` and the adapter's own
variables (`docker build --build-arg VITE_ERROR_REPORTER=sentry
--build-arg VITE_SENTRY_DSN=…`, see
[Docker image](../entities/docker-image.md#error-reporting)). The
[desktop app](../entities/desktop-app.md) wires nothing of its own: the Tauri
shell reports nothing, but its daemon sidecar is the compiled CLI and
inherits the app's environment, so it reports when the app is started with
`OCPP_SIM_ERROR_REPORTER` (and the adapter's variables) set (an app launched
from the macOS Finder does not see a shell's variables). Its console reports
only if it was built with `VITE_ERROR_REPORTER`.

The release is the build's own version: `appVersion()` on the CLI side, the
console's build label without its `v` on the other, both from
`packages/contracts/src/buildVersion.ts` (see
[Daemon → Health](../entities/daemon.md#health)).

## The contract

`packages/contracts/src/errorReporting.ts` holds the SDK-free contract:

| Type                   | Role                                                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ErrorReporter`        | `captureException(error, context)` (never throws) and `flush(timeoutMs)` (resolves `true` when everything queued was sent in time).                                                           |
| `ErrorReportContext`   | `mechanism` (where the error was caught: `fatal`, `unhandledRejection`, `uncaughtException`, `react.uncaught`, `react.caught`, `react.recoverable`), `handled`, and React's `componentStack`. |
| `ErrorReporterInit`    | What an adapter receives: `release`, `env` (it reads its own variables: `SENTRY_DSN`, `DD_*`, …) and `scrub`.                                                                                 |
| `ErrorReporterFactory` | `(init) => Promise<ErrorReporter \| null>`: `null` when the adapter is selected but not configured. It may reject; the caller treats that as "reporting off".                                 |

The core owns the process- and page-level behaviour, the same whichever
adapter is plugged in:

- **CLI / daemon** (`apps/cli/src/errorReporting.ts`): only while a reporter
  is active, it listens for unhandled rejections and uncaught exceptions,
  captures them (`handled: false`), flushes (up to 2 s), prints the error to
  stderr and exits with code 1, as the runtime does without a reporter. The
  error a `Fatal:` exit reports goes through `reportFatalError` (mechanism
  `fatal`, flushed up to 2 s). Without a reporter no handler is installed.
- **Web console** (`apps/web/src/lib/errorReporting.ts`): it builds the three
  React root error hooks (`onUncaughtError`, `onCaughtError`,
  `onRecoverableError`), which capture with the matching mechanism and the
  component stack and still log to the browser console. When the adapter
  loads after the first-paint bound, the hooks forward to it from then on
  and hand it the errors kept while it loaded.

### Writing a CLI adapter

`OCPP_SIM_ERROR_REPORTER` takes a module specifier as well as a built-in
name: a path starting with `.` or `/` is resolved against the working
directory, anything else is imported as a package name. The module exports
`createErrorReporter`:

```ts
// my-reporter.ts — OCPP_SIM_ERROR_REPORTER=./my-reporter.ts
import type {
  ErrorReporter,
  ErrorReporterInit,
} from "@ocpp-cp-simulator/contracts/errorReporting";

export async function createErrorReporter({
  release,
  env,
  scrub,
}: ErrorReporterInit): Promise<ErrorReporter | null> {
  const endpoint = env.MY_TRACKER_URL;
  if (typeof endpoint !== "string" || !endpoint) return null; // not configured
  const pending = new Set<Promise<unknown>>();
  return {
    captureException(error, context) {
      const report = scrub({
        release,
        ...context,
        message: error instanceof Error ? error.stack : String(error),
      });
      const sent = fetch(endpoint, {
        method: "POST",
        body: JSON.stringify(report),
      }).catch(() => undefined);
      pending.add(sent);
      void sent.finally(() => pending.delete(sent));
    },
    async flush(timeoutMs) {
      const timeout = new Promise<false>((resolve) =>
        setTimeout(resolve, timeoutMs, false),
      );
      return Promise.race([Promise.all(pending).then(() => true), timeout]);
    },
  };
}
```

The `import type` is erased, so the module does not need the simulator's
packages at run time. An adapter must never write to stdout (JSON Lines mode
owns it) and must leave unhandled rejections and uncaught exceptions to the
core (turn off the SDK's own global handlers).

The console cannot load an arbitrary module: its adapters are a registry of
lazy chunks (`BUILTIN_REPORTERS` in `apps/web/src/lib/errorReporting.ts`), so
a new console adapter is added there, under `apps/web/src/lib/errorReporters/`.
The CLI's built-ins live in the same kind of registry in
`apps/cli/src/errorReporting.ts`.

## The Sentry adapter

`apps/cli/src/errorReporters/sentry.ts` (`@sentry/bun`) and
`apps/web/src/lib/errorReporters/sentry.ts` (`@sentry/react`); their SDK-free
options are in `packages/contracts/src/sentryOptions.ts`. The SDK is
imported only when the adapter is selected and has a DSN.

- **Errors only.** No tracing (`tracesSampleRate` unset), no session replay,
  no session (release health) reports: the console drops the SDK's
  `BrowserSession` integration, the CLI / daemon its `ProcessSession` one and
  the per-request sessions of its HTTP servers (`sessions: false`).
- **CLI / daemon:** the SDK's `OnUncaughtException` and
  `OnUnhandledRejection` integrations are dropped, since the core owns those
  errors (above); events carry the core's mechanism, and level `fatal` when
  unhandled. Logged errors (`[ERROR]` lines) are breadcrumbs, not events. The
  SDK never writes to stdout (`debug: false`).
- **Web console:** the SDK keeps its passive browser handlers
  (`GlobalHandlers`: `window.onerror`, `unhandledrejection`). An error with a
  component stack is captured as Sentry's own React error handler does (the
  stack linked as a `React ErrorBoundary` cause) and the stack is also kept in
  a `react` context.
- **Data collection:** the SDK's `dataCollection` option (v11's replacement
  for `sendDefaultPii`) has every optional category off
  (`restrictedDataCollection`), so the SDK does not collect user fields,
  cookies, HTTP headers or bodies, query strings or local variables on its
  own. The option governs only that automatic collection: a header or a
  query string the simulator itself puts in an error message, a log line or
  a breadcrumb's data is sent unless the scrubbing below recognises it.

## What is scrubbed

Every adapter receives `scrubErrorReport` as `init.scrub` and **must** run
every outgoing event and breadcrumb through it (Sentry's `beforeSend` /
`beforeBreadcrumb`, or the vendor SDK's equivalent):

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

What else leaves depends on the adapter. The Sentry adapter sends the host
name (`server_name`) and the stack traces, to the project behind the DSN the
operator configured, and nowhere else.
