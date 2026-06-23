import * as http from "http";
import { DEFAULT_UNIX_SOCKET } from "./server/constants";

export type ClientTarget =
  | { readonly kind: "tcp"; readonly host: string; readonly port: number }
  | { readonly kind: "unix"; readonly path: string };

export interface ClientLocation {
  readonly httpUrl: string | null;
  readonly unixSocket: string | null;
  /** Basic Auth credentials to send to a daemon started with
   *  `--web-console-basic-auth-*`. Null/omitted = no Authorization header
   *  (the daemon must then be running without the auth gate). */
  readonly basicAuth?: {
    readonly username: string;
    readonly password: string;
  } | null;
}

/** `Authorization: Basic <base64(user:pass)>`, UTF-8 encoded to match the
 *  daemon's decode path (server side re-decodes through a UTF-8 TextDecoder). */
function basicAuthHeader(cred: { username: string; password: string }): string {
  return (
    "Basic " +
    Buffer.from(`${cred.username}:${cred.password}`, "utf-8").toString("base64")
  );
}

export function resolveTarget(loc: ClientLocation): ClientTarget {
  if (loc.httpUrl) {
    const url = new URL(loc.httpUrl);
    const port = url.port
      ? parseInt(url.port, 10)
      : url.protocol === "https:"
        ? 443
        : 80;
    return { kind: "tcp", host: url.hostname, port };
  }
  if (loc.unixSocket) {
    return { kind: "unix", path: loc.unixSocket };
  }
  return { kind: "unix", path: DEFAULT_UNIX_SOCKET };
}

interface HttpResult {
  readonly status: number;
  readonly body: string;
}

function httpRequest(
  target: ClientTarget,
  method: string,
  path: string,
  body: string | null,
  auth?: ClientLocation["basicAuth"],
): Promise<HttpResult> {
  const headers: Record<string, string> = body
    ? {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      }
    : {};
  if (auth) headers["authorization"] = basicAuthHeader(auth);

  const reqOpts: http.RequestOptions =
    target.kind === "tcp"
      ? { host: target.host, port: target.port, path, method, headers }
      : {
          socketPath: target.path,
          path,
          method,
          headers: { ...headers, host: "localhost" },
        };

  return new Promise<HttpResult>((resolve, reject) => {
    const req = http.request(reqOpts, (res) => {
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk.toString();
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: buf });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function formatHttpError(
  err: NodeJS.ErrnoException,
  target: ClientTarget,
): string {
  if (target.kind === "unix") {
    const hint =
      " To target a TCP daemon pass --http-url http://host:port" +
      " (client modes use --http-url, not the server's --http-host/--http-port).";
    if (err.code === "ENOENT") {
      return `No server running (socket not found: ${target.path}).${hint}`;
    }
    if (err.code === "ECONNREFUSED") {
      return `Server is not accepting connections at ${target.path}.${hint}`;
    }
  } else {
    if (err.code === "ECONNREFUSED") {
      return `Cannot connect to ${target.host}:${target.port}`;
    }
  }
  return err.message;
}

export async function sendCommand(
  loc: ClientLocation,
  cpId: string,
  jsonStr: string,
): Promise<void> {
  const target = resolveTarget(loc);

  try {
    JSON.parse(jsonStr);
  } catch {
    process.stderr.write("Error: --send value must be valid JSON\n");
    process.exit(1);
  }

  try {
    const res = await httpRequest(
      target,
      "POST",
      `/v1/cp/${encodeURIComponent(cpId)}/command`,
      jsonStr,
      loc.basicAuth,
    );
    if (res.body.trim()) {
      process.stdout.write(`${res.body.trim()}\n`);
    }
    if (res.status >= 400) {
      process.exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(
      `Error: ${formatHttpError(err as NodeJS.ErrnoException, target)}\n`,
    );
    process.exitCode = 1;
  }
}

export async function stopDaemon(loc: ClientLocation): Promise<void> {
  const target = resolveTarget(loc);

  try {
    const res = await httpRequest(
      target,
      "POST",
      "/v1/shutdown",
      null,
      loc.basicAuth,
    );
    if (res.body.trim()) {
      try {
        const parsed = JSON.parse(res.body) as { ok?: boolean };
        if (parsed.ok) {
          process.stdout.write(`Server stopped.\n`);
        } else {
          process.stdout.write(`${res.body.trim()}\n`);
        }
      } catch {
        process.stdout.write(`${res.body.trim()}\n`);
      }
    }
  } catch (err) {
    const errWithCode = err as NodeJS.ErrnoException;
    if (errWithCode.code === "ENOENT") {
      process.stderr.write(`No server running\n`);
      return;
    }
    process.stderr.write(`Error: ${formatHttpError(errWithCode, target)}\n`);
    process.exitCode = 1;
  }
}

export async function subscribeEvents(
  loc: ClientLocation,
  cpId: string | null,
): Promise<void> {
  if (!loc.httpUrl) {
    process.stderr.write(
      "Error: --events requires --http-url (WebSocket over Unix socket is not supported)\n",
    );
    process.exit(1);
  }

  const wsBase = loc.httpUrl.replace(/^http/, "ws").replace(/\/+$/, "");
  const path = cpId
    ? `/v1/cp/${encodeURIComponent(cpId)}/events`
    : "/v1/events";
  const wsUrl = `${wsBase}${path}`;

  await new Promise<void>((resolve) => {
    // Bun's WebSocket accepts a non-standard options object carrying request
    // `headers`; the DOM lib types the 2nd arg as `protocols` only, hence the
    // cast. Lets `--events` authenticate to a daemon behind --web-console-basic-auth.
    const wsInit = loc.basicAuth
      ? { headers: { authorization: basicAuthHeader(loc.basicAuth) } }
      : undefined;
    const ws = new WebSocket(wsUrl, wsInit as unknown as string[] | undefined);
    let opened = false;

    ws.onopen = () => {
      opened = true;
      process.stderr.write(`[client] Subscribed to ${wsUrl}\n`);
    };
    ws.onmessage = (e: MessageEvent) => {
      const data = typeof e.data === "string" ? e.data : String(e.data);
      process.stdout.write(`${data}\n`);
    };
    ws.onerror = () => {
      if (!opened) {
        process.stderr.write(`Error: WebSocket connection error (${wsUrl})\n`);
        process.exitCode = 1;
      }
    };
    ws.onclose = () => {
      resolve();
    };

    const close = () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    };
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
  });
}
