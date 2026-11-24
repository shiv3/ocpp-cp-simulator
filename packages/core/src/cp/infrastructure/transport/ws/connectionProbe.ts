/**
 * #1132 — a one-shot connection check: would a station with these settings
 * get in?
 *
 * Opens one WebSocket exactly as the charge point would (`openOcppWebSocket`:
 * same URL composition, subprotocols, Basic Auth, TLS and `transport.ws`
 * options), waits for it to open or fail, and closes it. No OCPP message is
 * sent. The failure is read with the transport's own classifier
 * (`classifyFailedAttempt`) and, when the client hides the status of a refused
 * upgrade (Bun), with the same diagnostic GET the charge point makes
 * (`probeUpgradeRefusal`).
 */
import type {
  ConnectionProbeCode,
  ConnectionProbeResult,
  ConnectionProbeStage,
} from "@ocpp-cp-simulator/contracts/connectionProbe";
import { CONNECTION_PROBE_DEFAULT_TIMEOUT_MS } from "@ocpp-cp-simulator/contracts/connectionProbe";
import type { OcppTlsOptions } from "../../../domain/transport/ConnectionSecurity";
import type { WsClientOptions } from "../../../shared/WsClientOptions";
import { redactSensitiveText } from "../../../shared/redaction";
import {
  OcppSecurityProfileConfigError,
  openOcppWebSocket,
  probeUpgradeRefusal,
  type BasicAuthSettings,
  type OcppSecurityProfile,
  type OcppSocket,
  type OcppWebSocketConnectOptions,
  type UpgradeRefusalDetail,
} from "../wsUrlWithBasic";
import {
  classifyFailedAttempt,
  describeConnectError,
  describeRefusal,
  type ConnectErrorDetail,
} from "./closeClassification";

export interface ConnectionProbeInput {
  readonly baseUrl: string;
  readonly chargePointId: string;
  readonly ocppVersion?: string;
  readonly basicAuth: BasicAuthSettings | null;
  readonly securityProfile?: OcppSecurityProfile;
  readonly authorizationKey?: string;
  readonly tls?: OcppTlsOptions;
  readonly ws?: WsClientOptions;
  readonly extraHeaders?: Record<string, string>;
  readonly extraSubprotocols?: ReadonlyArray<string>;
  /** Handshake budget; defaults to `ws.handshakeTimeoutMs`, then 8 s. */
  readonly timeoutMs?: number;
  /** Warnings the caller already has (e.g. a URL list cut to its first). */
  readonly warnings?: ReadonlyArray<string>;
}

export interface ConnectionProbeDeps {
  /**
   * Resolves a host name; rejects when it does not resolve. Core cannot reach
   * the resolver itself (it runs in the browser too), so the runtime passes
   * one in. Without it a Bun "Failed to connect" reads as connection_refused.
   */
  readonly lookup?: (hostname: string) => Promise<void>;
  /** The diagnostic GET of a refused upgrade whose status the client hid. */
  readonly refusalProbe?: (
    options: OcppWebSocketConnectOptions,
  ) => Promise<UpgradeRefusalDetail | null>;
}

interface Verdict {
  readonly code: ConnectionProbeCode;
  readonly stage: ConnectionProbeStage;
  readonly message: string;
  readonly hint?: string;
  readonly httpStatus?: number;
  readonly location?: string;
  readonly subprotocol?: string;
}

/** At least this long is left for the diagnostic GET after a refusal. */
const MIN_REFUSAL_PROBE_MS = 1_000;

export async function probeConnection(
  input: ConnectionProbeInput,
  deps: ConnectionProbeDeps = {},
): Promise<ConnectionProbeResult> {
  const startedAt = Date.now();
  const timeoutMs =
    input.timeoutMs ??
    input.ws?.handshakeTimeoutMs ??
    CONNECTION_PROBE_DEFAULT_TIMEOUT_MS;
  const warnings: string[] = [...(input.warnings ?? [])];
  // Filled by the socket factory; read after the attempt (an object, so the
  // callback's assignment is not narrowed away).
  const dialled: { options: OcppWebSocketConnectOptions | null } = {
    options: null,
  };
  const finish = (verdict: Verdict): ConnectionProbeResult => ({
    ok: verdict.code === "ok",
    ...verdict,
    message: redactSensitiveText(verdict.message),
    // The dialled URL, with a `user:password@` password replaced.
    url: redactSensitiveText(dialled.options?.url ?? input.baseUrl),
    ...(verdict.location
      ? { location: redactSensitiveText(verdict.location) }
      : {}),
    offeredSubprotocols: [...(dialled.options?.protocols ?? [])],
    durationMs: Date.now() - startedAt,
    warnings,
  });

  const configProblem = checkConfig(input);
  if (configProblem) return finish(configProblem);
  const doubled = doubledIdWarning(input.baseUrl, input.chargePointId);
  if (doubled) warnings.push(doubled);

  const attempt = await new Promise<AttemptOutcome>((resolve) => {
    let settled = false;
    let socket: OcppSocket | null = null;
    let firstError: ConnectErrorDetail | undefined;
    const settle = (outcome: AttemptOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      settle({ kind: "timeout" });
      closeQuietly(socket);
    }, timeoutMs);
    try {
      socket = openOcppWebSocket({
        baseUrl: input.baseUrl,
        chargePointId: input.chargePointId,
        basicAuth: input.basicAuth,
        extraHeaders: input.extraHeaders,
        extraSubprotocols: input.extraSubprotocols,
        ocppVersion: input.ocppVersion,
        securityProfile: input.securityProfile,
        authorizationKey: input.authorizationKey,
        tls: input.tls,
        ...(input.ws ? { ws: input.ws } : {}),
        warn: (message) => warnings.push(message),
        onConnectOptions: (options) => {
          dialled.options = options;
        },
        onopen: () => {
          const protocol = socket?.protocol ?? "";
          settle({ kind: "open", protocol });
          // Closed at once: the CSMS sees a handshake and a normal close.
          closeQuietly(socket, 1000);
        },
        onerror: (ev) => {
          firstError ??= describeConnectError(ev);
        },
        onclose: (ev) => {
          settle({
            kind: "failed",
            close: { code: ev.code, reason: ev.reason ?? "" },
            error: firstError,
          });
        },
      });
    } catch (error) {
      settle({ kind: "threw", error });
    }
  });

  if (attempt.kind === "threw") {
    return finish(thrownVerdict(attempt.error));
  }
  if (attempt.kind === "timeout") {
    return finish({
      code: "timeout",
      stage: "handshake",
      message: `No WebSocket handshake completed within ${timeoutMs} ms`,
      hint: "Nothing answered in time: a firewall dropping packets, a wrong port, or a server that accepted the connection and never replied",
    });
  }
  if (attempt.kind === "open") {
    return finish(
      openVerdict(attempt.protocol, dialled.options?.protocols ?? []),
    );
  }
  return finish(
    await failedVerdict(attempt, input, dialled.options, {
      lookup: deps.lookup,
      refusalProbe: deps.refusalProbe ?? probeUpgradeRefusal,
      budgetMs: Math.max(
        MIN_REFUSAL_PROBE_MS,
        timeoutMs - (Date.now() - startedAt),
      ),
    }),
  );
}

type AttemptOutcome =
  | { kind: "open"; protocol: string }
  | {
      kind: "failed";
      close: { code: number; reason: string };
      error?: ConnectErrorDetail;
    }
  | { kind: "timeout" }
  | { kind: "threw"; error: unknown };

function closeQuietly(socket: OcppSocket | null, code?: number): void {
  try {
    socket?.close(code);
  } catch {
    // A socket still connecting may refuse a close; it is abandoned anyway.
  }
}

/** Refusals that need no network: a URL or security setup that cannot work. */
function checkConfig(input: ConnectionProbeInput): Verdict | null {
  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch {
    return {
      code: "invalid_url",
      stage: "config",
      message: "The CSMS URL does not parse as a URL",
      hint: "Use ws://host[:port]/path or wss://host[:port]/path; the charge point id is appended",
    };
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    return {
      code: "invalid_url",
      stage: "config",
      message: `The CSMS URL has scheme ${url.protocol}; OCPP-J needs ws:// or wss://`,
    };
  }
  if (
    input.securityProfile === 3 &&
    !(input.tls?.cert !== undefined && input.tls.key !== undefined)
  ) {
    return {
      code: "invalid_security_profile",
      stage: "config",
      message:
        "Security profile 3 requires a client certificate and its private key",
    };
  }
  return null;
}

/**
 * The station appends its id to the URL, so a URL that already ends with it
 * reaches `/…/CP001/CP001` — a common mistake that most CSMS answer with 404.
 */
export function doubledIdWarning(
  baseUrl: string,
  chargePointId: string,
): string | null {
  let last: string | undefined;
  try {
    last = new URL(baseUrl).pathname.split("/").filter(Boolean).pop();
  } catch {
    return null;
  }
  if (last === undefined) return null;
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // keep the raw segment
  }
  if (decoded !== chargePointId) return null;
  return `The URL already ends with the charge point id "${chargePointId}"; the id is appended once more, so the path ends in /${last}/${last}. Drop it from the URL unless the CSMS really expects it twice.`;
}

function thrownVerdict(error: unknown): Verdict {
  if (error instanceof OcppSecurityProfileConfigError) {
    return {
      code: "invalid_security_profile",
      stage: "config",
      message: error.message,
    };
  }
  return {
    code: "invalid_url",
    stage: "config",
    message: `Cannot open the connection: ${error instanceof Error ? error.message : String(error)}`,
  };
}

function openVerdict(
  protocol: string,
  offered: ReadonlyArray<string>,
): Verdict {
  if (offered.length > 0 && !offered.includes(protocol)) {
    return subprotocolVerdict(offered, protocol);
  }
  return {
    code: "ok",
    stage: "open",
    message: protocol
      ? `WebSocket opened; the CSMS agreed to subprotocol ${protocol}`
      : "WebSocket opened",
    ...(protocol ? { subprotocol: protocol } : {}),
  };
}

function subprotocolVerdict(
  offered: ReadonlyArray<string>,
  answered?: string,
): Verdict {
  return {
    code: "subprotocol_not_agreed",
    stage: "subprotocol",
    message: answered
      ? `The CSMS answered subprotocol ${answered}, which was not offered (${offered.join(", ")})`
      : `The CSMS did not agree to the offered subprotocol (${offered.join(", ") || "none"})`,
    hint: "The CSMS does not accept this OCPP version on this endpoint; check the version, or the endpoint for this version",
  };
}

/** Bun 1.4.3 and earlier close a refused subprotocol with 1002 and one of
 *  these; the `ws` path errors with "Server sent no/an invalid subprotocol". */
const SUBPROTOCOL_FAILURE =
  /(missing|mismatch) client protocol|server sent (no|an invalid) subprotocol/i;
/** Bun 1.4.4 quotes the status of a refused upgrade in the error message. */
const QUOTED_STATUS = /expected 101 status code:\s*(\d{3})/i;
const CERTIFICATE_CODE = /CERT|^UNABLE_TO_|SELF_SIGNED/;
const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME"]);

interface FailureDeps {
  readonly lookup?: (hostname: string) => Promise<void>;
  readonly refusalProbe: (
    options: OcppWebSocketConnectOptions,
  ) => Promise<UpgradeRefusalDetail | null>;
  readonly budgetMs: number;
}

async function failedVerdict(
  attempt: Extract<AttemptOutcome, { kind: "failed" }>,
  input: ConnectionProbeInput,
  options: OcppWebSocketConnectOptions | null,
  deps: FailureDeps,
): Promise<Verdict> {
  const { close, error } = attempt;
  const text = `${error?.message ?? ""} ${close.reason}`;
  if (SUBPROTOCOL_FAILURE.test(text)) {
    return subprotocolVerdict(options?.protocols ?? []);
  }
  if (error?.code?.startsWith("HPE_")) return notWebSocketVerdict();
  const kind = classifyFailedAttempt(close, error);
  if (kind === "unreached") return unreachedVerdict(input, error, deps);
  if (kind === "tls") return tlsVerdict(error);
  if (kind === "upgrade-refused") {
    let status = error?.httpStatus;
    let location = error?.httpLocation;
    const quoted = QUOTED_STATUS.exec(error?.message ?? "");
    if (status === undefined && quoted) status = Number(quoted[1]);
    // Bun hides the status (1.4.3) or the redirect target (1.4.4): ask.
    const isRedirect = status !== undefined && status >= 300 && status < 400;
    if (options && (status === undefined || (isRedirect && !location))) {
      const detail = await withBudget(
        deps.refusalProbe(options),
        deps.budgetMs,
      );
      if (detail) {
        status = detail.status;
        location = detail.location ?? location;
      }
    }
    return refusalVerdict(status, location);
  }
  // A reset after the TCP connect: on wss:// this is how a CSMS refusing the
  // client certificate looks (Bun: "Connection ended", ws: ECONNRESET).
  if (options?.url.startsWith("wss:")) {
    return {
      code: "tls_failed",
      stage: "tls",
      message: `The connection was closed during the handshake (code ${close.code}${close.reason ? `, ${close.reason}` : ""}${error?.code ? `, ${error.code}` : ""})`,
      hint: "On wss:// this is how a CSMS refusing the client certificate (security profile 3) usually looks",
    };
  }
  return {
    code: "connection_failed",
    stage: "handshake",
    message: `The connection failed (code ${close.code}${close.reason ? `, ${close.reason}` : ""}${error?.message ? `: ${error.message}` : ""})`,
  };
}

async function unreachedVerdict(
  input: ConnectionProbeInput,
  error: ConnectErrorDetail | undefined,
  deps: FailureDeps,
): Promise<Verdict> {
  const code = error?.code;
  let host = "";
  try {
    host = new URL(input.baseUrl).hostname;
  } catch {
    // checked before dialling
  }
  const dns: Verdict = {
    code: "dns_failure",
    stage: "dns",
    message: `The host name ${host} does not resolve`,
    hint: "Check the host name, or the DNS this process uses",
  };
  if (
    (code !== undefined && DNS_CODES.has(code)) ||
    error?.syscall === "getaddrinfo"
  ) {
    return dns;
  }
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return {
      code: "host_unreachable",
      stage: "tcp",
      message: `No route to ${host} (${code})`,
      hint: "Check the network path, VPN or firewall between this process and the CSMS",
    };
  }
  // Bun 1.4.3 and earlier say "Failed to connect" for both a refused port and
  // a name that does not resolve: resolve the name to tell them apart. Behind
  // a proxy the proxy resolves it, and an IP literal needs no lookup.
  if (
    code === undefined &&
    deps.lookup &&
    !input.ws?.proxy &&
    !isIpLiteral(host)
  ) {
    try {
      await deps.lookup(host);
    } catch {
      return dns;
    }
  }
  return {
    code: "connection_refused",
    stage: "tcp",
    message: `Nothing accepted the TCP connection to ${hostPort(input.baseUrl)}${code ? ` (${code})` : ""}`,
    hint: "Check the port and that the CSMS is running and reachable from here",
  };
}

function tlsVerdict(error: ConnectErrorDetail | undefined): Verdict {
  const code = error?.code;
  if (code !== undefined && CERTIFICATE_CODE.test(code)) {
    return {
      code: "tls_untrusted_certificate",
      stage: "tls",
      message: `The CSMS certificate is not trusted (${code})`,
      hint: "Pass the CA that issued it (tlsCaPath / --tls-ca), or check that the host name matches the certificate",
    };
  }
  return {
    code: "tls_failed",
    stage: "tls",
    message: `The TLS handshake failed${code ? ` (${code})` : error?.message ? `: ${error.message}` : ""}`,
    hint: "An untrusted or mismatched certificate (pass its CA with tlsCaPath / --tls-ca), a refused client certificate, or a port that does not speak TLS",
  };
}

function notWebSocketVerdict(status?: number): Verdict {
  return {
    code: "not_websocket",
    stage: "upgrade",
    message:
      status !== undefined
        ? `The server answered the upgrade with HTTP ${status}: it is not a WebSocket endpoint`
        : "The server did not answer the upgrade as an HTTP server would",
    hint: "The URL reaches a web server, not the CSMS WebSocket endpoint; check the path and port",
    ...(status !== undefined ? { httpStatus: status } : {}),
  };
}

function refusalVerdict(
  status: number | undefined,
  location: string | undefined,
): Verdict {
  if (status === undefined) {
    return {
      code: "upgrade_refused",
      stage: "upgrade",
      message:
        "WebSocket upgrade refused; the HTTP status could not be determined",
    };
  }
  if (status >= 200 && status < 300) return notWebSocketVerdict(status);
  const base = {
    stage: "upgrade" as const,
    message: describeRefusal(status, location),
    httpStatus: status,
    ...(location ? { location } : {}),
  };
  if (status === 401 || status === 403) {
    return {
      ...base,
      code: "credentials_refused",
      hint: "Check the Basic Auth credentials (security profile 1/2: the AuthorizationKey, username = the charge point id) and the security profile the CSMS expects",
    };
  }
  if (status === 404) {
    return {
      ...base,
      code: "path_not_found",
      hint: "The CSMS does not know this charge point id at this path: register the id, or check the URL path",
    };
  }
  if (status === 429 || status === 503) {
    return {
      ...base,
      code: "csms_busy",
      hint: "The CSMS is overloaded or rate-limiting; retry later",
    };
  }
  if (status >= 300 && status < 400) {
    return {
      ...base,
      code: "redirected",
      hint: "Use the URL the CSMS redirects to (often wss:// instead of ws://)",
    };
  }
  return { ...base, code: "upgrade_refused" };
}

async function withBudget<T>(
  promise: Promise<T | null>,
  ms: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
}

function hostPort(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
