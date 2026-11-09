import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { OCPPWebSocket } from "../OCPPWebSocket";
import type { Logger } from "../../../shared/Logger";
import type { WsClientOptions } from "../../../shared/WsClientOptions";

// #611: the PoC, kept as a test. Real Bun sockets against local servers, so a
// Bun release that starts (or stops) honouring an option shows up here and the
// support matrix in WsClientOptions.ts is corrected, not guessed.

const logger = (): Logger =>
  ({ info: () => {}, warn: () => {}, error: () => {} }) as unknown as Logger;

// Last registered, first undone (client, then proxy, then CSMS), and awaited,
// so a test's sockets are gone before the next test starts: an error left over
// from one test is otherwise reported against the next one (#825).
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/**
 * A `net` server whose sockets cannot kill the test run. The Bun client ends a
 * connection with a reset (a closed WebSocket, a handshake timeout, dispose),
 * and a server-side socket without an 'error' listener turns that ECONNRESET
 * into an unhandled error that fails whichever test is running at the time
 * (#825). Every accepted socket gets a listener and is destroyed on cleanup.
 */
function netServer(onConnection: (socket: net.Socket) => void): net.Server {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return server;
}

function until<T>(fn: () => T | undefined, ms = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const v = fn();
      if (v !== undefined) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error("timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** A CSMS that records the upgrade request and sends one big message. */
function startCsms() {
  const upgrades: { extensions: string | null; remote: string | null }[] = [];
  const received: number[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      upgrades.push({
        extensions: req.headers.get("sec-websocket-extensions"),
        remote: srv.requestIP(req)?.address ?? null,
      });
      if (
        srv.upgrade(req, { headers: { "Sec-WebSocket-Protocol": "ocpp1.6" } })
      ) {
        return undefined;
      }
      return new Response("no", { status: 400 });
    },
    websocket: {
      perMessageDeflate: true,
      open(ws) {
        ws.send("x".repeat(200_000));
      },
      message(_ws, message) {
        received.push(String(message).length);
      },
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `ws://127.0.0.1:${server.port}`, upgrades };
}

function client(url: string, options: WsClientOptions) {
  const ws = new OCPPWebSocket(url, "CP-611", logger());
  ws.setWsClientOptions(options);
  cleanups.push(() => ws.dispose());
  return ws;
}

describe("Bun WebSocket client options (#611 PoC, Bun 1.3.14)", () => {
  it("offers permessage-deflate by default and stops with perMessageDeflate:false", async () => {
    const csms = startCsms();
    const a = client(csms.url, {});
    a.connect();
    await until(() => (csms.upgrades.length > 0 ? true : undefined));
    expect(csms.upgrades[0].extensions).toContain("permessage-deflate");
    a.dispose();

    const b = client(csms.url, { perMessageDeflate: false });
    b.connect();
    await until(() => (csms.upgrades.length > 1 ? true : undefined));
    expect(csms.upgrades[1].extensions).toBeNull();
  });

  it("sends the upgrade through an HTTP proxy with CONNECT", async () => {
    const csms = startCsms();
    const lines: string[] = [];
    const proxy = netServer((client) => {
      client.once("data", (data) => {
        const text = data.toString();
        lines.push(text.split("\r\n")[0]);
        const m = /^CONNECT ([^:]+):(\d+)/.exec(text);
        if (!m) return client.destroy();
        const upstream = net.connect(Number(m[2]), m[1], () => {
          client.write("HTTP/1.1 200 Connection established\r\n\r\n");
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on("error", () => client.destroy());
        client.on("close", () => upstream.destroy());
        cleanups.push(() => upstream.destroy());
      });
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const port = (proxy.address() as net.AddressInfo).port;

    const ws = client(csms.url, { proxy: `http://127.0.0.1:${port}` });
    ws.connect();
    await until(() => (csms.upgrades.length > 0 ? true : undefined));
    expect(lines[0]).toMatch(/^CONNECT 127\.0\.0\.1:\d+ HTTP\/1\.1$/);
  });

  it("times a silent handshake out itself and schedules a reconnect", async () => {
    const silent = netServer(() => {});
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
    const port = (silent.address() as net.AddressInfo).port;

    const ws = client(`ws://127.0.0.1:${port}`, { handshakeTimeoutMs: 300 });
    const notices: { attempt: number }[] = [];
    ws.observers.on("reconnectScheduled", (n) => notices.push(n));
    const t0 = Date.now();
    ws.connect();
    await until(() => (notices.length > 0 ? true : undefined));
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it("canary: Bun ignores maxPayloadBytes and localAddress, so they are refused", async () => {
    // If this fails, Bun learned the option: move it in WsClientOptions.ts's
    // matrix and delete the refusal instead of the test.
    const csms = startCsms();
    const probe = new (
      WebSocket as unknown as new (url: string, o: object) => WebSocket
    )(csms.url, {
      protocols: ["ocpp1.6"],
      maxPayload: 1024,
      localAddress: "127.0.0.2",
    });
    const got = await new Promise<number>((resolve) => {
      let total = 0;
      probe.onmessage = (e) => {
        total += String(e.data).length;
        resolve(total);
      };
      probe.onclose = () => resolve(total);
    });
    probe.close();
    expect(got).toBe(200_000);
    expect(csms.upgrades.at(-1)?.remote).toBe("127.0.0.1");
  });
});
