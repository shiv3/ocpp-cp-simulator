export interface CLIOptions {
  readonly wsUrl: string;
  readonly cpId: string | null;
  readonly connectors: number;
  readonly jsonMode: boolean;
  readonly daemon: boolean;
  readonly send: string | null;
  readonly events: boolean;
  readonly stop: boolean;
  readonly basicAuth: {
    readonly username: string;
    readonly password: string;
  } | null;
  /** Optional Basic Auth gate for the HTTP web console / API / WS upgrades.
   *  Unrelated to `basicAuth` above (which is for the *outgoing* CP →
   *  CSMS WebSocket). When set, every request to the daemon's HTTP server
   *  except the configured health path must carry a matching
   *  `Authorization: Basic <base64(user:pass)>` header; otherwise the
   *  server returns 401 + `WWW-Authenticate: Basic realm="..."` so
   *  browsers prompt for credentials. */
  readonly webConsoleBasicAuth: {
    readonly username: string;
    readonly password: string;
  } | null;
  readonly vendor: string;
  readonly model: string;
  readonly scenario: string | null;
  readonly scenarioTemplate: string | null;
  /** Path to a JSON file containing a cpId-independent scenario template.
   *  Each entry in `scenarioConnectors` instantiates an independent copy. */
  readonly scenarioTemplateFile: string | null;
  /** Raw connector selector: "all" | "1,2,3" | "1". Resolved at startup
   *  once the bootstrap CP's connector count is known. */
  readonly scenarioConnector: string;
  readonly httpPort: number | null;
  readonly httpHost: string;
  readonly unixSocket: string | null;
  readonly httpUrl: string | null;
  readonly allEvents: boolean;
  readonly corsOrigins: ReadonlyArray<string>;
  /** Absolute or relative path of a directory the daemon serves as static
   *  files (SPA-aware). Null disables static hosting. */
  readonly serveStatic: string | null;
  /** TCP port for the bundled web console. When set, the daemon stands up
   *  an HTTP listener on this port serving both the API and the UI. May
   *  share a port with `httpPort` (one listener) or use its own. */
  readonly webConsolePort: number | null;
  /** Filesystem path for the SQLite state DB. When set, ConfigurationStore
   *  overrides, charging-profile availability, scenario state, and the
   *  pending-message queue all persist there across daemon restarts. When
   *  `null`, the daemon runs entirely in memory (lost on exit) — useful
   *  for tests and one-off CSMS probes. */
  readonly stateDb: string | null;
  /** Console log format. `"plain"` (default) writes the legacy
   *  `[timestamp] [LEVEL] [TYPE] message` lines; `"json"` writes one JSON
   *  object per line for structured-log collectors. */
  readonly logFormat: "plain" | "json";
  /** Absolute path the daemon serves the health-check JSON on. Default
   *  `/v1/healthz`. Made configurable so deployments behind a proxy that
   *  reserves specific paths (e.g. Google Front End in front of Cloud Run)
   *  can move the endpoint off a conflicting path. The same value must be
   *  set as `VITE_HEALTH_PATH` at UI build time so the browser auto-detect
   *  probe targets the same endpoint. */
  readonly healthPath: string;
  /** Repeatable `--header KEY:VALUE` — extra HTTP headers attached to
   *  the WS upgrade. CLI runtime only. See ChargePointInitOptions. */
  readonly extraWsHeaders: Record<string, string>;
  /** Repeatable `--ws-subprotocol TOKEN` — extra subprotocols appended
   *  to the OCPP version subprotocol in the WS upgrade. */
  readonly extraWsSubprotocols: ReadonlyArray<string>;
}

export interface ChargePointInitOptions {
  readonly cpId: string;
  readonly wsUrl: string;
  readonly connectors: number;
  readonly vendor: string;
  readonly model: string;
  readonly basicAuth: {
    readonly username: string;
    readonly password: string;
  } | null;
  readonly bootNotification?: {
    readonly firmwareVersion?: string;
    readonly chargePointSerialNumber?: string;
    readonly chargeBoxSerialNumber?: string;
    readonly meterSerialNumber?: string;
    readonly meterType?: string;
    readonly iccid?: string;
    readonly imsi?: string;
  };
  /** Extra HTTP headers attached to every WS upgrade request (CLI runtime
   *  only — the browser WebSocket constructor can't set arbitrary headers).
   *  Useful for driving a header-routing proxy in front of the CSMS. */
  readonly extraWsHeaders?: Record<string, string>;
  /** Extra Sec-WebSocket-Protocol tokens appended after the OCPP version
   *  subprotocol. OCPP servers pick the first recognised version token
   *  (ocpp1.6 / ocpp2.0.1) and ignore the rest, so any extras are visible
   *  to upstream routers but harmless for OCPP negotiation. */
  readonly extraWsSubprotocols?: ReadonlyArray<string>;
}

export interface JsonCommand {
  readonly id?: string;
  readonly command: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonResponse {
  readonly id: string | null;
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export interface JsonEvent {
  readonly event: string;
  readonly data: unknown;
  readonly timestamp: string;
}

// Re-exported for use across server/browser snapshots. The snapshot fields are
// intentionally untyped beyond `unknown`/`Record` at this layer so the wire
// shape stays JSON-friendly; consumers narrow them to their domain types.
export interface ConnectorStatus {
  readonly id: number;
  readonly status: string;
  readonly availability: string;
  readonly meterValue: number;
  readonly transactionId: number | null;
  readonly soc: number | null;
  readonly mode: string;
  readonly autoResetToAvailable: boolean;
  readonly autoMeterValueConfig: Record<string, unknown> | null;
  readonly evSettings: Record<string, unknown> | null;
  readonly chargingProfile: Record<string, unknown> | null;
  readonly chargingProfiles: ReadonlyArray<Record<string, unknown>>;
  readonly transactionStartTime: string | null;
  readonly transactionTagId: string | null;
  readonly transactionBatteryCapacityKwh: number | null;
}

export interface ChargePointStatus {
  readonly id: string;
  readonly status: string;
  readonly error: string;
  readonly connectors: ReadonlyArray<ConnectorStatus>;
  /** §4.6 Heartbeat state. `intervalSeconds=0` means the CSMS has not
   *  configured a heartbeat (or set it to 0). `lastSentAt` is an ISO-8601
   *  string, or null if no Heartbeat.req has been sent since the daemon
   *  started. Included so the browser can show "last heartbeat 30s ago"
   *  without a separate request. */
  readonly heartbeat?: {
    readonly intervalSeconds: number;
    readonly lastSentAt: string | null;
  };
  /** Snapshot of the init the CP was constructed with. Surfaced so the
   *  web console can prefill the "Edit CP" modal in Remote mode without
   *  needing a second roundtrip — local-mode persistence is already in
   *  the browser, so this field is only meaningful when talking to the
   *  daemon. Optional for back-compat with older daemons. */
  readonly config?: {
    readonly wsUrl: string;
    readonly connectors: number;
    readonly vendor: string;
    readonly model: string;
    readonly basicAuth: {
      readonly username: string;
      readonly password: string;
    } | null;
    readonly bootNotification: {
      readonly firmwareVersion?: string;
      readonly chargePointSerialNumber?: string;
      readonly chargeBoxSerialNumber?: string;
      readonly meterSerialNumber?: string;
      readonly meterType?: string;
      readonly iccid?: string;
      readonly imsi?: string;
    } | null;
  };
}
