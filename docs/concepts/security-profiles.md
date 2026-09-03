---
title: OCPP 1.6 security profiles
type: concept
summary: CLI / server-mode support for the OCPP 1.6 Security Whitepaper transport profiles 1–3 (Basic Auth with AuthorizationKey, server-cert verification, mutual TLS), the related flags, configuration keys and security messages.
sources:
  - README.md (Security Profiles section, PR #97 / issue #94)
  - src/cli/
related:
  - ../entities/cli.md
  - ../entities/csms-peers.md
  - access-control.md
  - scenario-format.md
updated: 2026-09-03
---

# OCPP 1.6 security profiles

CLI/server mode supports the OCPP 1.6 Security Whitepaper transport profiles:

| Profile | Transport | Authentication / certificates                                                     |
| ------- | --------- | --------------------------------------------------------------------------------- |
| `1`     | `ws://`   | HTTP Basic Auth with CP ID as the username and `AuthorizationKey` as the password |
| `2`     | `wss://`  | Profile 1 plus CSMS server certificate verification (`--tls-ca` for private CAs)  |
| `3`     | `wss://`  | Mutual TLS with `--tls-cert` + `--tls-key`; Basic Auth is disabled                |

Profiles 2/3 and TLS certificate files are available in CLI/server mode only,
not browser local mode.

> **Profile 1 is cleartext.** Over `ws://` the Basic Auth header — and with it
> the `AuthorizationKey` — is visible to, and replayable by, anyone on the
> path. Use Profile 1 only on a trusted local network (e.g. a SteVe on the
> same host, as in the example below); for anything reachable from an
> untrusted network use Profile 2 or 3 (`wss://`).

## Flags

- `--security-profile <0|1|2|3>` selects transport security enforcement; `0` leaves transport/auth as configured.
- `--authorization-key <hex>` sets the `AuthorizationKey` used as the Basic Auth password for profiles 1 and 2.
- `--tls-ca <path>` loads a PEM CA bundle used to verify the CSMS server certificate.
- `--tls-cert <path>` loads the PEM client certificate for profile 3 mutual TLS.
- `--tls-key <path>` loads the PEM client private key for profile 3 mutual TLS; the file must be mode `0600`.
- `--cpo-name <name>` sets the CPO name used when generating certificate signing requests.
- `--insecure-tls-key-perms` allows a `--tls-key` file readable by group/other for local testing.

These are distinct from the daemon-side `--web-console-basic-auth-*` gate
([Access control](access-control.md)), which protects the control plane, not
the CP → CSMS link.

## Examples (against SteVe)

```bash
# Profile 1: ws + Basic Auth against SteVe
ocpp-cp-sim --ws-url ws://localhost:8080/steve/websocket/CentralSystemService/ \
            --cp-id CP001 --security-profile 1 \
            --authorization-key 0123456789abcdef

# Profile 2: wss + CSMS CA + Basic Auth
ocpp-cp-sim --ws-url wss://steve.example.com/steve/websocket/CentralSystemService/ \
            --cp-id CP001 --security-profile 2 \
            --authorization-key 0123456789abcdef \
            --tls-ca ./certs/csms-ca.pem

# Profile 3: wss mutual TLS
chmod 600 ./certs/cp001.key
ocpp-cp-sim --ws-url wss://steve.example.com/steve/websocket/CentralSystemService/ \
            --cp-id CP001 --security-profile 3 \
            --tls-ca ./certs/csms-ca.pem \
            --tls-cert ./certs/cp001.crt \
            --tls-key ./certs/cp001.key \
            --cpo-name "Example CPO"
```

## Security extension messages and keys

Security extension configuration keys include `SecurityProfile`,
`AuthorizationKey`, `AdditionalRootCertificateCheck`,
`CertificateSignedMaxChainSize`, `CertificateStoreMaxLength`, and `CpoName`.
The simulator can send `SecurityEventNotification` and `SignCertificate`,
handle inbound `CertificateSigned`, and exposes the JSON-mode / RPC commands
`security_event_notification` and `sign_certificate`
([Control plane](control-plane.md#cp-command-methods)).

Certificate-handling quirks (RSA vs EC CSR keys, PEM line endings, accepted
signature algorithms, hidden `CpoName`) can be armed from a scenario with the
`certQuirks` node and its `octt` preset — see
[Scenario format → certificate quirks](scenario-format.md#inboundpolicy-and-certificate-quirks-notes).
