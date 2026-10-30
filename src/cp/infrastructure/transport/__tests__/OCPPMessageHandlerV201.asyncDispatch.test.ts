import { describe, expect, it, vi } from "vitest";
import { OCPPMessageHandlerV201 } from "../OCPPMessageHandlerV201";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { Logger } from "../../../shared/Logger";
import { OCPPMessageType } from "../../../domain/types/OcppTypes";
import type { Settlement, GenerationToken } from "../network-sim";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import {
  ConfigurationKeys,
  ConfigurationStore,
} from "../../../domain/charge-point/ConfigurationStore";
import {
  handleGetBaseReportV201,
  type V201HandlerResult,
  type V201InboundHandler,
  type V201InboundRegistry,
} from "../v201/inboundRegistryV201";

/**
 * #456: a 2.x inbound handler may return a promise (certificate hashing is
 * asynchronous). The dispatcher awaits only real thenables, so a
 * synchronous handler still answers in the same tick as its CALL.
 */

type WireEvent =
  | { kind: "result"; messageId: string; payload: unknown }
  | {
      kind: "error";
      messageId: string;
      payload: { errorCode: string; errorDescription: string };
    }
  | { kind: "call"; messageId: string; action: string; payload: unknown };

class FakeSocket {
  readonly wire: WireEvent[] = [];
  readonly settlements = new Map<string, (s: Settlement) => void>();
  private handler:
    | ((type: number, id: string, action: string, payload: unknown) => void)
    | null = null;

  setMessageHandler(
    h: (type: number, id: string, action: string, payload: unknown) => void,
  ): void {
    this.handler = h;
  }
  onCloseTransaction(): void {}
  generation = 1;
  currentGeneration(): GenerationToken {
    return {
      gen: this.generation,
      closeCause: null,
    } as unknown as GenerationToken;
  }
  isConnected(): boolean {
    return true;
  }
  sendAction(
    messageId: string,
    action: string,
    payload: unknown,
    _gen: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): boolean {
    this.wire.push({ kind: "call", messageId, action, payload });
    onSettled?.({ outcome: "written" });
    return true;
  }
  sendResult(
    messageId: string,
    payload: unknown,
    _gen: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): void {
    this.wire.push({ kind: "result", messageId, payload });
    if (onSettled) this.settlements.set(messageId, onSettled);
  }
  sendError(
    messageId: string,
    payload: { errorCode: string; errorDescription: string },
  ): void {
    this.wire.push({ kind: "error", messageId, payload });
  }
  deliver(messageId: string, action: string, payload: unknown): void {
    this.handler?.(OCPPMessageType.CALL, messageId, action, payload);
  }
  deliverResult(messageId: string, payload: unknown): void {
    this.handler?.(OCPPMessageType.CALLRESULT, messageId, "", payload);
  }
  settle(messageId: string): void {
    this.settlements.get(messageId)?.({ outcome: "written" });
  }
}

function setup(entries: Record<string, V201InboundHandler>) {
  const socket = new FakeSocket();
  const configuration = new ConfigurationStore(
    "cp-test",
    [{ key: ConfigurationKeys.Core.HeartbeatInterval, value: 300 }],
    null,
  );
  const chargePoint = {
    id: "cp-test",
    configuration,
    // #538: GetBaseReport lists the per-EVSE variables of each connector.
    connectors: new Map(),
    notifyIncomingCall: vi.fn(),
    notifyIncomingCallCompleted: vi.fn(),
    notifyOutgoingCall: vi.fn(),
    getInboundCallPolicy: vi.fn(() => undefined),
    hasResponseOverride: vi.fn(() => false),
    consumeResponseOverride: vi.fn(() => null),
    clearResponseOverride: vi.fn(),
    certificateStore: { recordPendingCsr: vi.fn(() => true) },
  } as unknown as ChargePoint;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  const registry: V201InboundRegistry = new Map(Object.entries(entries));
  const handler = new OCPPMessageHandlerV201(
    chargePoint,
    socket as unknown as OCPPWebSocket,
    logger,
    registry,
  );
  return { socket, chargePoint, handler, logger };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("OCPPMessageHandlerV201 async inbound handlers (#456)", () => {
  it("keeps GetBaseReport synchronous: CALLRESULT in the same tick, NotifyReport only after it is written", async () => {
    const { socket } = setup({
      GetBaseReport: { validate: () => true, handle: handleGetBaseReportV201 },
    });

    socket.deliver("gbr-1", "GetBaseReport", {
      requestId: 7,
      reportBase: "FullInventory",
    });

    // No await between the delivery and this check: an unconditional
    // `await` in the dispatcher would leave the wire empty here.
    expect(socket.wire).toEqual([
      { kind: "result", messageId: "gbr-1", payload: { status: "Accepted" } },
    ]);

    await flush();
    expect(socket.wire).toHaveLength(1);

    socket.settle("gbr-1");
    await flush();
    expect(socket.wire.map((e) => e.kind)).toEqual(["result", "call"]);
    expect(socket.wire[1]).toMatchObject({
      kind: "call",
      action: "NotifyReport",
      payload: { requestId: 7 },
    });
  });

  it("sends an async handler's CALLRESULT once, under the CALL's id, and runs its afterResult once written", async () => {
    let release!: (r: V201HandlerResult) => void;
    const afterResult = vi.fn();
    const { socket, chargePoint } = setup({
      InstallCertificate: {
        validate: () => true,
        handle: () =>
          new Promise<V201HandlerResult>((resolve) => {
            release = resolve;
          }),
      },
    });

    socket.deliver("async-1", "InstallCertificate", {});
    expect(socket.wire).toEqual([]);

    release({ response: { status: "Accepted" }, afterResult });
    await flush();

    expect(socket.wire).toEqual([
      {
        kind: "result",
        messageId: "async-1",
        payload: { status: "Accepted" },
      },
    ]);
    expect(chargePoint.notifyIncomingCallCompleted).toHaveBeenCalledTimes(1);
    expect(chargePoint.notifyIncomingCallCompleted).toHaveBeenCalledWith({
      action: "InstallCertificate",
      messageId: "async-1",
      outcome: "CallResult",
    });
    expect(afterResult).not.toHaveBeenCalled();

    socket.settle("async-1");
    await flush();
    expect(afterResult).toHaveBeenCalledTimes(1);
    expect(socket.wire).toHaveLength(1);
  });

  it("answers a rejected handler promise with an InternalError CALLERROR", async () => {
    const { socket } = setup({
      InstallCertificate: {
        validate: () => true,
        handle: () => Promise.reject(new Error("x".repeat(300))),
      },
    });

    socket.deliver("async-2", "InstallCertificate", {});
    await flush();

    expect(socket.wire).toHaveLength(1);
    expect(socket.wire[0]).toMatchObject({
      kind: "error",
      messageId: "async-2",
      payload: { errorCode: "InternalError" },
    });
    const error = socket.wire[0] as Extract<WireEvent, { kind: "error" }>;
    expect(error.payload.errorDescription).toHaveLength(255);
  });

  it("drops a late answer after a reconnect: nothing written, afterResult never run", async () => {
    let release!: (r: V201HandlerResult) => void;
    const afterResult = vi.fn();
    const { socket, chargePoint, handler } = setup({
      InstallCertificate: {
        validate: () => true,
        handle: () =>
          new Promise<V201HandlerResult>((resolve) => {
            release = resolve;
          }),
      },
    });
    const register = vi.spyOn(
      (handler as unknown as { _responseEffectQueue: { register: () => void } })
        ._responseEffectQueue,
      "register",
    );

    socket.deliver("late-1", "InstallCertificate", {});
    socket.generation = 2;
    release({ response: { status: "Accepted" }, afterResult });
    await flush();

    expect(socket.wire).toEqual([]);
    expect(register).not.toHaveBeenCalled();
    expect(afterResult).not.toHaveBeenCalled();
    expect(chargePoint.notifyIncomingCallCompleted).toHaveBeenCalledTimes(1);
    expect(chargePoint.notifyIncomingCallCompleted).toHaveBeenCalledWith({
      action: "InstallCertificate",
      messageId: "late-1",
      outcome: "NoResponse",
    });
  });

  it("drops a late rejection after a reconnect instead of answering InternalError", async () => {
    let fail!: (error: Error) => void;
    const { socket, chargePoint } = setup({
      InstallCertificate: {
        validate: () => true,
        handle: () =>
          new Promise<V201HandlerResult>((_resolve, reject) => {
            fail = reject;
          }),
      },
    });

    socket.deliver("late-2", "InstallCertificate", {});
    socket.generation = 2;
    fail(new Error("boom"));
    await flush();

    expect(socket.wire).toEqual([]);
    expect(chargePoint.notifyIncomingCallCompleted).toHaveBeenCalledWith({
      action: "InstallCertificate",
      messageId: "late-2",
      outcome: "NoResponse",
    });
  });

  it("answers a thenable that is not a Promise (its then returns nothing)", async () => {
    const { socket } = setup({
      InstallCertificate: {
        validate: () => true,
        handle: () =>
          ({
            then(resolve: (r: V201HandlerResult) => void) {
              resolve({ response: { status: "Accepted" } });
            },
          }) as unknown as Promise<V201HandlerResult>,
      },
    });

    expect(() =>
      socket.deliver("thenable-1", "InstallCertificate", {}),
    ).not.toThrow();
    await flush();

    expect(socket.wire).toEqual([
      {
        kind: "result",
        messageId: "thenable-1",
        payload: { status: "Accepted" },
      },
    ]);
  });

  it("still answers a synchronously throwing handler with InternalError", () => {
    const { socket } = setup({
      InstallCertificate: {
        validate: () => true,
        handle: () => {
          throw new Error("boom");
        },
      },
    });

    socket.deliver("sync-err", "InstallCertificate", {});

    expect(socket.wire).toEqual([
      {
        kind: "error",
        messageId: "sync-err",
        payload: expect.objectContaining({
          errorCode: "InternalError",
          errorDescription: "boom",
        }),
      },
    ]);
  });
});

describe("OCPPMessageHandlerV201 SignCertificateResponse (#456)", () => {
  async function signAndAnswer(status: string) {
    const env = setup({});
    await env.handler.sendSignCertificate(
      "-----BEGIN CERTIFICATE REQUEST-----",
    );
    const [sent] = env.socket.wire;
    expect(sent).toMatchObject({
      kind: "call",
      action: "SignCertificate",
      payload: { csr: "-----BEGIN CERTIFICATE REQUEST-----" },
    });
    env.socket.deliverResult(
      (sent as Extract<WireEvent, { kind: "call" }>).messageId,
      { status },
    );
    return env;
  }

  it("logs an Accepted answer at INFO", async () => {
    const { logger } = await signAndAnswer("Accepted");
    expect(logger.info).toHaveBeenCalledWith(
      "[v2.0.1] SignCertificate accepted by the CSMS; awaiting CertificateSigned",
      expect.anything(),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs any other answer at WARN and keeps the CSR pending", async () => {
    const { logger, chargePoint } = await signAndAnswer("Rejected");
    expect(logger.warn).toHaveBeenCalledWith(
      "[v2.0.1] SignCertificate not accepted by the CSMS (status Rejected); the CSR stays pending",
      expect.anything(),
    );
    expect(chargePoint.certificateStore.recordPendingCsr).toHaveBeenCalledTimes(
      1,
    );
    expect(logger.info).not.toHaveBeenCalled();
  });
});
