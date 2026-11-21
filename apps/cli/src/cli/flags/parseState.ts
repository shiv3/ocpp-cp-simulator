import type { CLIOptions } from "../../types";
import type { InboundValidationMode } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import { DEFAULT_SOAP_PATH } from "../../soapPath";
import { DEFAULT_RATE_LIMIT_MAX_IPS } from "../../server/accessGuard";
import { CP_BULK_WAIT_MS } from "@ocpp-cp-simulator/contracts/limits";

/** Every value `parseArgs()` collects from argv before validating it; the
 *  flag handlers in this directory write here (#877). */
export interface ParseState {
  wsUrl: string;
  cpId: string | null;
  cpCount: number;
  cpIdPattern: string | null;
  readonly fleetTemplateFiles: string[];
  // Fleet startup pacing (#610); `undefined` keeps the built-in default.
  bootstrapConcurrency: string | undefined;
  startDelay: string | undefined;
  startJitter: string | undefined;
  startSeed: string | undefined;
  readonly labelEntries: Array<[string, string]>;
  metrics: boolean;
  metricsNoAuth: boolean;
  watch: boolean;
  connectors: number;
  jsonMode: boolean;
  daemon: boolean;
  send: string | null;
  events: boolean;
  stop: boolean;
  basicAuthUser: string;
  basicAuthPass: string;
  // HTTP web-console Basic Auth credentials. Distinct from basicAuthUser /
  // basicAuthPass above — those are sent on the *outgoing* CP → CSMS WS
  // upgrade; these gate *incoming* HTTP requests to this daemon.
  webConsoleBasicAuthUser: string;
  webConsoleBasicAuthPass: string;
  // Basic Auth the CLI *client* modes (--send/--stop/--events) send TO a
  // daemon protected by --web-console-basic-auth-*. Outbound, mirror image of
  // webConsoleBasicAuth* above (which is the daemon's inbound gate).
  httpBasicAuthUser: string;
  httpBasicAuthPass: string;
  vendor: string;
  model: string;
  ocppVersion: string | undefined;
  scenario: string | null;
  scenarioTemplate: string | null;
  scenarioTemplateFile: string | null;
  scenarioConnector: string;
  httpPort: number | null;
  httpHost: string;
  unixSocket: string | null;
  unixSocketWarningPrinted: boolean;
  httpUrl: string | null;
  allEvents: boolean;
  unsafeRemote: boolean;
  readonly behaviorFiles: string[];
  readonly useBehaviors: string[];
  readonly behaviorParamSpecs: string[];
  watchBehaviors: boolean;
  allowBehaviorReload: boolean;
  allowBehaviorCode: boolean;
  serveStatic: string | null;
  // --web-console: enabled flag + optional explicit port. When the port is
  // omitted (`--web-console` alone), the UI shares the --http-port listener.
  webConsoleEnabled: boolean;
  webConsoleExplicitPort: number | null;
  // Explicit location of the built web console, overriding the search in
  // resolveBundledDist(). The desktop shell passes its Tauri resource dir
  // here because a compiled binary cannot find `dist/` on its own (#319).
  webConsoleDist: string | null;
  stateDb: string | null;
  logFormat: "plain" | "json";
  healthPath: string;
  readonly corsOrigins: string[];
  trustForwardedHeaders: boolean;
  readonly allowedHosts: string[];
  readonly trustedProxies: string[];
  requireTls: boolean;
  rateLimitPerIp: number;
  rateLimitMaxIps: number;
  logLevel: CLIOptions["logLevel"];
  logFile: string | null;
  logMaxBytes: number | null;
  logRotateDaily: boolean;
  logToStderr: boolean;
  logKeep: number;
  shutdownStopTransactions: boolean;
  shutdownWaitMs: number;
  connectRestored: boolean;
  cpBulkWaitMs: number;
  readonly extraWsHeaders: Record<string, string>;
  readonly extraWsSubprotocols: string[];
  soapCallbackUrl: string | null;
  soapPublicBaseUrl: string | null;
  oedBaseUrl: string | null;
  oedApiKeyFile: string | null;
  soapTunnel: "none" | "ngrok";
  soapTunnelPort: number | null;
  readonly ngrok: Record<
    "--ngrok-auth-token" | "--ngrok-domain" | "--ngrok-api-url",
    string | null
  >;
  soapPath: string;
  securityProfile: CLIOptions["securityProfile"];
  authorizationKey: string | undefined;
  tlsCaPath: string | undefined;
  tlsCertPath: string | undefined;
  tlsKeyPath: string | undefined;
  insecureTlsKeyPerms: boolean;
  cpoName: string | undefined;
  txUpdatedMeterValues: boolean | undefined;
  inboundValidation: InboundValidationMode | undefined;
  reservationAuthorizeIdTag: boolean;
  // #609: reconnect flags collect here and are validated as one object below.
  readonly reconnect: Record<string, number | string>;
  // #611: `--ws-*` flags, validated with the reconnect ones.
  readonly wsFlags: Record<string, number | string | boolean>;
  traceOutput: string | null;
}

/** The defaults, before any flag is read. */
export function createParseState(): ParseState {
  return {
    wsUrl: "",
    cpId: null,
    cpCount: 1,
    cpIdPattern: null,
    fleetTemplateFiles: [],
    bootstrapConcurrency: undefined,
    startDelay: undefined,
    startJitter: undefined,
    startSeed: undefined,
    labelEntries: [],
    metrics: false,
    metricsNoAuth: false,
    watch: false,
    connectors: 1,
    jsonMode: false,
    daemon: false,
    send: null,
    events: false,
    stop: false,
    basicAuthUser: "",
    basicAuthPass: "",
    webConsoleBasicAuthUser: "",
    webConsoleBasicAuthPass: "",
    httpBasicAuthUser: "",
    httpBasicAuthPass: "",
    vendor: "CLI-Vendor",
    model: "CLI-Model",
    ocppVersion: undefined,
    scenario: null,
    scenarioTemplate: null,
    scenarioTemplateFile: null,
    scenarioConnector: "1",
    httpPort: null,
    httpHost: "127.0.0.1",
    unixSocket: null,
    unixSocketWarningPrinted: false,
    httpUrl: null,
    allEvents: false,
    unsafeRemote: false,
    behaviorFiles: [],
    useBehaviors: [],
    behaviorParamSpecs: [],
    watchBehaviors: false,
    allowBehaviorReload: false,
    allowBehaviorCode: false,
    serveStatic: null,
    webConsoleEnabled: false,
    webConsoleExplicitPort: null,
    webConsoleDist: null,
    stateDb: null,
    logFormat: "plain",
    healthPath: "/v1/healthz",
    corsOrigins: [],
    trustForwardedHeaders: false,
    allowedHosts: [],
    trustedProxies: [],
    requireTls: false,
    rateLimitPerIp: 0,
    rateLimitMaxIps: DEFAULT_RATE_LIMIT_MAX_IPS,
    logLevel: null,
    logFile: null,
    logMaxBytes: null,
    logRotateDaily: false,
    logToStderr: false,
    logKeep: 5,
    shutdownStopTransactions: false,
    shutdownWaitMs: 5000,
    connectRestored: true,
    cpBulkWaitMs: CP_BULK_WAIT_MS,
    extraWsHeaders: {},
    extraWsSubprotocols: [],
    soapCallbackUrl: null,
    soapPublicBaseUrl: null,
    oedBaseUrl: null,
    oedApiKeyFile: null,
    soapTunnel: "none",
    soapTunnelPort: null,
    ngrok: {
      "--ngrok-auth-token": null,
      "--ngrok-domain": null,
      "--ngrok-api-url": null,
    },
    soapPath: DEFAULT_SOAP_PATH,
    securityProfile: undefined,
    authorizationKey: undefined,
    tlsCaPath: undefined,
    tlsCertPath: undefined,
    tlsKeyPath: undefined,
    insecureTlsKeyPerms: false,
    cpoName: undefined,
    txUpdatedMeterValues: undefined,
    inboundValidation: undefined,
    reservationAuthorizeIdTag: false,
    reconnect: {},
    wsFlags: {},
    traceOutput: null,
  };
}
