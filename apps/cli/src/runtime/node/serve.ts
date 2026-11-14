/**
 * `serve()` on Node (#916): a `node:http` server that turns each request into
 * a fetch `Request`, calls the same handler `Bun.serve` gets, and writes the
 * `Response` back.
 *
 * Socket.IO requests go through that handler like any other — access guard,
 * origin allowlist and CORS / cache headers stay identical to Bun — and are
 * then handed to Engine.IO on the raw Node request: the handler's response for
 * them is a {@link handOff} marker carrying a callback, not bytes to write.
 * WebSocket upgrades (`upgrade` event) take the same path.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { RuntimeServer, ServeOptions } from "../types";

/** The raw Node objects behind a `Request`, for a handler that takes it over. */
export type RawNodeRequest =
  | {
      readonly kind: "request";
      readonly req: IncomingMessage;
      readonly res: ServerResponse;
    }
  | {
      readonly kind: "upgrade";
      readonly req: IncomingMessage;
      readonly socket: Duplex;
      readonly head: Buffer;
    };

type HandOffFn = (raw: RawNodeRequest) => void;

const rawByRequest = new WeakMap<Request, RawNodeRequest>();
const peerByRequest = new WeakMap<Request, string>();
const handOffs = new WeakMap<Response, HandOffFn>();

/**
 * A response that tells the Node server to give the raw request to `take`
 * instead of writing a body. Headers set on it (CORS, cache-control) are
 * applied to the raw response before `take` runs.
 */
export function handOff(take: HandOffFn): Response {
  const res = new Response(null, { status: 200 });
  handOffs.set(res, take);
  return res;
}

/** The raw Node request behind `req`; null for a request not made here. */
export function rawNodeRequest(req: Request): RawNodeRequest | null {
  return rawByRequest.get(req) ?? null;
}

export function serveNode(options: ServeOptions): Promise<RuntimeServer> {
  const server = createServer();
  const upgraded = new Set<Duplex>();
  let boundPort: number | undefined;

  const runtimeServer: RuntimeServer = {
    get port() {
      return boundPort;
    },
    requestIP(req) {
      const address = peerByRequest.get(req);
      return address ? { address } : null;
    },
    stop(closeActiveConnections) {
      server.close();
      if (closeActiveConnections) {
        server.closeAllConnections();
        for (const socket of upgraded) socket.destroy();
        upgraded.clear();
      } else {
        server.closeIdleConnections();
      }
    },
  };

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res);
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgraded.add(socket);
    socket.once("close", () => upgraded.delete(socket));
    // A reset while the fetch handler is pending or the refusal is written
    // must not surface as an unhandled 'error' event.
    socket.on("error", () => {});
    void handleUpgrade(req, socket, head);
  });

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let request: Request;
    try {
      request = toRequest(req, options, true);
    } catch {
      // e.g. a Host header that is not a valid authority.
      if (!res.headersSent) {
        res.writeHead(400, { connection: "close" });
      }
      res.end();
      return;
    }
    rawByRequest.set(request, { kind: "request", req, res });
    let response: Response | undefined;
    try {
      response = await options.fetch(request, runtimeServer);
    } catch (error) {
      reportError(error);
      response = internalError();
    }
    if (!response) {
      // Taken over without a hand-off; nothing to write unless it was forgotten.
      if (!res.headersSent && !res.writableEnded) {
        writeHead(res, internalError());
        res.end();
      }
      return;
    }
    const take = handOffs.get(response);
    if (take) {
      for (const [name, value] of response.headers) res.setHeader(name, value);
      take({ kind: "request", req, res });
      return;
    }
    await writeResponse(res, response);
  }

  async function handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    let request: Request;
    try {
      request = toRequest(req, options, false);
    } catch {
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n",
      );
      return;
    }
    const raw: RawNodeRequest = { kind: "upgrade", req, socket, head };
    rawByRequest.set(request, raw);
    let response: Response | undefined;
    try {
      response = await options.fetch(request, runtimeServer);
    } catch (error) {
      reportError(error);
      response = internalError();
    }
    const take = response ? handOffs.get(response) : undefined;
    if (take) {
      take(raw);
      return;
    }
    // Refused (or not an upgrade route): answer in plain HTTP and hang up.
    const res = response ?? new Response("not found", { status: 404 });
    const body = Buffer.from(await res.arrayBuffer());
    const lines = [`HTTP/1.1 ${res.status} ${res.statusText || "Error"}`];
    for (const [name, value] of res.headers) lines.push(`${name}: ${value}`);
    lines.push(`content-length: ${body.byteLength}`, "connection: close");
    socket.end(
      Buffer.concat([Buffer.from(lines.join("\r\n") + "\r\n\r\n"), body]),
    );
  }

  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(options.port, options.hostname, () => {
      server.off("error", onError);
      server.on("error", reportError);
      boundPort = (server.address() as AddressInfo | null)?.port;
      resolve(runtimeServer);
    });
  });
}

function toRequest(
  req: IncomingMessage,
  options: ServeOptions,
  withBody: boolean,
): Request {
  const host = req.headers.host ?? `${options.hostname}:${options.port}`;
  const url = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    headers.append(raw[i]!, raw[i + 1]!);
  }
  const method = req.method ?? "GET";
  const hasBody = withBody && method !== "GET" && method !== "HEAD";
  const controller = new AbortController();
  req.once("close", () => {
    if (!req.complete) controller.abort();
  });
  const request = new Request(url, {
    method,
    headers,
    signal: controller.signal,
    ...(hasBody ? { body: lazyBody(req), duplex: "half" } : {}),
  } as RequestInit);
  const peer = (req.socket as Socket | undefined)?.remoteAddress;
  if (peer) peerByRequest.set(request, peer);
  return request;
}

/**
 * The request body as a web stream that attaches to the Node stream only when
 * someone reads it, so a handed-off request (Engine.IO polling POST) still
 * finds its body unread.
 */
function lazyBody(req: IncomingMessage): ReadableStream<Uint8Array> {
  let attached = false;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (attached) {
          req.resume();
          return;
        }
        attached = true;
        req.on("data", (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk));
          if ((controller.desiredSize ?? 1) <= 0) req.pause();
        });
        req.once("end", () => controller.close());
        req.once("error", (error) => controller.error(error));
      },
      cancel() {
        req.destroy();
      },
    },
    { highWaterMark: 0 },
  );
}

function writeHead(res: ServerResponse, response: Response): void {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of response.headers) {
    if (name === "set-cookie") continue;
    headers[name] = value;
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  res.writeHead(response.status, response.statusText || undefined, headers);
}

async function writeResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  writeHead(res, response);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  const onClose = (): void => {
    void reader.cancel().catch(() => {});
  };
  res.once("close", onClose);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        await new Promise<void>((resolve) => {
          const go = (): void => {
            res.off("drain", go);
            res.off("close", go);
            resolve();
          };
          res.once("drain", go);
          res.once("close", go);
        });
      }
      if (res.destroyed) break;
    }
  } catch {
    // The client went away or the body stream failed; nothing more to send.
  } finally {
    res.off("close", onClose);
    res.end();
  }
}

function internalError(): Response {
  return new Response("Internal Server Error", { status: 500 });
}

function reportError(error: unknown): void {
  process.stderr.write(
    `[server] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
}
