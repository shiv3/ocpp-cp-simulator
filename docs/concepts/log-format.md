---
title: Log format
type: concept
summary: One log-line shape (`timestamp` / `level` / `type` / `message` / `cpId`) shared by daemon stderr in `--log-format json`, the `logs` table, the browser log download and the `logs.get` RPC — plus the newest-first `limit` windowing rules.
sources:
  - src/cli/server/ (logs.get / logs.clear)
  - src/trace/logEntryToTrace.ts
  - src/cp/shared/Logger.ts
  - src/cp/shared/redaction.ts
related:
  - ../entities/daemon.md
  - ../entities/docker-image.md
  - state-persistence.md
  - trace-format.md
  - ../entities/analyze.md
  - ../entities/cli.md
updated: 2026-10-30
---

# Log format

By default the [daemon](../entities/daemon.md) writes human-readable log lines:

```
[2026-06-01T11:18:38.409Z] [INFO] [OCPP] Boot notification accepted
[2026-06-01T11:18:38.409Z] [INFO] [WebSocket] Sent: [2,"…","StatusNotification",{"connectorId":0,"errorCode":"NoError","status":"Available"}]
```

Pass `--log-format json` to switch to JSON Lines — one object per line,
including the `[server] xxx` setup chatter:

```json
{"timestamp":"2026-06-01T11:18:38.373Z","level":"INFO","type":"Server","message":"Listening on http://127.0.0.1:9700 (socket.io)"}
{"timestamp":"2026-06-01T11:18:38.409Z","level":"INFO","type":"OCPP","message":"Boot notification accepted","cpId":"CP001"}
{"timestamp":"2026-06-01T11:18:38.409Z","level":"INFO","type":"WebSocket","message":"Sent: [2,…]","cpId":"CP001"}
```

The shape (`timestamp` / `level` / `type` / `message` / optional `cpId`) is
identical to:

- the rows persisted in the `logs` table ([State persistence](state-persistence.md)),
- the JSON Lines file produced by the browser's "Download" button in the log
  viewer,
- the result of the `logs.get` RPC method.

So you can pipe daemon stderr into the same `jq` pipeline that consumes a
downloaded log file (see [Docker image → Structured logs](../entities/docker-image.md#structured-logs)
for an example). The same lines are what the [trace adapter](trace-format.md#producing-records)
turns into trace records, which is how [`analyze --from-daemon`](../entities/analyze.md#reading-from-a-running-daemon---from-daemon)
works without a trace file.

## Redaction

The charge point's `Logger` runs each message through the shared text
redactor ([`redaction.ts`](../../src/cp/shared/redaction.ts)) before it
reaches the console, the `logs` table or a log listener (the CLI `log` event,
the Socket.IO log push). In an OCPP-J frame logged as `Sent:` / `Received:`
it replaces with `[redacted]`:

- the `value` of a 1.6 `{ "key", "value" }` entry whose key is
  `AuthorizationKey` (or another sensitive key name: `ApiKey`, `ApnPassword`,
  `BasicAuthPassword`, `Password`, `PrivateKey`, `SimPin`, `TlsKey`) — a
  `ChangeConfiguration`, a `GetConfiguration` answer;
- the `attributeValue` of a 2.0.1 `{ "variable": { "name" }, "attributeValue" }`
  entry whose variable is `BasicAuthPassword` or `AuthorizationKey` (or
  another of those key names) — a `SetVariables` request, a `GetVariables`
  answer (#400);
- in a 2.0.1 / 2.1 `SetNetworkProfile`, the `apnPassword` and the integer
  `simPin` (SIM card PIN) of `connectionData.apn`, the `key` (VPN shared
  secret) of
  `connectionData.vpn` and, in 2.1, `connectionData.basicAuthPassword`
  (#401). `vpn.password` was already caught as a `password` field;
  `connectionData.identity` stays readable. A `key` field outside a `vpn`
  object stays readable too: it names a 1.6 configuration entry.

This is the rule the structured redactor applies to the `csms_call_received`
payload and to scenario reports ([CLI → CSMS call events](../entities/cli.md#csms-call-events)),
with one predicate for the variable names, so for the fields above a frame's
log line and its event hide the same values. They differ in form: where the
log line shows `[redacted]` for a field named after a secret (`password`,
`apnPassword`, `basicAuthPassword`, `simPin`, `apiKey`, …), the structured redactor
drops the field. Both ignore case, `-` and `_` in a field name (`Password`,
`tls_key`, `authorization_key=…`), but the text redactor is stricter: it
also hides a name that ends in a secret name (`api_password`, `OED_API_KEY`,
`oedApiKey`, `tlsPrivateKey`), where the structured redactor drops only an
exact secret name and keeps such a field (#515). The match is on JSON
object shapes: a SOAP (XML) body does not get it. A duplicated key does not hide a secret — `JSON.parse`
keeps the last copy, so any copy of `key` / `variable` makes the entry
sensitive and every copy of `value` / `attributeValue`, and of the `key` in
every `vpn` member, is redacted. A redacted scalar inside a JSON member
(string, number such as `simPin`, boolean, `null`) becomes the quoted string
`"[redacted]"`, so the frame stays valid JSON: the [trace adapter](trace-format.md#producing-records)
gets no record from a `Sent:` / `Received:` line it cannot parse (#401). An
object or array held by a secret-named member is replaced whole by the same
`"[redacted]"`, so `{"password":{"a":"b"}}` logs `{"password":"[redacted]"}`
(#515). Outside a complete JSON object (non-JSON text, a truncated frame), a
quoted value ends at its first unescaped matching quote (an escaped quote,
`"ab\"cd"`, does not end it). On the value's first line any such quote ends
it. On a later line (after a raw newline, or a backslash before the line
end) it ends the value only when whitespace, `,`, `}`, `]` or the end of the
text follows it and no `:` / `=` (optionally followed by whitespace) precedes
it, so `password="line1\nline2" x` logs `password="[redacted]" x` while the
quote opening the next line's `privateKey="SECRET"` does not end
`password="a` (#401, #519). Nor does it run over another secret-named
assignment (`name=` or `name:`, quoted or bare) before that quote. Without
such a quote, or across such an assignment, the value is redacted to the end
of its first line and the next line's assignments are matched on their own.
A value starting with `-----BEGIN` (a PEM, after optional whitespace) ends
only at a quote that follows its `-----END …-----` marker (a label of
letters, digits, spaces and dots; whitespace or a `\n` / `\r` escape before the
quote) with no secret-named assignment before it, even after a backslash,
whatever quotes its body holds; otherwise the rest of the message is
redacted (#519). Both rules fail closed, so they over-redact: a truncated
value followed by a later line that ends in a delimited quote swallows it
(`password="a\nuser=bob" x` logs `password="[redacted]" x`), and a PEM
without its `-----END …-----"` hides everything after it, later assignments
included — inside a JSON string (a single-quoted
`{"msg":"privateKey='-----BEGIN…'"}`) it also cuts the frame, which then no
longer parses for the trace adapter. Limit: when the quote on a later line is followed by any other
character (`;`, `)`, a letter) or preceded by `=` / `:`, the value is
redacted only to the end of its first line and its later lines stay
readable.

A regex engine may give up on a very long value and report no match where
another completes it: under Bun (JavaScriptCore) a quoted value of some 50k
characters was logged in clear while Node (V8) redacted it (#547). A quoted
secret-named assignment the patterns above left unredacted is therefore cut
again in code, failing closed: the value ends at the first unescaped matching
quote on its first line, and a PEM value, or one with no such quote, is
redacted to the end of the message. Where the patterns completed this changes
nothing. The redaction tests run under both vitest and `bun test`
(`src/cp/shared/redaction.bun.test.ts`).

## WebSocket close lines

Every socket close logs
`WebSocket closed: code=…, reason=…, wasClean=…, cause=…` at INFO
(`WEBSOCKET`). `cause` names who closed it: `network` (the peer or the
network), `manual` (an operator disconnect or a dispose), `internal` (a reset)
or `simulated` (a [network-simulation](network-simulation.md) cut) (#474).

The line can come after the next connection is already open. A socket the
charge point closed itself fires its close asynchronously: a reset, or a
`disconnect` or network-simulation cut followed by a `connect`. When the next connect starts before that close
has landed, the charge point is told then, with `code` 1005: its
`disconnected` event precedes the replacement's `connected`. The late close
only logs this line, with the real code, and leaves the new connection alone
(#478).

## WebSocket handshake failures

A CSMS that refuses the upgrade produces, in CLI/daemon mode:

```
[ERROR] [WebSocket] WebSocket error: WebSocket connection to 'ws://…' failed: Expected 101 status code
[INFO]  [WebSocket] WebSocket closed: code=1002, reason=Expected 101 status code, wasClean=false, cause=network
[ERROR] [WebSocket] WebSocket upgrade refused: HTTP 401 — credentials refused, or the CSMS considers the connection insecure for its security profile (diagnostic GET after the handshake failed)
```

The third line is the one that names the cause (#288). It exists because the
runtime will not: Bun's native WebSocket reports 401, 404 and a 301 redirect
with the identical `code=1002, Expected 101 status code`, so after a refused
handshake the daemon replays it as one plain `GET` with the same headers and
logs the status that comes back. A `3xx` also logs its `Location`, which is
what a cleartext `ws://` to a TLS-only edge looks like.

Two properties worth knowing, because the line is a diagnostic and not a
protocol event:

- **It costs one extra request, and only on failure.** The probe runs at most
  once a minute per charge point and resets on a successful open, so the
  reconnect loop does not multiply the CSMS's request rate. A close that is
  not a refused upgrade (a TCP failure, a TLS failure) never triggers it.
- **It never follows a redirect**, so the station's credentials are not
  forwarded to whatever host `Location` names.

Under Node the `ws` client reports the status itself and no probe is made.
Browser local mode has neither: the DOM `WebSocket` hides the handshake, which
is why this is a daemon-side line only.

## "No handler for action result"

On OCPP 1.6J, `[WARN] [OCPP] No handler for action result: <action>` means the
CSMS answered a CALL the station sent and nothing on the station consumes that
answer. Five CP-initiated notifications whose confirmation is empty by spec
had no result handler before #407 and logged it on every normal
acknowledgement: `FirmwareStatusNotification`, `DiagnosticsStatusNotification`
(1.6 core), `SecurityEventNotification`, `LogStatusNotification`,
`SignedFirmwareStatusNotification` (Security Whitepaper). They now log
`<action> acknowledged` at DEBUG, so a reconnect-heavy station does not
inflate the WARN rate. They are not the only empty 1.6 confirmations:
`StatusNotification.conf` and `MeterValues.conf` are empty too, and already
had their own result handlers, which log at DEBUG.

`SignCertificate.conf` is not empty: it carries a `status`. Since #410 it has
its own result handler too. `Accepted` logs
`SignCertificate accepted by the CSMS; awaiting CertificateSigned.req` at INFO;
any other status (`Rejected`, or a value outside the spec) logs
`SignCertificate not accepted by the CSMS (status <status>); certificate renewal will not happen`
at WARN. The status is only logged: the `sign_certificate` method and
`ExtendedTriggerMessage(SignChargePointCertificate)` still return once the
request is queued, without the answer. With it, each of the 14 station-initiated
1.6J actions listed in [Expert OCPP calls](expert-ocpp-calls.md#what-is-sent)
has a result handler, so none of them logs the warning on its answer. OCPP 2.x
and the SOAP transports never log this line. Since #456 the 2.x handler logs
its own `SignCertificateResponse` lines:
`[v2.0.1] SignCertificate accepted by the CSMS; awaiting CertificateSigned` at
INFO, otherwise
`[v2.0.1] SignCertificate not accepted by the CSMS (status <status>); the CSR stays pending`
at WARN ([Security profiles](security-profiles.md#ocpp-201-and-21-behaviour)).

## Related RPC methods

| Method        | Params                                                                               | Returns / purpose                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `logs.get`    | `{ "cpId": string, "limit"?: number, "offset"?: number, "order"?: "asc" \| "desc" }` | Log rows for the CP. Falls back to the in-memory Logger buffer when `--state-db` is not set. See [Log windowing](#log-windowing). |
| `logs.clear`  | `{ "cpId": string }`                                                                 | Delete the persisted log rows for the CP.                                                                                         |
| `state.reset` | `{}`                                                                                 | Truncate every simulator-owned table (logs included), then disconnect/forget every in-memory CP. Schema is preserved.             |

### Log windowing

`limit` selects the **most recent** N entries, not the oldest — so
`{"limit": 200}` answers "what just happened?" on a charge point that has been
up for days.

| Params                            | Returns                                                     |
| --------------------------------- | ----------------------------------------------------------- |
| _(none)_                          | Every entry, oldest first.                                  |
| `{"limit": 100}`                  | The newest 100, oldest first within the window.             |
| `{"limit": 100, "offset": 100}`   | The 100 entries before those — `offset` pages back in time. |
| `{"limit": 100, "order": "desc"}` | The newest 100, newest first.                               |

> **Changed in 0.7.6.** `limit` used to return the _oldest_ N, which meant no
> limit could reach recent activity on a long-running charge point. A client
> that wants the old behaviour can page from the far end with `offset`, or omit
> `limit` and slice the full result itself. The MCP `get_logs` tool follows the
> same semantics.

## Retention

- Without `--state-db`: a bounded in-memory Logger buffer, lost on restart.
- With `--state-db`: the `logs` table, batched writes (50 entries / 500 ms),
  trimmed to 10 k rows per CP, cleared by `logs.clear` or `state.reset`.
- A `--trace-output` file ([Trace format](trace-format.md)) is the only source
  guaranteed to hold every wire frame since the process last (re)started.
