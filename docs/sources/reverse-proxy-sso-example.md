---
title: "Source: docs/examples reverse-proxy + SSO compose"
type: source
summary: Illustrative nginx + Authelia compose (`compose-reverse-proxy-sso.yml` + `nginx-reverse-proxy-sso.conf`) publishing the web console at a public HTTPS URL behind SSO, using `--trust-forwarded-headers`.
sources:
  - docs/examples/compose-reverse-proxy-sso.yml
  - docs/examples/nginx-reverse-proxy-sso.conf
  - "issue #73"
related:
  - ../concepts/access-control.md
  - ../entities/docker-image.md
updated: 2026-09-03
---

# Source: reverse-proxy + SSO example

Files: [`compose-reverse-proxy-sso.yml`](../examples/compose-reverse-proxy-sso.yml),
[`nginx-reverse-proxy-sso.conf`](../examples/nginx-reverse-proxy-sso.conf).

**What it shows** (issue #73): the simulator image in server mode behind nginx
(TLS termination + `auth_request` forward-auth) with Authelia providing single
sign-on. The web console is published at `https://ocpp.example.com`, gated by
SSO.

**The one simulator-specific bit.** Bound to `0.0.0.0` behind a proxy the
daemon only knows its internal address, so the browser's
`Origin: https://ocpp.example.com` fails the same-origin CORS default and the
page's own `/assets/*` 403. nginx sets `X-Forwarded-Proto/Host` and the
`--trust-forwarded-headers` flag lets the daemon reconstruct the public origin
(alternative: drop the flag and pass `--cors-origin https://ocpp.example.com`).
Full reasoning: [Access control → Behind a reverse proxy](../concepts/access-control.md#behind-a-reverse-proxy-traefik-nginx-caddy-).

**Security property.** The simulator port is **not** published to the host —
only nginx reaches it on the internal network (`expose:` not `ports:`), so a
client cannot bypass the proxy and spoof `X-Forwarded-*` headers. This is the
precondition for `--trust-forwarded-headers` being safe.

**Status.** Illustrative, not turnkey: supply TLS certs under `./certs`, an
Authelia config under `./authelia`, and replace the example hostnames.
