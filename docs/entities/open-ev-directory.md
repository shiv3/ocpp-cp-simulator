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
read-only REST API over a normalized, source-attributed dataset of electric
vehicles: makes, models, variants, the specifications each upstream source
gives (side by side, never merged) and DC charging curves with their quality.
The simulator reads it **only to import and refresh** [vehicle profiles](../concepts/vehicle-profiles.md)
(#458); nothing at run time calls it. The simulator side is the `VehicleCatalog`
port ([`VehicleCatalog.ts`](../../src/cp/domain/vehicle/VehicleCatalog.ts)) and
its adapter
[`OpenEvDirectoryClient.ts`](../../src/cp/infrastructure/vehicle-catalog/open-ev-directory/OpenEvDirectoryClient.ts),
which runs in the [daemon](daemon.md) and, in Local mode, in the browser.

## Endpoints used

| Port method    | Request                                                              | Notes                                                                                     |
| -------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `listMakes`    | `GET /v1/makes?size=200&page=n`                                      | Pages through every make.                                                                 |
| `searchModels` | `GET /v1/models?size=50&page=n[&make=<id>][&model=<text>]`           | `model` is a model id or part of its name.                                                |
| `listVariants` | `GET /v1/models/{id}/variants?size=50&page=n`                        | Variant summaries: sources, curve count.                                                  |
| `getVariant`   | `GET /v1/variants/{id}` then `GET /v1/variants/{id}/charging-curves` | Every source record and every curve. A former id's redirect is followed; the new id wins. |

Every successful response is validated against the shapes in `dto.ts`; a body that is not
JSON or does not match is `invalid_response`. Each request has a **10 s**
timeout. The adapter is pinned to the API's published response examples by
contract fixtures in
[`__fixtures__/`](../../src/cp/infrastructure/vehicle-catalog/open-ev-directory/__fixtures__/LICENSE.md)
(verbatim copies, test data only, under the upstream sources' licenses).

## Configuration

**Daemon (Remote mode).** Server mode only. The base URL comes from
`--oed-base-url <url>`, else `OED_BASE_URL`; the key from the file named by
`--oed-api-key-file <path>`, else the file named by `OED_API_KEY_FILE`, else
`OED_API_KEY` (the flags are in [CLI → CLI Options](cli.md#cli-options)).
There is deliberately **no flag that takes the key itself**: a command line is
visible to every user of the host (`ps`), an environment variable or a mounted
secret file (a Docker secret) is not.

| Situation                                    | Result                                                               |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `--oed-base-url` not an absolute http(s) URL | Exit 1 with `--oed-base-url must be an absolute http(s) URL`         |
| `OED_BASE_URL` malformed (and no flag)       | Exit 1 with `OED_BASE_URL must be an absolute http(s) URL`           |
| Key file unreadable or empty                 | Exit 1 naming the source (`--oed-api-key-file` / `OED_API_KEY_FILE`) |
| A key but no base URL                        | Warning; import disabled                                             |
| No base URL, no key                          | Import disabled; `vehicle_catalog.*` answers `unavailable`           |
| Base URL without a key                       | Calls are sent unauthenticated                                       |

`server.info` reports `vehicleCatalog: { provider: "open-ev-directory",
configured, authenticated }` — whether a URL and a key are set, never the key
([Control plane](../concepts/control-plane.md#vehicle-profiles-and-catalog)).
The console in Remote mode imports through the daemon's
`vehicle_catalog.*` methods, so the key never reaches the browser; when the
daemon has no URL, the import dialog says how to start it.

**Browser-only Local mode.** The console calls the API directly
([`vehicleCatalog.ts`](../../src/console/lib/vehicleCatalog.ts)) with a key
you type in the import dialog. The key is held **in memory only** — never in
`localStorage`, IndexedDB, an export or a URL — so it is gone when the tab
closes (**Forget** drops it sooner). The base URL is not a secret and is
remembered in `localStorage` under `ocpp-cp.oed-base-url`. A key typed into a
page cannot be secret from that browser; use daemon mode where that matters.

## Keys and redaction

The key is sent as `Authorization: Bearer <key>`, only when one is set. That
scheme is an assumption until Open EV Directory issues individual keys
([juherr/open-ev-directory#10](https://github.com/juherr/open-ev-directory/issues/10)).
No error message the adapter builds contains the key: messages carry the
request path and what the API said, a problem `detail` that echoes the key is
scrubbed, and the underlying fetch error is not kept as a cause. The shared
redaction ([`redaction.ts`](../../src/cp/shared/redaction.ts)) also replaces
any `Bearer <token>`, any `evd_live_…` / `evd_test_…` key and any
`apiKey` / `api_key` assignment in text with `[redacted]`, and drops an
`apiKey` field (any spelling with `-` / `_`) from redacted objects.

## Errors

The adapter turns each failure into a `VehicleCatalogError` of one kind; the
daemon carries it over the [control plane](../concepts/control-plane.md#rpc)
as an RPC error code, and the Remote console maps it back.

| Upstream                           | Catalog kind       | RPC code         |
| ---------------------------------- | ------------------ | ---------------- |
| HTTP 401 / 403                     | `unauthorized`     | `unauthorized`   |
| HTTP 404                           | `not_found`        | `not_found`      |
| HTTP 429 (+ `Retry-After`)         | `rate_limited`     | `rate_limited`   |
| HTTP 5xx                           | `unavailable`      | `unavailable`    |
| Other HTTP 4xx                     | `invalid_request`  | `invalid_params` |
| Bad JSON or unexpected shape       | `invalid_response` | `unavailable`    |
| No answer within 10 s              | `timeout`          | `timeout`        |
| Offline, DNS, cross-origin refusal | `network`          | `unavailable`    |
| No base URL configured             | `not_configured`   | `unavailable`    |

`Retry-After` is read as delta-seconds or an HTTP date and carried as
`retryAfterSeconds` on the error, and on a Socket.IO `rate_limited` ack. Over
MCP only the text survives (`rate_limited: Open EV Directory rate limit
reached; retry in 7 s`).

## CORS

In Local mode the browser calls the API cross-origin. Unless the API allows
the console's origin, the browser blocks the call, which looks exactly like
being offline (`network`). The console explains it and points to daemon mode
(`--oed-base-url` and `OED_API_KEY`), where the call is server-to-server and
CORS does not apply.

## Smoke test

Reproducible against a local Open EV Directory (or any stub serving the same
paths). Follow its README:

```bash
# In an open-ev-directory checkout (JDK 25, Docker)
docker compose up -d --wait   # PostgreSQL on host port 55432
./gradlew importDataset       # load the committed dataset
./gradlew bootRun             # the API on http://localhost:8080
```

Then, in this repository (`bun run build` first, so `--web-console` has a
`dist/`):

```bash
# OED_API_KEY is optional until open-ev-directory#10 ships keys
OED_API_KEY=evd_test_… bun src/cli/main.ts --http-port 9700 --web-console \
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

A daemon started without a URL answers `unavailable: No vehicle catalog is
configured on the daemon; start it with --oed-base-url or OED_BASE_URL`.
