/**
 * SOAP callback exposure through an ngrok tunnel (issue #183).
 *
 * This is step 3 of the precedence ladder in `soapCallbackUrl.ts`: the
 * provider yields a public base URL, and the callback URL is then derived
 * from it exactly as for `--soap-public-base-url`.
 *
 * Two modes, both without an npm dependency:
 *
 *   spawn  — run the `ngrok` binary from PATH (`ngrok http <host>:<port>`)
 *            and read the public URL from its JSON log. The daemon owns the
 *            process and kills it on shutdown. The auth token, when given,
 *            travels through the child's environment (`NGROK_AUTHTOKEN`),
 *            never on argv, so it does not show in `ps` or the logs.
 *   attach — `--ngrok-api-url`: read the public URL from the local API of an
 *            agent someone else started (typically an `ngrok/ngrok` sidecar
 *            container). Nothing to clean up: we did not create the tunnel.
 */

import { redactSensitiveText } from "../cp/shared/redaction";
import { isHttpUrl } from "./soapCallbackUrl";
import { SOAP_SERVICE_SUFFIX, normalizeSoapPath } from "./soapPath";

/** Default local address of the ngrok agent API (`web_addr`). */
export const NGROK_DEFAULT_API_URL = "http://127.0.0.1:4040";

const DEFAULT_TIMEOUT_MS = 15_000;
/** How long to wait for stderr to drain once the agent has exited. */
const STDERR_DRAIN_MS = 200;

export interface SoapTunnel {
  readonly provider: "ngrok";
  readonly mode: "spawn" | "attach";
  /** Public http(s) origin the CSMS can reach; feeds buildSoapCallbackUrl(). */
  readonly publicBaseUrl: string;
  /** Synchronous so it fits the daemon's shutdown path, which exits right after. */
  close(): void;
}

/** The slice of a child process the spawn mode needs; `Bun.spawn` satisfies it. */
export interface SpawnedTunnelProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number | null>;
  kill(): void;
}

export type SoapTunnelSpawnFn = (
  argv: string[],
  env: Record<string, string | undefined>,
) => SpawnedTunnelProcess;

export interface SoapTunnelOptions {
  /** Address the tunnel forwards to — the daemon's HTTP listener. */
  readonly localHost: string;
  readonly localPort: number;
  /** spawn mode: `--ngrok-auth-token`; absent → ngrok config / inherited env. */
  readonly authToken?: string | null;
  /** spawn mode: `--ngrok-domain`, forwarded as `ngrok http --url`. */
  readonly domain?: string | null;
  /** attach mode: `--ngrok-api-url`. Its presence selects the mode. */
  readonly apiUrl?: string | null;
  readonly timeoutMs?: number;
  /** spawn mode: the agent exited on its own (not through close()). */
  readonly onExit?: (code: number | null) => void;
  /** Test seams. */
  readonly spawn?: SoapTunnelSpawnFn;
  readonly fetch?: typeof fetch;
  readonly env?: Record<string, string | undefined>;
}

export async function startSoapTunnel(
  opts: SoapTunnelOptions,
): Promise<SoapTunnel> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (opts.apiUrl) {
    return attachNgrokTunnel(
      opts.apiUrl,
      opts.localPort,
      timeoutMs,
      opts.fetch ?? fetch,
    );
  }
  return spawnNgrokTunnel(opts, timeoutMs);
}

/**
 * ngrok forwards to the address we pass; a wildcard bind (`--http-host
 * 0.0.0.0` / `::`) is not something it can connect to, so use loopback.
 */
export function localHostForTunnel(httpHost: string): string {
  const host = httpHost.trim();
  if (!host || host === "0.0.0.0" || host === "::" || host === "[::]")
    return "127.0.0.1";
  return host;
}

// ---------------------------------------------------------------------------
// spawn mode
// ---------------------------------------------------------------------------

function bunSpawn(
  argv: string[],
  env: Record<string, string | undefined>,
): SpawnedTunnelProcess {
  const proc = Bun.spawn({
    cmd: argv,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
    kill: () => proc.kill(),
  };
}

function ngrokArgv(
  localHost: string,
  localPort: number,
  domain: string | null | undefined,
): string[] {
  const argv = [
    "ngrok",
    "http",
    `${localHost}:${localPort}`,
    "--log",
    "stdout",
    "--log-format",
    "json",
  ];
  if (domain) argv.push("--url", domain);
  return argv;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

interface NgrokLogLine {
  lvl?: unknown;
  msg?: unknown;
  err?: unknown;
  url?: unknown;
}

function parseLogLine(line: string): NgrokLogLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object"
      ? (parsed as NgrokLogLine)
      : null;
  } catch {
    return null;
  }
}

async function* lines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = pending.indexOf("\n")) >= 0) {
      yield pending.slice(0, index);
      pending = pending.slice(index + 1);
    }
  }
  pending += decoder.decode();
  if (pending) yield pending;
}

async function spawnNgrokTunnel(
  opts: SoapTunnelOptions,
  timeoutMs: number,
): Promise<SoapTunnel> {
  const spawn = opts.spawn ?? bunSpawn;
  const env: Record<string, string | undefined> = {
    ...(opts.env ?? process.env),
  };
  if (opts.authToken) env.NGROK_AUTHTOKEN = opts.authToken;
  const argv = ngrokArgv(opts.localHost, opts.localPort, opts.domain);

  let proc: SpawnedTunnelProcess;
  try {
    proc = spawn(argv, env);
  } catch (error) {
    if (isEnoent(error)) {
      throw new Error(
        "ngrok binary not found in PATH; install ngrok (https://ngrok.com/download) " +
          "or attach to a running agent with --ngrok-api-url",
        { cause: error },
      );
    }
    throw error;
  }

  // The configured token is the one secret we know the exact value of; scrub
  // it from anything ngrok says before the text can reach a log line.
  const redact = (text: string): string => {
    const scrubbed = opts.authToken
      ? text.split(opts.authToken).join("[redacted]")
      : text;
    return redactSensitiveText(scrubbed);
  };

  let stderrText = "";
  const stderrDone = (async () => {
    for await (const line of lines(proc.stderr)) stderrText += `${line}\n`;
  })().catch(() => {});

  return new Promise<SoapTunnel>((resolve, reject) => {
    let settled = false;
    let closed = false;

    // Whatever ends the daemon — the lifecycle's process.exit(), a startup
    // error thrown past this point, an uncaught exception — the agent must
    // not outlive it. The sync kill on "exit" covers the paths close() is
    // never reached on.
    const killOnExit = (): void => proc.kill();
    process.once("exit", killOnExit);
    const close = (): void => {
      if (closed) return;
      closed = true;
      process.off("exit", killOnExit);
      proc.kill();
    };

    const timer = setTimeout(() => {
      fail(
        new Error(
          `ngrok did not announce a tunnel: timed out after ${timeoutMs} ms`,
        ),
      );
    }, timeoutMs);

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      close();
      reject(error);
    };

    const tunnel: SoapTunnel = {
      provider: "ngrok",
      mode: "spawn",
      publicBaseUrl: "",
      close,
    };

    void (async () => {
      try {
        for await (const raw of lines(proc.stdout)) {
          const line = parseLogLine(raw);
          if (!line) continue;
          if (line.lvl === "eror" && !settled) {
            const detail =
              typeof line.err === "string" && line.err ? ` (${line.err})` : "";
            fail(
              new Error(
                redact(`ngrok: ${String(line.msg ?? "error")}${detail}`),
              ),
            );
            return;
          }
          if (
            !settled &&
            line.msg === "started tunnel" &&
            typeof line.url === "string" &&
            isHttpUrl(line.url)
          ) {
            settled = true;
            clearTimeout(timer);
            resolve({ ...tunnel, publicBaseUrl: line.url.replace(/\/+$/, "") });
          }
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    })();

    void proc.exited.then(async (code) => {
      if (settled) {
        if (!closed) {
          closed = true;
          process.off("exit", killOnExit);
          opts.onExit?.(code);
        }
        return;
      }
      await Promise.race([
        stderrDone,
        new Promise((r) => setTimeout(r, STDERR_DRAIN_MS)),
      ]);
      const detail = stderrText.trim();
      fail(
        new Error(
          redact(
            `ngrok exited (code ${code}) before the tunnel came up${detail ? `: ${detail}` : ""}`,
          ),
        ),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// attach mode
// ---------------------------------------------------------------------------

/** Shape of one entry of the agent API's `GET /api/tunnels` response. */
export interface NgrokApiTunnel {
  public_url?: unknown;
  proto?: unknown;
  config?: { addr?: unknown } | null;
}

export type NgrokTunnelSelection =
  { ok: true; publicUrl: string } | { ok: false; candidates: string[] };

function addrPort(addr: unknown): number | null {
  if (typeof addr !== "string" || !addr) return null;
  if (/^\d+$/.test(addr)) return Number(addr);
  for (const candidate of [addr, `http://${addr}`]) {
    try {
      const port = new URL(candidate).port;
      if (port) return Number(port);
    } catch {
      // try the next spelling
    }
  }
  return null;
}

/**
 * Prefer the https tunnel that forwards to our port; otherwise accept the
 * only https tunnel the agent has (a sidecar runs one tunnel, and its `addr`
 * names the simulator's container port, which may legitimately differ from
 * the port we see). Anything else is ambiguous and left to the operator.
 */
export function selectNgrokTunnel(
  tunnels: NgrokApiTunnel[],
  localPort: number,
): NgrokTunnelSelection {
  const https = tunnels.filter(
    (t): t is NgrokApiTunnel & { public_url: string } =>
      t.proto === "https" &&
      typeof t.public_url === "string" &&
      isHttpUrl(t.public_url),
  );
  const byPort = https.find((t) => addrPort(t.config?.addr) === localPort);
  const picked = byPort ?? (https.length === 1 ? https[0] : undefined);
  if (picked)
    return { ok: true, publicUrl: picked.public_url.replace(/\/+$/, "") };
  return { ok: false, candidates: https.map((t) => t.public_url) };
}

async function attachNgrokTunnel(
  apiUrl: string,
  localPort: number,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<SoapTunnel> {
  const base = apiUrl.replace(/\/+$/, "");
  const endpoint = `${base}/api/tunnels`;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`ngrok agent API ${endpoint} is unreachable: ${reason}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new Error(`ngrok agent API ${endpoint} responded ${response.status}`);
  }
  const body = (await response.json().catch(() => null)) as {
    tunnels?: unknown;
  } | null;
  const tunnels = Array.isArray(body?.tunnels)
    ? (body.tunnels as NgrokApiTunnel[])
    : [];
  const selection = selectNgrokTunnel(tunnels, localPort);
  if (!selection.ok) {
    const suffix =
      selection.candidates.length > 1
        ? ` (ambiguous: ${selection.candidates.join(", ")}; start the agent with a single https tunnel to port ${localPort})`
        : "";
    throw new Error(
      `no https tunnel forwarding to port ${localPort} found at ${base}${suffix}`,
    );
  }
  return {
    provider: "ngrok",
    mode: "attach",
    publicBaseUrl: selection.publicUrl,
    close: () => {},
  };
}

// ---------------------------------------------------------------------------
// daemon startup lines
// ---------------------------------------------------------------------------

export interface SoapTunnelStartupInput {
  readonly tunnel: SoapTunnel;
  readonly localHost: string;
  readonly localPort: number;
  readonly soapPath: string;
  /** null for a fleet: the route is described with a `<cp-id>` placeholder. */
  readonly cpId: string | null;
}

/**
 * What the daemon logs once the tunnel is up. Kept pure so the wording — in
 * particular that no credential ever appears in it — is unit-tested.
 */
export function soapTunnelStartupLines(
  input: SoapTunnelStartupInput,
): string[] {
  const path = normalizeSoapPath(input.soapPath);
  const prefix = path === "/" ? "" : path;
  const segment = input.cpId ? encodeURIComponent(input.cpId) : "<cp-id>";
  const callbackUrl = `${input.tunnel.publicBaseUrl}${prefix}/${segment}/${SOAP_SERVICE_SUFFIX}`;
  return [
    `SOAP tunnel (${input.tunnel.provider}, ${input.tunnel.mode}): ${input.tunnel.publicBaseUrl} -> http://${input.localHost}:${input.localPort}`,
    `Warning: SOAP callback endpoint is publicly reachable through the tunnel at ${callbackUrl}; ` +
      "charge-point identity checks stay enforced, and temporary ngrok URLs change between runs.",
  ];
}
