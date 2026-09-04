---
title: Access control (bind gate, Basic Auth, CORS, reverse proxies)
type: concept
summary: How the daemon decides who may reach it — loopback by default, `--unsafe-remote` or web-console Basic Auth for non-loopback binds, a bind-dependent CORS policy, and the `--cors-origin` / `--trust-forwarded-headers` fixes for consoles behind a proxy.
sources:
  - src/cli/server/
  - docs/examples/compose-reverse-proxy-sso.yml
  - "issue #73"
related:
  - ../entities/daemon.md
  - ../entities/docker-image.md
  - ../entities/cli.md
  - control-plane.md
  - ../sources/reverse-proxy-sso-example.md
updated: 2026-09-04
---

# Access control

## Bind gate

The default bind address is `127.0.0.1`. Exposing the [daemon](../entities/daemon.md)
beyond loopback (`--http-host 0.0.0.0`, a LAN address) requires one of:

- `--web-console-basic-auth-user/pass`, which gates static assets and the
  Socket.IO handshake while leaving health unauthenticated,
- `--unsafe-remote`, for trusted networks or deployments protected by another
  boundary (the [Docker image](../entities/docker-image.md) pins this in its
  entrypoint because a container intentionally binds non-loopback).

Otherwise startup fails before CORS comes into play. Pair remote exposure with
a tight `--cors-origin` allowlist when browsers can reach the daemon. CORS is
not authentication; it only limits which browser origins can make cross-site
requests.

> **Basic Auth needs TLS.** The daemon itself only speaks plain HTTP, and
> Basic Auth does not encrypt the `Authorization` header or the Socket.IO
> handshake. When a non-loopback daemon relies on
> `--web-console-basic-auth-*`, put it behind a TLS-terminating reverse proxy
> (see [Behind a reverse proxy](#behind-a-reverse-proxy-traefik-nginx-caddy-)
> and the [SSO example](../sources/reverse-proxy-sso-example.md)) and do not
> expose the plain-HTTP port beyond the proxy's network. Cleartext Basic Auth
> is acceptable only on loopback or a trusted, isolated test network.

## Basic Auth gate

`--web-console-basic-auth-user` / `--web-console-basic-auth-pass` (always
paired) enable HTTP Basic Auth on:

- static web-console assets,
- the Socket.IO handshake (`socket.handshake.auth`),
- the [MCP endpoint](../entities/mcp-endpoint.md) `POST /mcp`,
- the SOAP `ChargePointService` callback endpoint,
- `GET /metrics` when `--metrics` is on ([Daemon → Metrics](../entities/daemon.md#metrics)).

The configured health path (`/v1/healthz` by default) is always exempt.
`/metrics` is **not**: health says almost nothing and container probes need it
unprompted, while `/metrics` exposes fleet size and traffic shape.
`--metrics-no-auth` lifts the gate for that one path on a trusted network, and
for nothing else.

### Authenticating to a protected daemon

```bash
# Daemon side: require Basic Auth for web console assets and Socket.IO
ocpp-cp-sim --daemon --http-port 9700 \
  --web-console-basic-auth-user admin --web-console-basic-auth-pass secret

# Client side: the bundled CLI sends handshake auth
ocpp-cp-sim --http-url http://127.0.0.1:9700 \
  --cp-id CP001 --send '{"command":"status"}' \
  --http-basic-auth-user admin --http-basic-auth-pass secret
```

External Socket.IO clients should pass:

```js
io("http://127.0.0.1:9700", {
  path: "/socket.io/",
  auth: { username: "admin", password: "secret" },
});
```

MCP clients send a standard `Authorization: Basic …` header
([MCP endpoint](../entities/mcp-endpoint.md)). `analyze --from-daemon` takes
its own `--http-basic-auth-user/pass` pair ([analyze](../entities/analyze.md)).

The CSMS-facing `--basic-auth-user/pass` flags are unrelated; those
authenticate the simulated CP's outgoing WebSocket to the CSMS
([Security profiles](security-profiles.md)).

## CORS

The CORS policy depends on the bind address and any `--cors-origin` flags:

| Bind                          | `--cors-origin` flag       | Effective policy                                                                                                                                                         |
| ----------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Loopback (`127.0.0.1`, etc.)  | _(none)_                   | **`any`** — `*` echoed back. Safe because nothing off-host can reach loopback anyway.                                                                                    |
| Non-loopback (`0.0.0.0`, LAN) | _(none)_                   | **`same-origin`** — only requests whose `Origin` matches the request `Host` are allowed (plus non-browser callers with no `Origin` header). A warning is logged at boot. |
| Any                           | `--cors-origin <url>` (×N) | **`allowlist`** — only the listed origins are echoed back.                                                                                                               |
| Any                           | `--cors-origin "*"`        | **`any`** — explicit opt-in to open CORS.                                                                                                                                |

For browser UIs hosted on a different origin, allowlist them:

```sh
ocpp-cp-sim --daemon --http-port 9700 \
  --cors-origin http://localhost:5173 \
  --cors-origin https://ocpp-ui.example.com
```

Or opt back into open CORS deliberately (LAN test rigs, scripted integration
tests):

```sh
ocpp-cp-sim --daemon --http-port 9700 --http-host 0.0.0.0 \
  --unsafe-remote --cors-origin "*"
```

Non-browser callers (the bundled CLI, server-to-server Socket.IO clients) do
not send an `Origin` header and are always allowed regardless of policy. The
policy only restricts cross-site browser access.

## Behind a Reverse Proxy (Traefik, nginx, Caddy, …)

This is the most common gotcha when serving the web console (`--web-console`)
behind a proxy at a public HTTPS URL. The Vite `index.html` references its
bundle with `crossorigin`, so the browser sends an `Origin` header even for the
page's own assets:

```
GET https://app.example.com/assets/index-*.js   403 (Forbidden)
GET https://app.example.com/assets/index-*.css  403 (Forbidden)
```

The daemon serves those assets fine internally (`200`), but with the
`same-origin` default it only knows its internal bind address
(`0.0.0.0:9700`), not the public URL the proxy exposes. The browser's
`Origin: https://app.example.com` does not match, so the daemon returns `403`.

Two ways to fix it:

```sh
# 1. Name the public origin explicitly (works with any proxy):
ocpp-cp-sim --daemon --http-port 9700 --web-console \
  --cors-origin https://app.example.com

# 2. Let the daemon derive the public origin from the proxy's
#    X-Forwarded-Proto / X-Forwarded-Host headers:
ocpp-cp-sim --daemon --http-port 9700 --web-console \
  --trust-forwarded-headers
```

| Bind                          | Flag                        | Effective policy                                                                                                           |
| ----------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Non-loopback (`0.0.0.0`, LAN) | `--trust-forwarded-headers` | **`same-origin` + forwarded** — also accepts `Origin` equal to `${X-Forwarded-Proto}://${X-Forwarded-Host}` (first value). |

> **Security:** only pass `--trust-forwarded-headers` when a **trusted** proxy
> sets those headers and the daemon is **not** reachable directly. If a client
> can hit the daemon without going through the proxy, it can spoof
> `X-Forwarded-Host` to forge an allowed origin. `--cors-origin` has no such
> caveat — prefer it when the public URL is fixed.

A worked **nginx + Authelia** example lives at
[`docs/examples/compose-reverse-proxy-sso.yml`](../examples/compose-reverse-proxy-sso.yml)
(with its [`nginx-reverse-proxy-sso.conf`](../examples/nginx-reverse-proxy-sso.conf));
it is summarized in [Reverse-proxy SSO example](../sources/reverse-proxy-sso-example.md).
A proxy that reserves the default health path is handled with `--health-path`
([Daemon → Health](../entities/daemon.md#health)).

## Roadmap

Bearer-token auth or mTLS can be added at the HTTP/socket boundary without
changing CP command method names ([Control plane → Limits & roadmap](control-plane.md#limits--roadmap)).
