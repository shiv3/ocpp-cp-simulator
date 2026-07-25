import { describe, it, expect, afterEach } from "bun:test";
import { startMockCsms, type MockCsms } from "./mockCsms";

// Every server and client goes through these so a failing assertion can't
// strand a listening Bun.serve or an open socket in the next test's process.
const openServers: MockCsms[] = [];
const openClients: WebSocket[] = [];

function trackedCsms(): MockCsms {
  const csms = startMockCsms();
  openServers.push(csms);
  return csms;
}

function trackedClient(url: string): WebSocket {
  const client = new WebSocket(url);
  openClients.push(client);
  return client;
}

afterEach(async () => {
  for (const client of openClients.splice(0)) client.close();
  // stop() is safe to call twice — several tests stop the server mid-body to
  // assert that pending waiters reject.
  await Promise.all(openServers.splice(0).map((csms) => csms.stop()));
});

describe("mock CSMS harness", () => {
  it("captures a raw client frame and rejects pending waiters on stop", async () => {
    const csms = trackedCsms();
    const client = trackedClient(csms.url);
    await new Promise<void>((resolve, reject) => {
      client.onopen = () => resolve();
      client.onerror = () => reject(new Error("client failed to open"));
    });

    client.send(JSON.stringify([2, "m1", "Heartbeat", {}]));
    const call = await csms.waitForCall("Heartbeat");
    expect(call.messageId).toBe("m1");

    const pending = csms.waitForCall("NeverArrives", 5000);
    void pending.catch(() => undefined);
    await csms.stop();
    await expect(pending).rejects.toThrow("mock CSMS stopped");
    client.close();
  });

  it("rejects pending connection waiters on stop", async () => {
    const csms = trackedCsms();
    const pending = csms.waitForConnection(5000);
    void pending.catch(() => undefined);
    await csms.stop();
    await expect(pending).rejects.toThrow("mock CSMS stopped");
  });
});

// Helper function to wait for WebSocket to open
async function waitForWebSocketOpen(
  ws: WebSocket,
  timeoutMs = 1000,
): Promise<void> {
  await Promise.race([
    new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    }),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("WebSocket open timeout")), timeoutMs),
    ),
  ]);
}

describe("mockCsms extensions (new API)", () => {
  it("increments open and close counters across sequential connections", async () => {
    const mock = trackedCsms();

    expect(mock.openCount()).toBe(0);
    expect(mock.closeCount()).toBe(0);

    // First connection
    const ws1 = trackedClient(mock.url);
    await waitForWebSocketOpen(ws1);
    expect(mock.openCount()).toBe(1);
    expect(mock.closeCount()).toBe(0);

    // Send a frame on first connection
    ws1.send(JSON.stringify([1, "msg-1", "Heartbeat", {}]));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Use server-initiated close
    mock.closeCurrentConnection();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mock.openCount()).toBe(1);
    expect(mock.closeCount()).toBe(1);

    // Second connection
    const ws2 = trackedClient(mock.url);
    await waitForWebSocketOpen(ws2);
    expect(mock.openCount()).toBe(2);
    expect(mock.closeCount()).toBe(1);

    // Send a frame on second connection
    ws2.send(JSON.stringify([1, "msg-2", "Heartbeat", {}]));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Use server-initiated close again
    mock.closeCurrentConnection();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mock.openCount()).toBe(2);
    expect(mock.closeCount()).toBe(2);
  });

  it("captures per-connection transcripts with separate frame records", async () => {
    const mock = trackedCsms();

    const ws1 = trackedClient(mock.url);
    await waitForWebSocketOpen(ws1);

    // Send multiple frames on first connection
    ws1.send(JSON.stringify([1, "msg-1", "Heartbeat", {}]));
    ws1.send(JSON.stringify([1, "msg-2", "Heartbeat", {}]));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Close first connection via server
    mock.closeCurrentConnection();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Second connection
    const ws2 = trackedClient(mock.url);
    await waitForWebSocketOpen(ws2);

    // Send frames on second connection
    ws2.send(JSON.stringify([1, "msg-3", "Heartbeat", {}]));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Close second connection via server
    mock.closeCurrentConnection();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify per-connection transcripts
    const conns = mock.connections();
    expect(conns).toHaveLength(2);

    // First connection should have 2 frames
    expect(conns[0].frames).toHaveLength(2);
    expect(conns[0].frames[0].raw).toBe(
      JSON.stringify([1, "msg-1", "Heartbeat", {}]),
    );
    expect(conns[0].frames[1].raw).toBe(
      JSON.stringify([1, "msg-2", "Heartbeat", {}]),
    );
    expect(conns[0].closedAt).not.toBeNull();

    // Second connection should have 1 frame
    expect(conns[1].frames).toHaveLength(1);
    expect(conns[1].frames[0].raw).toBe(
      JSON.stringify([1, "msg-3", "Heartbeat", {}]),
    );
    expect(conns[1].closedAt).not.toBeNull();
  });

  it("captures receivedAt timestamps and maintains monotonicity within a connection", async () => {
    const mock = trackedCsms();

    const ws = trackedClient(mock.url);
    await waitForWebSocketOpen(ws);

    const sendTime = Date.now();
    ws.send(JSON.stringify([1, "msg-1", "Heartbeat", {}]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    ws.send(JSON.stringify([1, "msg-2", "Heartbeat", {}]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    ws.send(JSON.stringify([1, "msg-3", "Heartbeat", {}]));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Close via server
    mock.closeCurrentConnection();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const conns = mock.connections();
    expect(conns).toHaveLength(1);

    const conn = conns[0];
    expect(conn.frames).toHaveLength(3);

    // All receivedAt should be numbers
    expect(typeof conn.frames[0].receivedAt).toBe("number");
    expect(typeof conn.frames[1].receivedAt).toBe("number");
    expect(typeof conn.frames[2].receivedAt).toBe("number");

    // receivedAt should be monotonically non-decreasing
    expect(conn.frames[0].receivedAt).toBeLessThanOrEqual(
      conn.frames[1].receivedAt,
    );
    expect(conn.frames[1].receivedAt).toBeLessThanOrEqual(
      conn.frames[2].receivedAt,
    );

    // All receivedAt should be >= sendTime (approximately)
    expect(conn.frames[0].receivedAt).toBeGreaterThanOrEqual(sendTime);
  });

  it("closeCurrentConnection() triggers the close handler on the server", async () => {
    const mock = trackedCsms();

    const ws = trackedClient(mock.url);
    await waitForWebSocketOpen(ws);

    expect(mock.openCount()).toBe(1);
    expect(mock.closeCount()).toBe(0);

    const conns1 = mock.connections();
    expect(conns1[0].closedAt).toBeNull();

    // Server initiates close
    mock.closeCurrentConnection();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify server-side state was updated
    expect(mock.closeCount()).toBe(1);

    const conns = mock.connections();
    expect(conns).toHaveLength(1);
    expect(conns[0].closedAt).not.toBeNull();
  });

  it("maintains both flat received[] and per-connection transcripts in sync", async () => {
    const mock = trackedCsms();

    const ws1 = trackedClient(mock.url);
    await waitForWebSocketOpen(ws1);

    ws1.send(JSON.stringify([1, "msg-1", "Heartbeat", {}]));
    ws1.send(JSON.stringify([1, "msg-2", "BootNotification", {}]));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Close via server
    mock.closeCurrentConnection();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const ws2 = trackedClient(mock.url);
    await waitForWebSocketOpen(ws2);

    ws2.send(JSON.stringify([1, "msg-3", "Heartbeat", {}]));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Close via server
    mock.closeCurrentConnection();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify flat received list has all frames
    expect(mock.received).toHaveLength(3);
    expect(mock.received[0][1]).toBe("msg-1");
    expect(mock.received[1][1]).toBe("msg-2");
    expect(mock.received[2][1]).toBe("msg-3");

    // Verify per-connection transcripts sum to the same
    const conns = mock.connections();
    const totalFrames = conns.reduce((sum, c) => sum + c.frames.length, 0);
    expect(totalFrames).toBe(3);
  });

  it("existing API (waitForCall, replyCallResult) still works", async () => {
    const mock = trackedCsms();

    const ws = trackedClient(mock.url);
    await waitForWebSocketOpen(ws);

    // Send a CALL frame
    ws.send(JSON.stringify([2, "msg-uuid", "Heartbeat", {}]));

    // Use existing waitForCall to receive it
    const callFrame = await mock.waitForCall("Heartbeat", 2000);
    expect(callFrame.messageId).toBe("msg-uuid");

    // Use existing replyCallResult to send response
    mock.replyCallResult("msg-uuid", {});
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Close via server
    mock.closeCurrentConnection();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});
