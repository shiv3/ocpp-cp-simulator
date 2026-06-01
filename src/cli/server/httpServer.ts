import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import * as path from "path";
import { handleJsonCommand } from "../jsonMode";
import { toJsonResponse, toJsonEvent } from "../output";
import type { JsonCommand, ChargePointInitOptions } from "../types";
import type { CPRegistry } from "./CPRegistry";
import type { EventBus } from "./eventBus";
import type { Lifecycle } from "./lifecycle";
import type { Database } from "../../cp/domain/persistence/Database";
import { resetSimulatorState } from "../../cp/domain/persistence/resetState";
import { LogLevel } from "../../cp/shared/Logger";

/**
 * Serve files out of a directory as a 404 fallback for the API router.
 * SPA-friendly: requests with no file extension (`/`, `/settings`, ...)
 * that don't match a real file fall back to `index.html` so the React
 * router can take over.
 *
 * Returns null when there's no match — the caller emits the 404.
 */
async function serveStatic(
  req: Request,
  staticDir: string,
): Promise<Response | null> {
  if (req.method !== "GET" && req.method !== "HEAD") return null;

  const url = new URL(req.url);
  let pathname = decodeURIComponent(url.pathname);
  pathname = pathname.replace(/^\/+/, "");
  // Reject traversal attempts.
  if (pathname.split("/").some((seg) => seg === "..")) return null;
  if (pathname === "") pathname = "index.html";

  const absoluteRoot = path.resolve(staticDir);
  const resolved = path.resolve(absoluteRoot, pathname);
  // Belt-and-braces: even if a path slips past the segment check, ensure
  // the resolved path stays under the static root.
  if (
    resolved !== absoluteRoot &&
    !resolved.startsWith(absoluteRoot + path.sep)
  ) {
    return null;
  }

  let file = Bun.file(resolved);
  if (!(await file.exists())) {
    // SPA fallback: only for "looks like a page" requests (no extension on
    // the last path segment). Asset requests for missing files should
    // honestly 404 so the browser doesn't render HTML for a JS bundle.
    const last = pathname.split("/").pop() ?? "";
    if (last.includes(".")) return null;
    file = Bun.file(path.join(absoluteRoot, "index.html"));
    if (!(await file.exists())) return null;
  }
  return new Response(file);
}

interface SocketData {
  scope: string;
  unsub?: () => void;
}

const COMMON_CORS_HEADERS: Record<string, string> = {
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};

export type CorsPolicy =
  | { kind: "any" }
  | { kind: "allowlist"; origins: ReadonlyArray<string> };

function pickAllowedOrigin(req: Request, policy: CorsPolicy): string | null {
  if (policy.kind === "any") return "*";
  const origin = req.headers.get("origin");
  if (origin && policy.origins.includes(origin)) return origin;
  return null;
}

/**
 * Returns true when the request's Origin header is acceptable under the policy.
 *
 * - "any" policy: always true (open CORS).
 * - "allowlist": true iff Origin is in the list, OR no Origin header is present.
 *   The latter exemption is intentional: non-browser callers (curl, fetch from
 *   server code, the cp-sim CLI) don't send Origin, and the allowlist exists to
 *   block cross-site browser requests, not to authenticate.
 */
function isOriginAllowed(req: Request, policy: CorsPolicy): boolean {
  if (policy.kind === "any") return true;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  return policy.origins.includes(origin);
}

function applyCors(res: Response, req: Request, policy: CorsPolicy): Response {
  const allow = pickAllowedOrigin(req, policy);
  if (allow) {
    res.headers.set("access-control-allow-origin", allow);
    if (allow !== "*") res.headers.set("vary", "Origin");
  }
  for (const [k, v] of Object.entries(COMMON_CORS_HEADERS)) {
    res.headers.set(k, v);
  }
  return res;
}

function forbidden(): Response {
  return new Response("origin not allowed", { status: 403 });
}

export interface HttpHandlers {
  fetch: (
    req: Request,
    server: Server<SocketData>,
  ) => Response | Promise<Response | undefined> | undefined;
  websocket: WebSocketHandler<SocketData>;
}

export function createHttpHandlers(deps: {
  registry: CPRegistry;
  bus: EventBus;
  lifecycle: Lifecycle;
  cors?: CorsPolicy;
  /** Absolute path of a directory served as a 404 fallback (SPA aware). */
  staticDir?: string | null;
  /** Daemon state DB; needed so POST /v1/state/reset can truncate it. */
  database?: Database | null;
}): HttpHandlers {
  const { registry, bus, lifecycle } = deps;
  const cors: CorsPolicy = deps.cors ?? { kind: "any" };
  const staticDir = deps.staticDir ?? null;
  const database = deps.database ?? null;

  return {
    fetch(req, server) {
      // Reserved hook: authentication middleware can be added here.

      // Block disallowed browser origins BEFORE dispatching so simple-request
      // POSTs / WS upgrades / GETs don't trigger side effects under a tightened
      // --cors-origin allowlist. CORS response headers alone are not enough,
      // since simple requests bypass preflight and reach the handler regardless.
      if (!isOriginAllowed(req, cors)) {
        return applyCors(forbidden(), req, cors);
      }

      // CORS preflight — answer immediately for any path/method.
      if (req.method === "OPTIONS") {
        return applyCors(new Response(null, { status: 204 }), req, cors);
      }

      const result = dispatch(req, server);
      if (result === undefined) return undefined; // WS upgrade already handled
      if (result instanceof Response) return applyCors(result, req, cors);
      return result.then((r) =>
        r instanceof Response ? applyCors(r, req, cors) : r,
      );
    },

    websocket: {
      open(ws: ServerWebSocket<SocketData>) {
        const { scope } = ws.data;
        const unsub = bus.subscribe(scope, ({ cpId, evt }) => {
          const base = toJsonEvent(evt.event, evt.data);
          const payload = scope === "*" ? { cpId, ...base } : base;
          try {
            ws.send(JSON.stringify(payload));
          } catch {
            // best effort
          }
        });
        ws.data.unsub = unsub;
      },
      message() {
        // phase1: ignore inbound
      },
      close(ws: ServerWebSocket<SocketData>) {
        ws.data.unsub?.();
      },
    },
  };

  function dispatch(
    req: Request,
    server: Server<SocketData>,
  ): Response | Promise<Response> | undefined {
    const url = new URL(req.url);
    const segs = url.pathname.split("/").filter(Boolean);

    const isWsUpgrade =
      (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket";

    // WS /v1/events (all CPs)
    if (
      isWsUpgrade &&
      segs.length === 2 &&
      segs[0] === "v1" &&
      segs[1] === "events"
    ) {
      const ok = server.upgrade(req, { data: { scope: "*" } as SocketData });
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    }

    // WS /v1/cp/:cpId/events (single CP)
    if (
      isWsUpgrade &&
      segs.length === 4 &&
      segs[0] === "v1" &&
      segs[1] === "cp" &&
      segs[3] === "events"
    ) {
      const cpId = decodeURIComponent(segs[2]);
      if (!registry.has(cpId)) {
        return new Response("unknown cpId", { status: 404 });
      }
      const ok = server.upgrade(req, { data: { scope: cpId } as SocketData });
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    }

    // GET /healthz
    if (req.method === "GET" && url.pathname === "/healthz") {
      return Response.json({ ok: true, cps: registry.list().length });
    }

    // POST /v1/shutdown
    if (req.method === "POST" && url.pathname === "/v1/shutdown") {
      // Defer shutdown so the response body has time to flush to the client.
      setTimeout(() => lifecycle.requestShutdown(), 100);
      return Response.json({ ok: true });
    }

    // POST /v1/cp/:cpId/logs/clear — drop the persisted log rows for one
    // CP, leaving the rest of the DB intact. The browser also clears its
    // own in-memory log buffer; this is the "and DB too" half.
    if (
      req.method === "POST" &&
      segs.length === 5 &&
      segs[0] === "v1" &&
      segs[1] === "cp" &&
      segs[3] === "logs" &&
      segs[4] === "clear"
    ) {
      const cpId = decodeURIComponent(segs[2]);
      if (database) {
        database.run("DELETE FROM logs WHERE cp_id = ?", [cpId]);
        void database.flush?.();
      }
      return Response.json({ ok: true });
    }

    // GET /v1/cp/:cpId/logs — list log entries for one CP, oldest-first.
    // Prefers the persisted `logs` table (full session-spanning history
    // when --state-db is set), and falls back to the Logger's in-memory
    // list for daemons running without persistence. Backs the browser's
    // "Download logs" button in remote mode.
    if (
      req.method === "GET" &&
      segs.length === 4 &&
      segs[0] === "v1" &&
      segs[1] === "cp" &&
      segs[3] === "logs"
    ) {
      const cpId = decodeURIComponent(segs[2]);
      const svc = registry.get(cpId);
      svc?.flushLogs();
      if (database) {
        const rows = database.all<{
          timestamp: string;
          level: string;
          log_type: string;
          message: string;
        }>(
          "SELECT timestamp, level, log_type, message FROM logs " +
            "WHERE cp_id = ? ORDER BY id ASC",
          [cpId],
        );
        if (rows.length > 0) {
          return Response.json(
            rows.map((r) => ({
              timestamp: r.timestamp,
              level: r.level,
              type: r.log_type,
              cpId,
              message: r.message,
            })),
          );
        }
      }
      // No DB or DB empty — fall back to whatever the Logger has buffered
      // in memory for this CP's process lifetime.
      const memEntries = svc?.getInMemoryLogs() ?? [];
      return Response.json(
        memEntries.map((e) => ({
          timestamp: e.timestamp.toISOString(),
          level: LogLevel[e.level] ?? "INFO",
          type: e.type,
          cpId,
          message: e.message,
        })),
      );
    }

    // POST /v1/state/reset — drop every CP, then truncate the state DB.
    // Called by the UI "Reset all simulator data" button when in remote
    // mode (browser sends this via RemoteChargePointService.resetAllState).
    if (req.method === "POST" && url.pathname === "/v1/state/reset") {
      for (const cpId of [...registry.list()]) registry.remove(cpId);
      if (database) {
        resetSimulatorState(database);
        // database.flush is a no-op on bun:sqlite; call without await so
        // the fetch handler stays sync (matches the rest of the routes).
        void database.flush?.();
      }
      return Response.json({ ok: true });
    }

    // GET /v1/cp
    if (
      req.method === "GET" &&
      segs.length === 2 &&
      segs[0] === "v1" &&
      segs[1] === "cp"
    ) {
      const list = registry.list().map((cpId) => {
        const svc = registry.get(cpId);
        const status = svc?.getStatus();
        return {
          cpId,
          status: status?.status ?? "",
          connectors: status?.connectors.length ?? 0,
        };
      });
      return Response.json(list);
    }

    // POST /v1/cp  (create)
    if (
      req.method === "POST" &&
      segs.length === 2 &&
      segs[0] === "v1" &&
      segs[1] === "cp"
    ) {
      return req
        .json()
        .then(async (body: unknown) => {
          try {
            const init = parseCreateBody(body);
            const svc = registry.create(init);
            const autoConnect =
              isRecord(body) && body.autoConnect === true ? true : false;
            if (autoConnect) {
              svc.connect().catch((err) => {
                process.stderr.write(
                  `[server] autoConnect failed for ${init.cpId}: ${
                    err instanceof Error ? err.message : err
                  }\n`,
                );
              });
            }
            return Response.json({
              ok: true,
              data: { cpId: init.cpId },
            });
          } catch (err) {
            return Response.json({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })
        .catch(() => Response.json({ ok: false, error: "invalid JSON body" }));
    }

    // GET /v1/cp/:cpId
    if (
      req.method === "GET" &&
      segs.length === 3 &&
      segs[0] === "v1" &&
      segs[1] === "cp"
    ) {
      const cpId = decodeURIComponent(segs[2]);
      const svc = registry.get(cpId);
      if (!svc) return new Response("unknown cpId", { status: 404 });
      return Response.json(svc.getStatus());
    }

    // DELETE /v1/cp/:cpId
    if (
      req.method === "DELETE" &&
      segs.length === 3 &&
      segs[0] === "v1" &&
      segs[1] === "cp"
    ) {
      const cpId = decodeURIComponent(segs[2]);
      const removed = registry.remove(cpId);
      if (!removed) return new Response("unknown cpId", { status: 404 });
      return Response.json({ ok: true });
    }

    // POST /v1/cp/:cpId/command
    if (
      req.method === "POST" &&
      segs.length === 4 &&
      segs[0] === "v1" &&
      segs[1] === "cp" &&
      segs[3] === "command"
    ) {
      const cpId = decodeURIComponent(segs[2]);
      const svc = registry.get(cpId);
      if (!svc) return new Response("unknown cpId", { status: 404 });

      return req
        .json()
        .then(async (body: unknown) => {
          if (!isJsonCommand(body)) {
            return Response.json(
              toJsonResponse(null, false, "Invalid JsonCommand"),
            );
          }
          const id = body.id ?? null;
          try {
            const data = await handleJsonCommand(svc, body);
            return Response.json(toJsonResponse(id, true, data));
          } catch (err) {
            return Response.json(
              toJsonResponse(
                id,
                false,
                err instanceof Error ? err.message : String(err),
              ),
            );
          }
        })
        .catch(() =>
          Response.json(toJsonResponse(null, false, "Invalid JSON body")),
        );
    }

    // Static file fallback (SPA aware). Disabled when --serve-static is
    // not configured. Note: dispatch can return a Promise, so awaiting
    // here is fine.
    if (staticDir) {
      return serveStatic(req, staticDir).then(
        (res) => res ?? new Response("not found", { status: 404 }),
      );
    }
    return new Response("not found", { status: 404 });
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isJsonCommand(v: unknown): v is JsonCommand {
  return isRecord(v) && typeof v.command === "string";
}

function parseCreateBody(body: unknown): ChargePointInitOptions {
  if (!isRecord(body)) throw new Error("body must be an object");
  const cpId = body.cpId;
  if (typeof cpId !== "string" || cpId.length === 0) {
    throw new Error("cpId is required (string)");
  }
  const wsUrl = body.wsUrl;
  if (typeof wsUrl !== "string" || wsUrl.length === 0) {
    throw new Error("wsUrl is required (string)");
  }
  const connectors =
    typeof body.connectors === "number" && Number.isInteger(body.connectors)
      ? body.connectors
      : 1;
  if (connectors < 1) {
    throw new Error("connectors must be >= 1");
  }
  const vendor =
    typeof body.vendor === "string" ? body.vendor : "Server-Vendor";
  const model = typeof body.model === "string" ? body.model : "Server-Model";
  let basicAuth: ChargePointInitOptions["basicAuth"] = null;
  if (isRecord(body.basicAuth)) {
    const username = body.basicAuth.username;
    const password = body.basicAuth.password;
    if (typeof username === "string" && typeof password === "string") {
      basicAuth = { username, password };
    }
  }
  const bn = isRecord(body.bootNotification) ? body.bootNotification : null;
  const bootNotification: ChargePointInitOptions["bootNotification"] = bn
    ? {
        ...(typeof bn.firmwareVersion === "string"
          ? { firmwareVersion: bn.firmwareVersion }
          : {}),
        ...(typeof bn.chargePointSerialNumber === "string"
          ? { chargePointSerialNumber: bn.chargePointSerialNumber }
          : {}),
        ...(typeof bn.chargeBoxSerialNumber === "string"
          ? { chargeBoxSerialNumber: bn.chargeBoxSerialNumber }
          : {}),
        ...(typeof bn.meterSerialNumber === "string"
          ? { meterSerialNumber: bn.meterSerialNumber }
          : {}),
        ...(typeof bn.meterType === "string"
          ? { meterType: bn.meterType }
          : {}),
        ...(typeof bn.iccid === "string" ? { iccid: bn.iccid } : {}),
        ...(typeof bn.imsi === "string" ? { imsi: bn.imsi } : {}),
      }
    : undefined;
  return {
    cpId,
    wsUrl,
    connectors,
    vendor,
    model,
    basicAuth,
    ...(bootNotification ? { bootNotification } : {}),
  };
}
