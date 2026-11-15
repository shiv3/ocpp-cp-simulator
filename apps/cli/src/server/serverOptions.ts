import type { ChargePointInitOptions, SoapTunnelConfig } from "../types";
import type { BehaviorLibrary } from "../behavior/BehaviorLibrary";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import type { FleetTemplate } from "@ocpp-cp-simulator/contracts/index";
import type { VehicleCatalogConfig } from "../vehicleCatalogConfig";
import type { CorsPolicy } from "./httpServer";
import type { AccessGuardOptions } from "./accessGuard";
import type { BootstrapPacing } from "./bootstrapPacing";
import type { startSoapTunnel } from "../soapTunnel";

export interface ServerOptions {
  readonly httpPort: number | null;
  readonly httpHost: string;
  readonly pidPath: string | null;
  readonly bootstrap: ChargePointInitOptions | null;
  /**
   * Number of charge points to bootstrap from `bootstrap`. Above 1 the `cpId`
   * is replaced by `bootstrapIdPattern` expanded per index; the rest of the
   * options are shared. Mirrors the `cp.create_many` RPC so a CI job gets the
   * same fleet from a flag as from the control plane.
   */
  readonly bootstrapCount?: number;
  readonly bootstrapIdPattern?: string;
  /** Templates read from `--fleet-template` files (#445); read-only. */
  readonly fleetTemplates?: readonly FleetTemplate[];
  /**
   * How the fleet starts: concurrency, delay between starts and seeded jitter
   * (#610). Absent: 8 at a time with no delay, as before.
   */
  readonly bootstrapPacing?: BootstrapPacing;
  /**
   * SOAP callback inputs, kept unresolved so a fleet can derive one address
   * per charge point. `bootstrap.soapCallbackUrl` is already resolved for the
   * single-CP case and stays authoritative there.
   */
  readonly soapCallbackUrlExplicit?: string | null;
  readonly soapPublicBaseUrl?: string | null;
  /**
   * #458: the Open EV Directory API the console imports vehicle profiles
   * through, with the daemon's API key. Null or absent: import is off and
   * `vehicle_catalog.*` answers `unavailable`.
   */
  readonly vehicleCatalog?: VehicleCatalogConfig | null;
  /** `--soap-path`; the daemon-wide default for derived callback URLs. */
  readonly soapPath: string;
  /**
   * `--soap-tunnel ngrok` (#183): bind a listener that serves the SOAP
   * callback route and nothing else, expose it through ngrok, and use the
   * tunnel's public origin as the SOAP public base. Refused together with
   * `soapCallbackUrlExplicit` / `soapPublicBaseUrl`, as the CLI does.
   */
  readonly soapTunnel?: SoapTunnelConfig | null;
  /**
   * The tunnel provider; `startSoapTunnel` (ngrok) unless a caller supplies
   * another. Tests hand in one that needs no agent.
   */
  readonly startSoapTunnel?: typeof startSoapTunnel;
  /** Serve `GET /metrics`. Off by default; `--metrics` turns it on. */
  readonly metrics?: boolean;
  /**
   * Serve `/metrics` outside the Basic Auth gate. Opt-in for a trusted
   * network — the default is that the gate covers it, unlike the health path.
   */
  readonly metricsNoAuth?: boolean;
  /**
   * Behavior code (`--behavior`) loaded onto every charge point of the
   * daemon, restored and created over RPC included. It runs with the
   * process's authority, so the daemon refuses it unless
   * {@link allowBehaviorCode} is set (`--allow-behavior-code`).
   */
  readonly behaviors?: BehaviorLibrary | readonly Behavior[];
  /** `--watch-behaviors`: reload a behavior file when it changes. */
  readonly watchBehaviors?: boolean;
  /**
   * `--allow-behavior-reload`: answer `behavior.reload` without watching. The
   * method also works with {@link watchBehaviors}. Otherwise it is refused: new
   * code enters a running daemon only when the operator asked for it.
   */
  readonly allowBehaviorReload?: boolean;
  readonly allowBehaviorCode?: boolean;
  readonly autoConnect: boolean;
  readonly startupScenario: {
    readonly scenario: string | null;
    readonly scenarioTemplate: string | null;
    readonly scenarioTemplateFile: string | null;
    /** "all" | "1" | "1,2,3" — resolved to a list of connector ids at startup. */
    readonly scenarioConnector: string;
  } | null;
  readonly cors: CorsPolicy;
  /**
   * If set, non-/v1 GETs are served from this directory (SPA aware).
   * Lets you ship the daemon and the browser UI in one process.
   */
  readonly staticDir: string | null;
  /**
   * Optional second HTTP listener for the bundled web console. If equal
   * to `httpPort`, a single listener serves both socket.io/health and UI. If different,
   * a second listener is bound to this port (the UI is also exposed on
   * that port together with socket.io/health so the browser can reach both at the
   * same origin).
   */
  readonly webConsolePort: number | null;
  /** Filesystem path for the SQLite state DB. `null` means run in memory
   *  — handy for tests / one-off CSMS probes; durable persistence is off. */
  readonly stateDb: string | null;
  /** Absolute URL path the health-check JSON is served on. Defaults to
   *  `/v1/healthz` (set by the CLI). */
  readonly healthPath: string;
  /** Optional Basic Auth credentials for the inbound HTTP server (web
   *  console / non-health HTTP). Health path is exempt. Null = no
   *  auth. Plumbed straight through to `createHttpHandlers`. */
  readonly webConsoleBasicAuth: {
    readonly username: string;
    readonly password: string;
  } | null;
  readonly insecureTlsKeyPerms: boolean;
  /**
   * #620: Host allowlist, trusted proxies, TLS requirement and per-IP rate
   * limit on the HTTP listeners. Absent or all-empty = none of them.
   */
  readonly access?: AccessGuardOptions;
  /**
   * #622: on SIGINT / SIGTERM stop every running transaction and wait up to
   * `waitMs` for the CSMS to receive the stops before the process exits.
   * Absent = exit at once, as before.
   */
  readonly shutdownStopTransactions?: { readonly waitMs: number };
  /**
   * `--shutdown-wait-ms`, also the wait of an opt-in `stopTransactions` on
   * `cp.delete` / `disconnect`, which does not need
   * `--shutdown-stop-transactions`. Default 5000.
   */
  readonly shutdownWaitMs?: number;
  /**
   * #622: `false` rebuilds the charge points of `--state-db` without dialling
   * them (operators connect them with `cp.connect`). Default `true`.
   */
  readonly connectRestored?: boolean;
  /** #622: `cp.bulk` per-charge-point wait (ms). Default `CP_BULK_WAIT_MS`. */
  readonly cpBulkWaitMs?: number;
  /**
   * Re-read the blueprint-instantiated idTag files and scenario files this
   * process loaded when they change on disk (#314). Off by default: a daemon
   * that silently re-reads files under the operator is surprising, and the
   * agent-driven workflows this project is built around go through the control
   * plane, where there is nothing on disk to re-read.
   */
  readonly watch?: boolean;
}

/** What `startServer` hands back: the bound ports and a way to stop it all. */
export interface RunningServer {
  /** Port the API listener bound (`httpPort`, resolved when it was 0); null without one. */
  readonly httpPort: number | null;
  /** Port of the SOAP-only listener the tunnel forwards to; null without a tunnel. */
  readonly soapCallbackPort: number | null;
  /** Stops every listener, the tunnel and the charge points without exiting the process. */
  stop(): void;
}
