---
title: Open EV Directory
type: entity
summary: The external vehicle catalog that vehicle profiles are imported from — endpoints the simulator calls, daemon and Local-mode configuration, key handling and redaction, error mapping, the CORS caveat and a reproducible smoke test.
sources:
  - src/cp/infrastructure/vehicle-catalog/open-ev-directory/OpenEvDirectoryClient.ts
  - src/cp/infrastructure/vehicle-catalog/open-ev-directory/__fixtures__/LICENSE.md
  - src/cp/domain/vehicle/VehicleCatalog.ts
  - src/cli/vehicleCatalogConfig.ts
  - src/cli/server/vehicleRpc.ts
  - src/console/lib/vehicleCatalog.ts
  - src/cp/shared/redaction.ts
  - https://github.com/juherr/open-ev-directory
  - "issue #458"
related:
  - ../concepts/vehicle-profiles.md
  - cli.md
  - daemon.md
  - web-console.md
  - ../concepts/control-plane.md
  - ../concepts/local-vs-remote-mode.md
  - mcp-endpoint.md
updated: 2026-10-11
---

# Open EV Directory

[Open EV Directory](https://github.com/juherr/open-ev-directory) is a
read-only REST API, publicly served at <https://evdb.juherr.dev>, over a normalized, source-attributed dataset of electric
vehicles: makes, models, variants, the specifications each upstream source
gives (side by side, never merged) and DC charging curves with their quality.
The simulator reads it **only to import and refresh** [vehicle profiles](../concepts/vehicle-profiles.md)
(#458); nothing at run time calls it. The simulator side is the `VehicleCatalog`
port ([`VehicleCatalog.ts`](../../src/cp/domain/vehicle/VehicleCatalog.ts)) and
its adapter
[`OpenEvDirectoryClient.ts`](../../src/cp/infrastructure/vehicle-catalog/open-ev-directory/OpenEvDirectoryClient.ts),
which runs in the [daemon](daemon.md) and, in Local mode, in the browser.

## Endpoints used

| Port method    | Request                                                             | Notes                                                                                 |
| -------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `listMakes`    | `GET /v1/makes?size=200&page=n`                                     | Pages through every make.                                                             |
| `searchModels` | `GET /v1/models?size=50&page=n[&make=<id>][&model=<text>]`          | `model` is a model id or part of its name.                                            |
| `listVariants` | `GET /v1/models/{id}/variants?size=50&page=n`                       | Variant summaries: sources, curve count.                                              |
| `getVariant`   | `GET /v1/variants/{id}` and `GET /v1/variants/{id}/charging-curves` | Both at once. A former id's redirect is followed; the curves are read again under it. |

Every successful response is validated against the shapes in `dto.ts`, then
against the limits the simulator carries a catalog answer under (the
`src/protocol/vehicle.ts` schemas the daemon's RPC results use: at most 64
records or curves, 512 points, non-negative powers, SoC within 0–100 %, bounded
strings); a body that is not JSON, does not match or exceeds them is
`invalid_response`, in both console modes alike. Ids sent as path segments
must be letters, digits, `_` or `-` (`invalid_request` otherwise, before any
call). Each request has a **10 s**
timeout. The adapter is pinned to the API's published response examples by
contract fixtures in
[`__fixtures__/`](../../src/cp/infrastructure/vehicle-catalog/open-ev-directory/__fixtures__/LICENSE.md)
(copies, reformatted by the repository's formatter; test data only, under the upstream sources' licenses).

## Configuration

**Daemon (Remote mode).** Server mode only. The base URL comes from
`--oed-base-url <url>`, else `OED_BASE_URL`, else the public instance
`https://evdb.juherr.dev`; nothing is called until a user imports a vehicle,
and `none` (either setting, any case) turns import off. The catalog is
anonymous: a key is optional. It comes from the file named by
`--oed-api-key-file <path>`, else the file named by `OED_API_KEY_FILE`, else
`OED_API_KEY` (the flags are in [CLI → CLI Options](cli.md#cli-options)).
There is deliberately **no flag that takes the key itself**: a command line is
visible to every user of the host (`ps`), an environment variable or a mounted
secret file (a Docker secret) is not.

| Situation                                   | Result                                                               |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `--oed-base-url` neither http(s) nor `none` | Exit 1 with `--oed-base-url must be … http(s) URL or none`           |
| `OED_BASE_URL` malformed (and no flag)      | Exit 1 with `OED_BASE_URL must be … http(s) URL or none`             |
| Key file unreadable or empty                | Exit 1 naming the source (`--oed-api-key-file` / `OED_API_KEY_FILE`) |
| A key with the URL set to `none`            | Warning; import off                                                  |
| URL set to `none`                           | Import off; `vehicle_catalog.*` answers `unavailable`                |
| No key                                      | Calls are anonymous (the public catalog serves them)                 |

`server.info` reports `vehicleCatalog: { provider: "open-ev-directory",
configured, authenticated }` — whether a URL and a key are set, never the key
([Control plane](../concepts/control-plane.md#vehicle-profiles-and-catalog)).
The console in Remote mode imports through the daemon's
`vehicle_catalog.*` methods, so the key never reaches the browser; when
import is off, the import dialog says so.

**Browser-only Local mode.** The console calls the API directly
([`vehicleCatalog.ts`](../../src/console/lib/vehicleCatalog.ts)) with a key
you type in the import dialog. The key is held **in memory only** — never in
`localStorage`, IndexedDB, an export or a URL — so it is gone when the tab
closes (**Forget** drops it sooner). The base URL starts as the public
instance, is not a secret, and is remembered in `localStorage` under
`ocpp-cp.oed-base-url`. A key typed into a
page cannot be secret from that browser; use daemon mode where that matters.

## Keys and redaction

The key is sent as `Authorization: Bearer <key>`, only when one is set — the
scheme Open EV Directory issues individual keys for
([juherr/open-ev-directory#10](https://github.com/juherr/open-ev-directory/issues/10)).
A personal key (`evd_live_…`) is optional — the catalog is anonymous — and
not self-service yet: the explorer has GitHub sign-in but no key page
([juherr/open-ev-directory#14](https://github.com/juherr/open-ev-directory/issues/14)),
so the operator provisions keys (its README,
[API keys](https://github.com/juherr/open-ev-directory#api-keys)). A key is
shown once.
A key that is sent must be valid: a malformed, unknown, revoked or expired one
is `401` (`unauthorized`), while no key at all is served anonymously. A key is
sent only over https, or over http to this machine (`localhost`, `127.0.0.1`,
`[::1]`): a key with a plain-http URL to another host is refused — exit 1 for
the daemon, an error under the URL in the import dialog. A redirect keeps the
key on the same origin only; the runtime drops `Authorization` when a
redirect leaves it, which a test pins for the daemon's Bun.
No error message the adapter builds contains the key: messages carry the
request path and what the API said, a problem `detail` that echoes the key is
scrubbed, and the underlying fetch error is not kept as a cause. The shared
redaction ([`redaction.ts`](../../src/cp/shared/redaction.ts)) also replaces
any `Bearer <token>` and any
`apiKey` / `api_key` assignment in text with `[redacted]`, and drops an
`apiKey` field (any spelling with `-` / `_`) from redacted objects. That
redaction is shared with the diagnostic outputs, so a charge point
configuration key named `ApiKey` now shows its value as `[redacted]` in
Socket.IO events, JSON Lines and scenario reports, like `AuthorizationKey`;
what the charge point answers the CSMS is unchanged (`GetConfiguration`
blanks only `AuthorizationKey`).

## Errors

The adapter turns each failure into a `VehicleCatalogError` of one kind; the
daemon carries it over the [control plane](../concepts/control-plane.md#rpc)
as an RPC error code, and the Remote console maps it back.

| Upstream                           | Catalog kind       | RPC code         |
| ---------------------------------- | ------------------ | ---------------- |
| HTTP 401 / 403                     | `unauthorized`     | `unauthorized`   |
| HTTP 404 (on the variant itself)   | `not_found`        | `not_found`      |
| HTTP 429 (+ `Retry-After`)         | `rate_limited`     | `rate_limited`   |
| HTTP 5xx                           | `unavailable`      | `unavailable`    |
| Other HTTP 4xx                     | `invalid_request`  | `invalid_params` |
| Bad JSON, shape or limits          | `invalid_response` | `unavailable`    |
| Variant found, its curves 404      | `invalid_response` | `unavailable`    |
| No answer within 10 s              | `timeout`          | `timeout`        |
| Offline, DNS, cross-origin refusal | `network`          | `unavailable`    |
| No base URL configured             | `not_configured`   | `unavailable`    |

`Retry-After` is read as delta-seconds or an HTTP date and carried as
`retryAfterSeconds` on the error, and on a Socket.IO `rate_limited` ack. Over
MCP only the text survives (`rate_limited: Open EV Directory rate limit
reached; retry in 7 s`).

## CORS

In Local mode the browser calls the API cross-origin. The public instance
sends no CORS headers (checked 2026-10-12), so the browser blocks the call,
which looks exactly like being offline (`network`). The console explains it
and points to daemon mode, where the call is server-to-server and CORS does
not apply.

## Smoke test

Against the public instance, with no setting at all (`bun run build` first,
so `--web-console` has a `dist/`):

```bash
bun src/cli/main.ts --http-port 9700 --web-console
# optional, a personal key: OED_API_KEY=evd_live_… bun src/cli/main.ts …
```

Against a local Open EV Directory (or any stub serving the same paths),
follow its README:

```bash
# In an open-ev-directory checkout (JDK 25, Docker)
docker compose up -d --wait   # PostgreSQL on host port 55432
./gradlew importDataset       # load the committed dataset
./gradlew bootRun             # the API on http://localhost:8080
```

then point the daemon at it:

```bash
bun src/cli/main.ts --http-port 9700 --web-console \
  --oed-base-url http://localhost:8080
```

Open `http://127.0.0.1:9700/settings#vehicle-profiles`, **Import from Open EV
Directory**, search a model, pick a variant, a source record and a curve (or
**No curve**), and **Save**. Then pick the profile in a connector's
**Config → EV** select.

Without the console, call the catalog through the MCP endpoint (or the same
method over Socket.IO):

```bash
curl -s -X POST http://127.0.0.1:9700/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"call_method","arguments":{"method":"vehicle_catalog.list_makes"}}}'
```

A daemon started with `--oed-base-url none` answers `unavailable: Vehicle
import is turned off on the daemon (--oed-base-url none or OED_BASE_URL=none)`.
