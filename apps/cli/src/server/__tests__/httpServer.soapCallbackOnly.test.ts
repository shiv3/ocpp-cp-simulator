import { describe, expect, it } from "vitest";

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createSoapCallbackHandlers } from "../httpServer";

const BASE = "http://127.0.0.1:9702";

function request(path: string, init?: RequestInit): Request {
  return new Request(`${BASE}${path}`, init);
}

/**
 * #183: the listener a tunnel forwards to serves the CSMS→CP callback route
 * and nothing else. Every route the main listener has — the control plane,
 * the console, MCP, health, metrics — must be a 404 here, or the tunnel would
 * publish it.
 */
describe("createSoapCallbackHandlers (#183)", () => {
  const registry = new CPRegistry(new EventBus(), null);
  const handlers = createSoapCallbackHandlers({ registry: () => registry });

  it.each([
    ["GET", "/"],
    ["GET", "/index.html"],
    ["GET", "/v1/healthz"],
    ["GET", "/metrics"],
    ["GET", "/socket.io/?EIO=4&transport=polling"],
    ["POST", "/socket.io/?EIO=4&transport=polling"],
    ["POST", "/mcp"],
    ["POST", "/ocpp/soap"],
    ["POST", "/ocpp/soap/CP1"],
  ])("does not serve %s %s", async (method, path) => {
    const res = await handlers.fetch(request(path, { method }));
    expect(res.status).toBe(404);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("routes the callback path to the SOAP handler", async () => {
    const res = await handlers.fetch(
      request("/ocpp/soap/CP1/ChargePointService", { method: "POST" }),
    );
    // Unknown charge point: a SOAP fault, not the listener's plain 404 — the
    // request reached the route.
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Unknown charge point");
    const get = await handlers.fetch(
      request("/ocpp/soap/CP1/ChargePointService"),
    );
    expect(get.status).toBe(405);
  });

  it("answers 503 on the callback path until the registry exists, 404 elsewhere", async () => {
    const starting = createSoapCallbackHandlers({ registry: () => null });
    const soap = await starting.fetch(
      request("/ocpp/soap/CP1/ChargePointService", { method: "POST" }),
    );
    expect(soap.status).toBe(503);
    const other = await starting.fetch(request("/v1/healthz"));
    expect(other.status).toBe(404);
  });
});
