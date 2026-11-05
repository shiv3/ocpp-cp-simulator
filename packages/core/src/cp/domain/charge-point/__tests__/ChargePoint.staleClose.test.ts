import { afterEach, describe, expect, it, vi } from "vitest";
import { ChargePoint } from "../ChargePoint";
import { DefaultBootNotification, OCPPStatus } from "../../types/OcppTypes";

/**
 * #478: a real socket fires `close` asynchronously, so the socket a reset (or
 * a disconnect followed by a connect) replaces closes after the next one is
 * already open. That late close must leave the replacement alone, and the
 * charge point must report the disconnect once, before the next `connected`.
 */
class HeldCloseSocket {
  readyState: number = WebSocket.CONNECTING;
  sent: string[] = [];

  constructor(
    private readonly handlers: {
      onopen?: () => void;
      onmessage?: (ev: MessageEvent) => void;
      onclose?: (ev: CloseEvent) => void;
    },
  ) {}

  send(message: string): void {
    this.sent.push(message);
  }

  /** Held: the close event only lands when the test fires it. */
  close(): void {
    this.readyState = WebSocket.CLOSING;
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.handlers.onopen?.();
  }

  receive(frame: unknown): void {
    this.handlers.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(frame) }),
    );
  }

  fireClose(code: number): void {
    this.readyState = WebSocket.CLOSED;
    this.handlers.onclose?.(new CloseEvent("close", { code, reason: "" }));
  }
}

const sockets: HeldCloseSocket[] = [];

vi.mock("../../../infrastructure/transport/wsUrlWithBasic", async (orig) => ({
  ...(await orig<object>()),
  openOcppWebSocket: (
    options: ConstructorParameters<typeof HeldCloseSocket>[0],
  ) => {
    const socket = new HeldCloseSocket(options);
    sockets.push(socket);
    return socket;
  },
}));

function newChargePoint() {
  const cp = new ChargePoint(
    "test-cp-stale-close",
    DefaultBootNotification,
    1,
    "ws://localhost:8080",
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    {},
  );
  const events: string[] = [];
  const disconnected: unknown[] = [];
  cp.events.on("connected", () => events.push("connected"));
  cp.events.on("disconnected", (data) => {
    events.push("disconnected");
    disconnected.push(data);
  });
  return { cp, events, disconnected };
}

/** Opens the latest socket and accepts its BootNotification. */
async function openAndBoot(cp: ChargePoint): Promise<HeldCloseSocket> {
  const socket = sockets[sockets.length - 1];
  socket.open();
  const boot = await vi.waitFor(() => {
    const frame = socket.sent
      .map((raw) => JSON.parse(raw) as [number, string, string])
      .find(([, , action]) => action === "BootNotification");
    if (!frame) throw new Error("no BootNotification yet");
    return frame;
  });
  socket.receive([
    3,
    boot[1],
    {
      status: "Accepted",
      currentTime: new Date().toISOString(),
      interval: 300,
    },
  ]);
  await vi.waitFor(() => expect(cp.status).toBe(OCPPStatus.Available));
  return socket;
}

describe("ChargePoint stale socket close (#478)", () => {
  afterEach(() => {
    sockets.length = 0;
  });

  it.each([
    ["reset()", (cp: ChargePoint) => cp.reset()],
    [
      "disconnect() then connect()",
      (cp: ChargePoint) => {
        cp.disconnect();
        cp.connect();
      },
    ],
  ])(
    "%s: the old socket's late close leaves the replacement alone",
    async (_label, cycle) => {
      const { cp, events, disconnected } = newChargePoint();
      cp.connect();
      const oldSocket = await openAndBoot(cp);

      cycle(cp);
      expect(sockets).toHaveLength(2);
      await openAndBoot(cp);

      const outboxClosed = vi.spyOn(cp["_outbox"], "onWebSocketClosed");
      const heartbeatCleanup = vi.spyOn(cp["_heartbeat"], "cleanup");
      const reservationDispose = vi.spyOn(cp["_reservationManager"], "dispose");
      const localAuthDispose = vi.spyOn(cp["_localAuthListManager"], "dispose");

      oldSocket.fireClose(1005);

      expect(outboxClosed).not.toHaveBeenCalled();
      expect(heartbeatCleanup).not.toHaveBeenCalled();
      expect(reservationDispose).not.toHaveBeenCalled();
      expect(localAuthDispose).not.toHaveBeenCalled();
      expect(cp.status).toBe(OCPPStatus.Available);
      expect(cp.error).toBe("");
      // One disconnect for the cycle, reported before the replacement's
      // `connected` so no consumer sees a live connection go down.
      expect(events).toEqual(["connected", "disconnected", "connected"]);
      expect(disconnected).toEqual([{ code: 1005, reason: "" }]);

      cp.dispose();
    },
  );

  it("keeps the Local Authorization List across a connection loss, and only dispose() drops it (#534)", async () => {
    const { cp } = newChargePoint();
    cp.connect();
    const socket = await openAndBoot(cp);
    const list = cp["_localAuthListManager"];
    list.applyFull(
      3,
      [{ idTag: "LISTED", idTagInfo: { status: "Accepted" } }],
      { localAuthListMaxLength: 10, sendLocalListMaxLength: 10 },
    );

    socket.fireClose(1006);

    expect(cp.status).toBe(OCPPStatus.Unavailable);
    expect(list.getEntry("LISTED")).toEqual({ status: "Accepted" });
    expect(list.getVersion()).toBe(3);

    cp.dispose();
    expect(list.getEntry("LISTED")).toBeUndefined();
    expect(list.getVersion()).toBe(0);
  });
});
