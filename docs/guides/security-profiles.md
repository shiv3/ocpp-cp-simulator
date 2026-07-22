# OCPP 1.6 Security Profiles

CLI/server mode supports the OCPP 1.6 Security Whitepaper transport profiles:

| Profile | Transport | Authentication / certificates                                                     |
| ------- | --------- | --------------------------------------------------------------------------------- |
| `1`     | `ws://`   | HTTP Basic Auth with CP ID as the username and `AuthorizationKey` as the password |
| `2`     | `wss://`  | Profile 1 plus CSMS server certificate verification (`--tls-ca` for private CAs)  |
| `3`     | `wss://`  | Mutual TLS with `--tls-cert` + `--tls-key`; Basic Auth is disabled                |

Profiles 2/3 and TLS certificate files are available in CLI/server mode only, not browser local mode.

## Flags

- `--security-profile <0|1|2|3>` selects transport security enforcement; `0` leaves transport/auth as configured.
- `--authorization-key <hex>` sets the `AuthorizationKey` used as the Basic Auth password for profiles 1 and 2.
- `--tls-ca <path>` loads a PEM CA bundle used to verify the CSMS server certificate.
- `--tls-cert <path>` loads the PEM client certificate for profile 3 mutual TLS.
- `--tls-key <path>` loads the PEM client private key for profile 3 mutual TLS; the file must be mode `0600`.
- `--cpo-name <name>` sets the CPO name used when generating certificate signing requests.
- `--insecure-tls-key-perms` allows a `--tls-key` file readable by group/other for local testing.

## Examples

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

## Security extension messages

Security extension configuration keys include `SecurityProfile`, `AuthorizationKey`, `AdditionalRootCertificateCheck`, `CertificateSignedMaxChainSize`, `CertificateStoreMaxLength`, and `CpoName`. The simulator can send `SecurityEventNotification` and `SignCertificate`, handle inbound `CertificateSigned`, and exposes JSON-mode RPC commands `security_event_notification` and `sign_certificate`.
