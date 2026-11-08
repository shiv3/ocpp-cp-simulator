/* eslint-disable */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BehaviorLibrary } from "../../behavior/BehaviorLibrary";
import {
  connectTestClient,
  startTestServer,
} from "../../server/__tests__/socketHarness";

describe("behavior.reload on a big fleet", () => {
  it("answers with a result when more than 1000 stations refuse the new version", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sec-fleet-"));
    const f = path.join(dir, "a.ts");
    writeFileSync(f, `export default { api: 1, id: "a" };`);
    const lib = await BehaviorLibrary.fromFiles([f], () => undefined);
    const server = await startTestServer({ behaviors: lib });
    const socket = await connectTestClient(server);
    for (let i = 0; i < 1001; i++) {
      server.registry.create(
        {
          cpId: `F${i}`,
          wsUrl: "ws://127.0.0.1:65534/never",
          connectors: 1,
          vendor: "v",
          model: "m",
          basicAuth: null,
        } as any,
        { seedDefault: false },
      );
    }
    writeFileSync(
      f,
      `export default { api: 1, id: "a", requires: ["ocpp2.x"] };`,
    );
    const ack: any = await new Promise((r) =>
      socket.emit("rpc", { method: "behavior.reload", params: {} }, r),
    );
    socket.disconnect();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    console.log("ACK", JSON.stringify(ack).slice(0, 200));
    expect(ack.ok).toBe(true);
  }, 60000);
});
