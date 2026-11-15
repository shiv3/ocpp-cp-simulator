import { DEFAULT_HTTP_PORT } from "../server/startServer";

export function printUsage(): void {
  process.stderr.write(`
Usage: ocpp-cp-sim [options]    (or "bun apps/cli/src/main.ts [options]" from a checkout)

Local modes (single CP, no server):
  --cp-id <id> --ws-url <url>                Interactive REPL (default)
  --cp-id <id> --ws-url <url> --json         JSON Lines mode

Server modes (HTTP/WebSocket, multi-CP):
  --daemon [--cp-id X --ws-url Y]                  Background TCP server (127.0.0.1:${DEFAULT_HTTP_PORT})
  --cp-count N [--cp-id-pattern CP{n:03}]          Bootstrap N charge points instead of one
  --label KEY=VALUE                                Label every bootstrapped charge point (repeatable)
  --metrics [--metrics-no-auth]                    Serve Prometheus text exposition at GET /metrics
  --watch                                          Re-read loaded idTag and scenario files when they change
  --daemon --http-port P [--cp-id ...]             Background TCP server on port P
  --http-port P [--cp-id ...]                      Foreground TCP server

Client modes (talk to a running server):
  --send <json> --cp-id <id> [target]        Send command to a CP
  --events --cp-id <id> [target]             Subscribe per-CP events
  --events --all [target]                    Subscribe all-CP events
  --stop [target]                            Shut down the server

  [target] = --http-url http://host:port  (default http://127.0.0.1:${DEFAULT_HTTP_PORT})

Options:
  --cp-id <id>             Charge Point ID
  --ws-url <url>           WebSocket URL of CSMS
  --connectors <n>         Number of connectors (default: 1)
  --cp-count <n>           Server mode: bootstrap N charge points instead of
                           one, sharing every option but the id. Requires
                           --cp-id as the id stem and a server mode.
  --cp-id-pattern <tpl>    Id template used with --cp-count (default:
                           <cp-id>{n:03}). {n} is the index, {n:03} zero-pads
                           it.
  --fleet-template <file>  Server mode: load fleet template(s) from a JSON file
                           (one template or an array; repeatable). Read-only;
                           list and instantiate with fleet.template.* /
                           fleet.create.
  --bootstrap-concurrency <n>
                           Server mode: charge points started at once
                           (default: 8).
  --start-delay <ms>       Server mode: milliseconds between the scheduled
                           starts of consecutive charge points (default: 0).
  --start-jitter <ms>      Server mode: push each start back by a seeded
                           random 0..ms-1 (default: 0).
  --start-seed <n>         Server mode: seed of --start-jitter (default: 0); the same seed
                           gives the same schedule.
  --label <key=value>      Server mode: label every bootstrapped charge point.
                           Repeatable; split on the first '='. Requires
                           --cp-id. A charge point restored from --state-db
                           keeps its stored labels.
  --security-profile <0|1|2|3>
                           OCPP 1.6 security profile. 0 leaves transport/auth
                           as configured; 1 adds AuthorizationKey Basic Auth
                           and keeps the configured ws:// or wss:// scheme;
                           2 forces wss:// + AuthorizationKey Basic Auth +
                           verified server cert; 3 forces wss:// mTLS and
                           suppresses Basic Auth. Profiles never downgrade
                           wss:// to ws://.
  --authorization-key <hex> AuthorizationKey used as Basic Auth password for
                           security profiles 1 and 2 (username is CP ID).
  --tls-ca <path>          PEM CA bundle used to verify the CSMS server cert.
  --tls-cert <path>        PEM client certificate for profile 3 mTLS.
  --tls-key <path>         PEM client private key for profile 3 mTLS.
                           Must be mode 0600 unless
                           --insecure-tls-key-perms is passed.
  --insecure-tls-key-perms Allow --tls-key files readable by group/other.
  --cpo-name <name>        CPO name for generated SignCertificate CSRs.
  --inbound-validation <off|warn|enforce>
                           OCPP 1.6J: what to do with an inbound CALL whose
                           payload breaks the request schema. warn (default)
                           logs and traces the violation and runs the handler;
                           enforce answers a CALLERROR; off skips the check.
  --reservation-authorize-id-tag
                           OCPP 1.6: authorize the idTag of a ReserveNow
                           (local rules, then Authorize.req) before accepting
                           it; a tag that is not Accepted answers Rejected.
                           Off by default.
  --reconnect-max-attempts <n>
                           Reconnect attempts after a connection loss before
                           giving up. -1 = unlimited (default), 0 = never
                           reconnect. Giving up is a gave_up entry in the
                           operational timeline.
  --reconnect-mode <exponential|fixed>
                           exponential (default) doubles the delay up to
                           --reconnect-max-delay-ms; fixed waits
                           --reconnect-base-delay-ms every time. OCPP 2.x
                           follows OCPPCommCtrlr RetryBackOffWaitMinimum /
                           RandomRange / RepeatTimes instead of the base
                           delay and the jitter.
  --reconnect-base-delay-ms <ms>
                           Delay before the first attempt (default 1000).
  --reconnect-max-delay-ms <ms>
                           Cap of the exponential delay (default 30000).
  --reconnect-jitter-ms <ms>
                           Random extra delay in [0, ms] drawn from a stream
                           seeded by the CP id (default 0).
  --ws-handshake-timeout-ms <ms>
                           Close a connection attempt that has not opened
                           within <ms>; the reconnect policy then applies.
                           All runtimes.
  --ws-no-compression      Do not offer permessage-deflate. Bun and Node.
  --ws-max-payload <bytes> Largest incoming message; a bigger one closes the
                           socket. Node only (Bun ignores it, so the start is
                           refused).
  --ws-proxy <url>         HTTP(S) proxy for the WebSocket upgrade (CONNECT).
                           Bun only.
  --ws-local-address <ip>  Local address to bind. Node only (Bun ignores it,
                           so the start is refused).
  --boot-retry-limit <n>   Automatic BootNotification re-sends after a
                           Rejected answer before stopping. -1 = unlimited
                           (default).
  --tx-updated-meter-values
                           OCPP 2.x: send the periodic meter samples taken
                           during a transaction as TransactionEvent(Updated,
                           MeterValuePeriodic) instead of MeterValues.
                           On by default (the flag is accepted for
                           compatibility).
  --no-tx-updated-meter-values
                           OCPP 2.x: opt out; send the periodic samples as
                           standalone MeterValues again.
  --basic-auth-user <u>    Outgoing WS Basic auth username (CP → CSMS)
  --basic-auth-pass <p>    Outgoing WS Basic auth password (CP → CSMS)
  --web-console-basic-auth-user <u>
                           Basic auth user for INCOMING HTTP requests to
                           this daemon (web console / socket.io).
                           Must be supplied together with
                           --web-console-basic-auth-pass. Default: no auth.
  --web-console-basic-auth-pass <p>
                           Basic auth password for INCOMING HTTP. The
                           configured health path (--health-path, default
                           /v1/healthz) is always served without auth so
                           k8s probes / load balancers keep working.
  --http-basic-auth-user <u>
                           Basic auth user the CLIENT modes (--send / --stop /
                           --events) send to a daemon protected by
                           --web-console-basic-auth-*. Pair with
                           --http-basic-auth-pass.
  --http-basic-auth-pass <p>
                           Basic auth password for the client modes (see above).
  --vendor <vendor>        Charge point vendor (default: CLI-Vendor)
  --model <model>          Charge point model (default: CLI-Model)
  --ocpp-version <OCPP-1.2|OCPP-1.5|OCPP-1.6J|OCPP-1.6S|OCPP-2.0.1|OCPP-2.1>
                           OCPP version for a directly-started CP
                           (default: OCPP-1.6J)
  --header KEY:VALUE       Extra header on the outgoing CP -> CSMS WebSocket
                           upgrade. Repeatable.
  --ws-subprotocol <value> Extra subprotocol offered on the outgoing
                           CP -> CSMS WebSocket upgrade. Repeatable.
  --scenario <file>            Run scenario from JSON file on startup
  --scenario-template <id>     Run built-in scenario template on startup
  --scenario-template-file <p> Load a cpId-independent template JSON and apply it
                               to every connector listed in --scenario-connector
  --scenario-connector <list>  Target connectors: "all", a single id ("1"),
                               or a comma-separated list ("1,2,3"). Default: 1
  --http-port <port>       Enable HTTP/WebSocket server on this TCP port
  --http-host <addr>       Bind address for HTTP (default: 127.0.0.1)
  --unix-socket <path|none> Deprecated no-op; accepted for launcher compatibility
  --http-url <url>         Client target: TCP HTTP base URL
  --all                    Use the global event stream (--events only)
  --unsafe-remote          Allow a non-loopback daemon bind without
                           --web-console-basic-auth-user/pass. Use only on
                           trusted networks.
  --behavior <file>        Load behavior code (a TypeScript or JavaScript
                           module whose default export is a behavior) onto
                           every charge point (repeatable). It runs with this
                           process's full authority; see docs/entities/cli.md.
  --allow-behavior-code    A daemon's explicit opt-in to --behavior. Refused
                           together with --unsafe-remote.
  --use-behavior <id>      Run only the loaded behavior with this id on the
                           charge points started from --cp-id (repeatable;
                           default: every --behavior). Charge points created
                           later pick theirs with the "behaviors" parameter
                           or cp.behaviors.set; ids only, never code.
  --behavior-params <id>=<json file or inline json>
                           Params for a behavior on the charge points started
                           from --cp-id (repeatable, one per id): a loaded
                           behavior or a built-in default.*, e.g.
                           --behavior-params 'default.firmware={"stepMs":500}'.
                           JSON only, checked against the behavior's params
                           schema (behavior.list); a value that does not fit
                           is refused, never converted.
  --watch-behaviors        Reload a --behavior file when it (or a file in its
                           directory) changes: new calls use the new code,
                           exchanges in flight finish on the old one, ctx.state
                           stays. A file that does not build keeps the old
                           version. Daemon: also enables the behavior.reload
                           method.
  --allow-behavior-reload  Daemon only: answer the behavior.reload method
                           (re-reads the --behavior files, runs their code)
                           without watching them. Without this flag or
                           --watch-behaviors the method is refused and new
                           code enters only at start.
  --cors-origin <origin>   Restrict CORS to this origin (repeatable). Pass "*"
                           for open CORS. Default: open on a loopback bind;
                           same-origin-only when bound to a non-loopback host
                           (0.0.0.0 / LAN) so cross-site browser calls are
                           rejected, and also same-origin-only with
                           --allow-behavior-code, on any bind (a page in
                           your browser must not drive a daemon that runs
                           code; a web console on another origin then needs
                           --cors-origin <its origin>).
  --trust-forwarded-headers
                           With the same-origin default, also accept the
                           public origin a reverse proxy reports via
                           X-Forwarded-Proto / X-Forwarded-Host. Use only
                           behind a trusted proxy (see docs/concepts/access-control.md).
  --trusted-proxy <ip|cidr>
                           Believe X-Forwarded-* / Forwarded headers only from
                           this peer (repeatable, implies the behavior of
                           --trust-forwarded-headers for those peers). A request
                           whose Forwarded and X-Forwarded-* disagree is refused
                           with 400.
  --allowed-host <name>    Answer only to this Host name (repeatable; IP literals
                           and localhost always pass). Against DNS rebinding.
  --require-tls            Refuse non-loopback clients that did not arrive over
                           TLS as reported by a --trusted-proxy (health exempt).
  --rate-limit-per-ip <n>  Requests per second per client IP (default 0 = off).
  --rate-limit-max-ips <n> Client IPs the limiter tracks (default 10000).
  --log-level <level>      debug (default), info, warn or error: drop console and
                           --log-file lines below it.
  --log-file <path>        Also append console log lines to this file.
  --log-max-size <size>    Rotate --log-file past this size (10m, 512k, bytes).
  --log-rotate-daily       Rotate --log-file when the local date changes.
  --log-keep <n>           Rotated files to keep (default 5).
  --shutdown-stop-transactions
                           On any shutdown (signal, server.shutdown) stop running
                           transactions and wait
                           for the CSMS to answer before exiting.
  --shutdown-wait-ms <ms>  Longest wait for those answers (default 5000); also
                           the wait of cp.delete / disconnect with
                           stopTransactions.
  --no-connect-restored    Restore charge points from --state-db without dialling
                           them (connect with cp.connect).
  --cp-bulk-wait-ms <ms>   Per-charge-point wait of cp.bulk (default 10000).
  --web-console [<port>]   Serve the bundled browser UI alongside socket.io.
                           With <port>: opens a second listener on that port.
                           Without <port>: shares the --http-port listener.
                           Requires the UI to be built (run "bun run build",
                           or use an installed package which ships dist/).
  --web-console-dist <dir>
                           Serve the web console from this directory instead
                           of searching for a bundled dist/. Must contain
                           index.html. The desktop app passes its Tauri
                           resource dir here (docs/entities/desktop-app.md).
  --state-db <path>        Persist Configuration overrides, charging-profile
                           state, scenarios, and pending transaction
                           messages to a SQLite file (or ":memory:").
                           Without this flag the daemon is fully in-memory
                           and forgets everything at exit.
  --log-format <fmt>       "plain" (default) or "json" — output one JSON
                           object per stderr line for structured-log
                           collectors (Loki, jq, etc.).
  --trace-output <path>    Append every OCPP wire message as a JSONL trace
                           record (docs/concepts/trace-format.md) — works in REPL,
                           JSON, and daemon modes.
  analyze <trace.jsonl> [--output <file>] [--format html|markdown]
          [--split-by charge-point|connector]
                           Analyze a trace with OCPP DebugKit and write a
                           report.
  analyze --from-daemon --cp-id <id> [--http-url <url>]
          [--http-basic-auth-user <u> --http-basic-auth-pass <p>]
          [--output <file>] [--format html|markdown]
          [--split-by charge-point|connector]
                           Same report, built from a running daemon's stored
                           logs (the logs.get RPC) instead of a trace file --
                           no --trace-output needed, and no daemon restart.
                           --cp-id is required (logs.get is scoped to one
                           charge point); --http-url defaults to
                           http://127.0.0.1:${DEFAULT_HTTP_PORT}, matching
                           the other client modes (--send/--stop/--events).
                           --split-by connector further splits each charge
                           point's report by connector (default:
                           charge-point, i.e. current behavior). See
                           docs/entities/analyze.md -> "Splitting by
                           connector" for what gets replicated into every
                           connector's report and why.
  behavior build <file> [--out <file>]
                           Type-check a behavior and bundle it (ES2017, k6/* external).
  export-k6 (--scenario <file.json> | --behavior <file>...) [-o <dir>] [--ocpp-version 1.6] [--force]
                           Export a scenario, or behavior code (OCPP 1.6J),
                           as a runnable k6 load-test bundle (entry script +
                           self-contained OCPP runtime + README). Requires
                           k6 >= v1.6 to run the generated test. See
                           docs/entities/cli.md -> export-k6.
  --health-path <path>     Absolute path the health-check JSON is served on
                           (default: /v1/healthz). Change this when running
                           behind a proxy that reserves the default path
                           (e.g. Cloud Run / GFE). The browser UI build must
                           be given the matching VITE_HEALTH_PATH so its
                           remote-mode auto-detect probe lines up.
  --metrics                Server mode: serve GET /metrics (Prometheus text
                           exposition). Off by default; behind the same
                           Basic Auth gate as the rest of the HTTP surface
                           unless --metrics-no-auth is also passed. Refused
                           together with --health-path /metrics.
  --metrics-no-auth        Implies --metrics and serves it outside the
                           Basic Auth gate. Trusted networks only.
  --watch                  Server mode: re-read the idTag and scenario files
                           this daemon loaded when they change on disk,
                           debounced. A parse failure keeps the previous good
                           copy. An idTag pool applies live -- it is drawn once
                           per session, so an open transaction keeps the tag it
                           presented and the next draw sees the new list. A
                           scenario reload is held while that connector has an
                           open transaction or a run of it is in flight, and
                           applied when that session ends. Off by default;
                           refused outside a server mode and alongside
                           --send/--stop/--events.
  --soap-callback-url <url>
                           SOAP ChargePointService callback URL for OCPP 1.2, 1.5,
                           or 1.6S. Required for SOAP versions unless
                           --soap-public-base-url is given instead.
  --soap-public-base-url <url>
                           Public base URL (e.g. a tunnel origin) the CSMS can
                           reach; the full callback URL is derived as
                           {base}{soap-path}/{cp-id}/ChargePointService. An
                           explicit --soap-callback-url takes precedence.
  --soap-tunnel <none|ngrok>
                           Expose the SOAP callback endpoint through a tunnel
                           and derive the callback URL from its public origin
                           (default: none). Server mode only; cannot be
                           combined with --soap-callback-url or
                           --soap-public-base-url. ngrok runs the ngrok binary
                           from PATH; the public URL is logged at startup and
                           reported by the server.info RPC, and every SOAP
                           charge point created without a callback URL gets
                           one derived from it. The tunnel forwards to a
                           dedicated listener that serves the callback route
                           only; socket.io, the web console and MCP stay on the
                           local listeners.
  --soap-tunnel-port <port>
                           Local port of that dedicated listener (default: 0,
                           a free port). Required with --ngrok-api-url: the
                           running agent forwards to the port it was
                           configured with.
  --ngrok-auth-token <token>
                           ngrok authtoken, handed to the agent through its
                           environment (never on its command line or in logs).
                           Without it the agent uses NGROK_AUTHTOKEN or its
                           own config file.
  --ngrok-domain <domain>  Reserved ngrok domain to request (ngrok http --url).
                           Free-tier URLs change between runs.
  --ngrok-api-url <url>    Attach to an already-running ngrok agent (e.g. a
                           Docker sidecar: http://ngrok:4040) instead of
                           spawning one; the https tunnel forwarding to the
                           listener port is used. Incompatible with the two
                           options above.
  --soap-path <path>       Base path reserved for the SOAP callback server
                           (default: /ocpp/soap).
                           OCPP-S has no per-message auth: on the daemon's
                           listeners rely on --web-console-basic-auth-* or a
                           trusted network; the --soap-tunnel listener has
                           neither, only the route's identity check, so put a
                           boundary (ngrok traffic policy, allow-list) in front.
  --oed-base-url <url|none>
                           Open EV Directory API to import vehicle profiles
                           from (server mode). Also OED_BASE_URL. Default: the
                           public https://evdb.juherr.dev, called only when a
                           user imports; none turns import off. The console
                           imports through the daemon, so the API key stays
                           on the server.
  --oed-api-key-file <path>
                           File holding your personal Open EV Directory API
                           key (optional: the catalog is anonymous; keys are
                           provisioned by its operator, see
                           https://github.com/juherr/open-ev-directory#api-keys).
                           Also OED_API_KEY_FILE, or the key itself in
                           OED_API_KEY. There is no flag taking the key: a
                           command line is visible in ps.
  -h, --help               Show this help

HTTP endpoints (see docs/entities/daemon.md):
  GET    /v1/healthz       (or whatever --health-path is set to)
  GET    /socket.io/       Socket.IO / Engine.IO transport
  POST   /socket.io/       Socket.IO / Engine.IO transport
  POST   /mcp             MCP (Model Context Protocol) Streamable HTTP endpoint
`);
}
