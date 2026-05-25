import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { handleJsonCommand } from "../jsonMode";
import { toJsonResponse, toJsonEvent } from "../output";
import type { JsonCommand, ChargePointInitOptions } from "../types";
import type { CPRegistry } from "./CPRegistry";
import type { EventBus } from "./eventBus";
import type { Lifecycle } from "./lifecycle";

interface SocketData {
  scope: string;
  unsub?: () => void;
}

export interface HttpHandlers {
  fetch: (
    req: Request,
    server: Server<SocketData>,
  ) => Response | Promise<Response> | undefined | Promise<undefined>;
  websocket: WebSocketHandler<SocketData>;
}

export function createHttpHandlers(deps: {
  registry: CPRegistry;
  bus: EventBus;
  lifecycle: Lifecycle;
}): HttpHandlers {
  const { registry, bus, lifecycle } = deps;

  return {
    fetch(req, server) {
      // Reserved hook: authentication middleware can be added here.

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
          .catch(() =>
            Response.json({ ok: false, error: "invalid JSON body" }),
          );
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

      return new Response("not found", { status: 404 });
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
  return { cpId, wsUrl, connectors, vendor, model, basicAuth };
}
