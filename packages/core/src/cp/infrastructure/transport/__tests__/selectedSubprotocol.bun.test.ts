import { afterEach, describe, expect, it } from "bun:test";

import { Logger } from "../../../shared/Logger";
import { OCPPWebSocket } from "../OCPPWebSocket";
import { LOOPBACK, tcpPort } from "../../../../test/bunServe";

/**
 * #1061 — the subprotocol the CSMS selected is checked after the upgrade.
 * A matching selection opens as before; an absent or a different one is
 * logged and the connection is closed with 1002 without ever reporting open.
 */

const servers: Array<{ stop(force?: boolean): void }> = [];
const sockets: OCPPWebSocket[] = [];

afterEach(() => {
  for (const s of sockets.splice(0)) s.dispose();
  for (const s of servers.splice(0)) s.stop(true);
});

/** A CSMS that upgrades and answers with `selected`. Without a header Bun's
 *  server echoes the first offered protocol itself, so "none" needs the
 *  stand-in below. */
function csms(selected: string | undefined): number {
  const server = Bun.serve({
    port: 0,
    hostname: LOOPBACK,
    fetch(req, srv) {
      const ok =
        selected === undefined
          ? srv.upgrade(req)
          : srv.upgrade(req, {
              headers: { "Sec-WebSocket-Protocol": selected },
            });
      return ok ? undefined : new Response("no", { status: 426 });
    },
    websocket: { open() {}, message() {} },
  });
  servers.push(server);
  return tcpPort(server);
}

async function attempt(port: number) {
  const lines: string[] = [];
  const logger = new Logger();
  logger.on("log", (e: { message: string }) => lines.push(e.message));
  const socket = new OCPPWebSocket(
    `ws://127.0.0.1:${port}/ocpp/`,
    "CP001",
    logger,
    null,
  );
  sockets.push(socket);
  let opened = false;
  const closes: number[] = [];
  socket.connect(
    () => {
      opened = true;
    },
    (ev) => closes.push(ev.code),
  );
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && !opened && closes.length === 0) {
    await Bun.sleep(25);
  }
  await Bun.sleep(100);
  return { lines, opened, closes };
}

/**
 * Bun's own client already refuses a missing or foreign selection (1002,
 * "Mismatch client protocol"), a browser accepts a missing one, so the check
 * is driven through a stand-in `WebSocket` that opens with a chosen protocol.
 */
class FakeWebSocket extends EventTarget {
  static selected = "";
  static readonly instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  readonly protocol: string = FakeWebSocket.selected;
  readonly closedWith: Array<[number | undefined, string | undefined]> = [];
  readonly extensions = "";
  readonly bufferedAmount = 0;
  binaryType = "blob";
  constructor(
    readonly url: string,
    readonly offered: string | string[] = [],
  ) {
    super();
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    });
  }
  send() {}
  close(code?: number, reason?: string) {
    this.closedWith.push([code, reason]);
    this.readyState = 3;
    const ev = new Event("close") as Event & Record<string, unknown>;
    ev.code = code ?? 1005;
    ev.reason = reason ?? "";
    ev.wasClean = true;
    this.dispatchEvent(ev);
  }
}

async function viaFake(selected: string) {
  const RealWebSocket = globalThis.WebSocket;
  FakeWebSocket.selected = selected;
  FakeWebSocket.instances.length = 0;
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  try {
    const lines: string[] = [];
    const logger = new Logger();
    logger.on("log", (e: { message: string }) => lines.push(e.message));
    const socket = new OCPPWebSocket(
      "ws://127.0.0.1:1/ocpp/",
      "CP001",
      logger,
      null,
    );
    sockets.push(socket);
    let opened = false;
    socket.connect(() => {
      opened = true;
    });
    await Bun.sleep(50);
    return { lines, opened, fake: FakeWebSocket.instances[0] };
  } finally {
    (globalThis as { WebSocket: unknown }).WebSocket = RealWebSocket;
  }
}

describe("selected subprotocol (#1061)", () => {
  it("opens when the CSMS selects the offered version", async () => {
    const r = await attempt(csms("ocpp1.6"));
    expect(r.opened).toBe(true);
    expect(r.lines.some((l) => l.includes("subprotocol"))).toBe(false);
  });

  it("accepts the stand-in's matching selection too", async () => {
    const r = await viaFake("ocpp1.6");
    expect(r.opened).toBe(true);
    expect(r.fake.closedWith).toEqual([]);
  });

  it("logs and closes with 1002 when no subprotocol was selected", async () => {
    const r = await viaFake("");
    expect(r.opened).toBe(false);
    expect(r.fake.closedWith[0]?.[0]).toBe(1002);
    expect(
      r.lines.some((l) => l.includes("selected no WebSocket subprotocol")),
    ).toBe(true);
  });

  it("logs and closes with 1002 when a version that was not offered is selected", async () => {
    const r = await viaFake("ocpp2.0.1");
    expect(r.opened).toBe(false);
    expect(r.fake.closedWith[0]?.[0]).toBe(1002);
    expect(
      r.lines.some((l) =>
        l.includes('selected the WebSocket subprotocol "ocpp2.0.1"'),
      ),
    ).toBe(true);
  });

  it("never reports open against a real server that selects another version", async () => {
    const r = await attempt(csms("ocpp2.0.1"));
    expect(r.opened).toBe(false);
    expect(r.closes[0]).toBe(1002);
  });
});
