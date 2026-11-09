# Bun 1.4.x reproductions (#833)

Standalone scripts, no code from this repository. They are a maintainer's
starting point for upstream reports; **nothing has been filed**. Each script
prints one line per probe, so the output of two Bun versions can be diffed.

Versions are taken from `bun-v<version>` release zips run side by side:

```sh
bun ws-refused-handshake.ts   # problem B2
bun ws-tls-refused.ts         # problem B3 (needs openssl on PATH)
bun ws-fragmented.ts          # problem B1 (not reproduced, see below)
cd concurrent-rejects && bun test many-concurrent.test.ts later-rejects.test.ts   # problem A (not reproduced)
```

## B2: refused WebSocket upgrade is reported differently on 1.4.4 (reproduced)

`new WebSocket(url)` against a `Bun.serve` that answers the upgrade with
401, 404 or 302:

| Bun   | events                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------ |
| 1.4.3 | `error(... Expected 101 status code)` then `close(code=1002, reason="Expected 101 status code")` |
| 1.4.4 | `error(... Expected 101 status code: 401)` then `close(code=1006, reason="")`                    |

The status moved from the close reason into the error message and the close
code changed from 1002 to 1006. Code that tells "the server refused the
handshake" from "the network failed" by the close code or reason (as the
simulator does, #288) can no longer do so on 1.4.4.

## B3: refused TLS connection closes with 1006 instead of 1015 on 1.4.4 (reproduced)

| probe                            | 1.4.3                 | 1.4.4                 |
| -------------------------------- | --------------------- | --------------------- |
| `wss://` to a self-signed server | `error`, `close 1015` | `error`, `close 1006` |
| `wss://` to a plain-HTTP port    | `error`, `close 1015` | `error`, `close 1006` |
| `ws://` to a TLS port            | `error`, `close 1006` | `error`, `close 1006` |

1015 ("TLS handshake failure") is gone from the client's close event, so a
refused certificate is indistinguishable from a dropped socket.

## B1: `1002 Received new message inside a fragmented message` (NOT reproduced)

`ws-fragmented.ts` sends 300 requests and has a `Bun.serve` peer answer with
small and 70 kB messages, with and without permessage-deflate and with an
`ocpp2.0.1` subprotocol. Both 1.4.3 and 1.4.4 deliver every message (the
uncompressed 70 kB rows time out on both versions; that is the script's server
dropping under backpressure, not the bug). The symptom was seen in the
simulator's `v201LocalAuthList.bun.test.ts` on 1.4.4 only; what that test does
differently (a real `ChargePoint` sending frames while the peer replies, a
client created with Bun's options-object constructor) is not yet isolated.
Before filing, bisect from the real test: run it on 1.4.4, then remove pieces
until the standalone script fails.

## A: `expect(...).rejects` stalls after a file of `test.concurrent` cases (NOT reproduced)

`concurrent-rejects/` has 340 `test.concurrent` cases, each with its own
`Bun.serve`, a 20-message WebSocket echo and a teardown, followed by a second
file of five `await expect(fails()).rejects.toThrow()` tests. On 1.4.3 and
1.4.4, with or without `--isolate`, each rejects test takes well under 1 ms
and the whole pair runs in about 0.5 s; the stall of 23.5 s (1.4.3) and 41.4 s
(1.4.4) seen with the simulator's golden-wire file did not appear. The report
in #833 already ruled out `Promise.all` under `bun -e` and a shared-server
variant. What remains different is the golden file's mix: a `ChargePoint`
with many timers per case, 443 tests in one `describe`, and cases that end
with the station still holding open timers and sockets when `dispose()`
runs.

## What I would file upstream (decision for the maintainer)

1. **WebSocket client: refused upgrade and refused TLS no longer carry a
   distinguishing close code (1.4.3 -> 1.4.4 regression).** Scripts B2 and B3,
   the two tables above, expected 1002 + reason / 1015 as on 1.4.3 and 1.3.x.
2. **Not ready to file:** B1 and A need a reduction first (see the notes
   above). Filing them with the repository's test files as the only
   reproduction would be rejected as not minimal.
3. Keep the pin to 1.4.3 and `--isolate` until B1 and A have a reproduction and
   a Bun release is checked against the three B files and the A pair without
   `--isolate`.
