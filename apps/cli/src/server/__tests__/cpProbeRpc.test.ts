import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { CPRegistry } from "../CPRegistry";
import { EventBus } from "../eventBus";
import { createRuntimeDeps, runRpc } from "../socketServer";

/**
 * #1132 — `cp.probe` on the daemon: the verdict for a refused connection is a
 * result, nothing is registered, and params that describe no WebSocket
 * station answer `invalid_params`.
 */

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function refusing(status: number): Promise<number> {
  const server = createServer();
  server.on("upgrade", (_req, socket) => {
    socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Length: 0\r\n\r\n`);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

function deps() {
  const bus = new EventBus();
  return createRuntimeDeps({ registry: new CPRegistry(bus), bus });
}

describe("cp.probe (#1132)", () => {
  it("returns the verdict and registers nothing", async () => {
    const port = await refusing(404);
    const runtime = deps();
    const result = await runRpc(runtime, {
      method: "cp.probe",
      params: {
        cpId: "CP001",
        wsUrl: [`ws://127.0.0.1:${port}/ocpp`, "ws://127.0.0.1:1/other"],
        basicAuth: { username: "CP001", password: "s3cret" },
        timeoutMs: 3000,
      },
    });
    expect(result).toMatchObject({
      ok: false,
      code: "path_not_found",
      stage: "upgrade",
      httpStatus: 404,
      url: `ws://127.0.0.1:${port}/ocpp/CP001`,
    });
    expect((result as { warnings: string[] }).warnings[0]).toContain(
      "first of 2",
    );
    expect(JSON.stringify(result)).not.toContain("s3cret");
    expect(await runRpc(runtime, { method: "cp.list", params: {} })).toEqual(
      [],
    );
  });

  it("refuses params that describe no WebSocket station", async () => {
    const runtime = deps();
    for (const params of [
      {
        cpId: "CP001",
        wsUrl: "http://csms.example/ocpp",
        ocppVersion: "OCPP-1.6S",
        soapCallbackUrl: "http://sim.example/cb",
      },
      { cpId: "CP001", wsUrl: "ws://csms.example/ocpp", ocppVersion: "9" },
      {
        cpId: "CP001",
        wsUrl: "ws://csms.example/ocpp",
        tlsCaPath: "/nonexistent/ca.pem",
      },
    ]) {
      await expect(
        runRpc(runtime, { method: "cp.probe", params }),
      ).rejects.toMatchObject({ code: "invalid_params" });
    }
  });
});
