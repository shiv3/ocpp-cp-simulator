# Bun WebSocket failure probe (#1033, #1034)

A standalone script, no code from this repository. It prints one line per
probe, so the output of two Bun versions can be diffed. Run it on a candidate
Bun before raising the `.tool-versions` pin (#1038):

```sh
bun ws-failure-causes.ts      # needs openssl on PATH
```

The earlier #833 reproductions (refused upgrade, refused TLS, fragmented
message, `rejects` stall) were removed once the investigation was settled; see
[the outcome on #833](https://github.com/shiv3/ocpp-cp-simulator/issues/833#issuecomment-6893288157)
and what they did not reproduce in #1038.

## What a failed WebSocket attempt carries, per cause

`ws-failure-causes.ts` prints, for each cause, the error event's message and
`error.name` / `code` / `syscall` / `errno` / `status`, then the close.
`syscall`, `errno` and `status` never appear, and 1.4.3's error carries no
`code` at all. The 1.4.4 message reads `WebSocket connection to '<url>'
failed: <tail>`, with `error.name` `"Error"`.

| case                   | 1.4.3 error.code | 1.4.3 close                     | 1.4.4 error.code            | 1.4.4 error message tail                      | 1.4.4 close |
| ---------------------- | ---------------- | ------------------------------- | --------------------------- | --------------------------------------------- | ----------- |
| tcp refused            | -                | 1006 "Failed to connect"        | ECONNREFUSED                | Failed to connect                             | 1006 ""     |
| dns failure (.invalid) | -                | 1006 "Failed to connect"        | ENOTFOUND                   | Failed to connect                             | 1006 ""     |
| upgrade 401/404/302    | -                | 1002 "Expected 101 status code" | (none)                      | Expected 101 status code: 401 (404, 302)      | 1006 ""     |
| untrusted server cert  | -                | 1015 "TLS handshake failed"     | DEPTH_ZERO_SELF_SIGNED_CERT | TLS handshake failed: self signed certificate | 1006 ""     |
| client cert refused    | -                | 1006 "Connection ended"         | ECONNRESET                  | Connection ended                              | 1006 ""     |
| no client cert (mTLS)  | -                | 1006 "Connection ended"         | EPROTO                      | TLS handshake failed: ...CERTIFICATE_REQUIRED | 1006 ""     |
| wss to plain HTTP      | -                | 1015 "TLS handshake failed"     | EPROTO                      | TLS handshake failed: ...WRONG_VERSION_NUMBER | 1006 ""     |

The move of the cause from the close to the error event is intentional
(oven-sh/bun#45223). On 1.4.4 the simulator recognises an unreached CSMS by
`error.code` (ECONNREFUSED, ENOTFOUND, plus EAI_AGAIN, EHOSTUNREACH and
ENETUNREACH), and on 1.4.3 by the close `1006 Failed to connect`. A refused
upgrade is recognised by `Expected 101 status code` in the 1.4.4 error message
or the 1.4.3 close 1002; the status number is not parsed out of it.
