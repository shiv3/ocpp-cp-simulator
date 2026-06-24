import { describe, it, expect } from "bun:test";
import { startMockCsms } from "./mockCsms";

describe("mock CSMS harness", () => {
  it("captures a raw client frame and rejects pending waiters on stop", async () => {
    const csms = startMockCsms();
    const client = new WebSocket(csms.url);
    await new Promise<void>((resolve, reject) => {
      client.onopen = () => resolve();
      client.onerror = () => reject(new Error("client failed to open"));
    });

    client.send(JSON.stringify([2, "m1", "Heartbeat", {}]));
    const call = await csms.waitForCall("Heartbeat");
    expect(call.messageId).toBe("m1");

    const pending = csms.waitForCall("NeverArrives", 5000);
    csms.stop();
    await expect(pending).rejects.toThrow("mock CSMS stopped");
    client.close();
  });
});
