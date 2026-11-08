import { describe, expect, it, vi } from "vitest";
import { ChargePoint } from "../ChargePoint";
import type {
  ChargePointDeps,
  ChargePointTransport,
  TransportContext,
} from "../ChargePointDeps";
import { createDefaultTransport } from "../../../infrastructure/charge-point/createDefaultTransport";
import { LogRepository } from "../../../infrastructure/persistence/LogRepository";
import { UploadFile } from "../../../infrastructure/fileUpload";
import { DefaultBootNotification } from "../../types/OcppTypes";
import type { LogSink } from "../../persistence/LogSink";

/**
 * #575: the charge point builds its transport through
 * `deps.createTransport`, then wires the reconnect policy, the WS client
 * options and the observer re-emits against the socket port it got back.
 */
function build(
  ocppVersion: string,
  wrap: (transport: ChargePointTransport) => ChargePointTransport = (t) => t,
  transportOptions: ConstructorParameters<typeof ChargePoint>[10] = {},
  overrides: Partial<Omit<ChargePointDeps, "createTransport">> = {},
): {
  cp: ChargePoint;
  calls: { cp: ChargePoint; ctx: TransportContext }[];
  transport: () => ChargePointTransport;
} {
  const calls: { cp: ChargePoint; ctx: TransportContext }[] = [];
  let built: ChargePointTransport | undefined;
  const deps: ChargePointDeps = {
    createTransport: (cp, ctx) => {
      calls.push({ cp, ctx });
      built = wrap(createDefaultTransport(cp, ctx));
      return built;
    },
    logSink: overrides.logSink ?? new LogRepository(null),
    fileUploader: overrides.fileUploader ?? UploadFile,
  };
  const cp = new ChargePoint(
    "cp-deps",
    DefaultBootNotification,
    1,
    "ws://localhost:9/ocpp",
    { username: "u", password: "p" },
    null,
    null,
    { "X-Extra": "1" },
    ["ocpp1.6"],
    ocppVersion,
    transportOptions,
    undefined,
    undefined,
    undefined,
    undefined,
    {},
    deps,
  );
  return {
    cp,
    calls,
    transport: () => {
      if (!built) throw new Error("createTransport was not called");
      return built;
    },
  };
}

describe("ChargePoint deps.createTransport (#575)", () => {
  it("is called once with the charge point and its transport context", () => {
    const { cp, calls } = build("OCPP-1.6J");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cp).toBe(cp);
    expect(calls[0]!.ctx).toMatchObject({
      wsUrl: "ws://localhost:9/ocpp",
      transportUrl: "ws://localhost:9/ocpp",
      basicAuth: { username: "u", password: "p" },
      extraWsHeaders: { "X-Extra": "1" },
      extraWsSubprotocols: ["ocpp1.6"],
      ocppVersion: "OCPP-1.6J",
    });
    expect(calls[0]!.ctx.logger).toBe(cp.logger);
  });

  it("wires the reconnect policy, WS options and observers on the returned socket", () => {
    const spies: Record<string, ReturnType<typeof vi.fn>> = {};
    const { cp, transport } = build("OCPP-1.6J", (t) => {
      const socket = t.socket!;
      spies.policy = vi.spyOn(socket, "setReconnectPolicy") as never;
      spies.options = vi.spyOn(socket, "setWsClientOptions") as never;
      return t;
    });
    expect(spies.policy).toHaveBeenCalledWith(
      cp.reconnectPolicy,
      expect.any(Function),
    );
    expect(spies.options).toHaveBeenCalledTimes(1);
    const reconnecting = vi.fn();
    const gaveUp = vi.fn();
    cp.events.on("reconnecting", reconnecting);
    cp.events.on("gaveUp", gaveUp);
    transport().socket!.observers.emit("reconnectScheduled", {
      attempt: 2,
      delayMs: 100,
    });
    transport().socket!.observers.emit("reconnectGaveUp", { attempts: 3 });
    expect(reconnecting).toHaveBeenCalledWith({ attempt: 2, delayMs: 100 });
    expect(gaveUp).toHaveBeenCalledWith({ target: "reconnect", attempts: 3 });
    expect(cp.wsUrl).toBe(transport().socket!.url);
    cp.disconnect();
  });

  it("sends raw frames through the transport's raw-frame sink", async () => {
    const outcome = { replies: [] } as never;
    const send = vi.fn().mockResolvedValue(outcome);
    const { cp } = build("OCPP-1.6J", (t) => ({
      ...t,
      rawFrames: { send },
    }));
    await expect(cp.sendRawFrame({ frame: "[2]" } as never)).resolves.toBe(
      outcome,
    );
    expect(send).toHaveBeenCalledWith({ frame: "[2]" });
    cp.disconnect();
  });

  it("checks expert calls against the transport's call catalog", async () => {
    const { cp } = build("OCPP-1.6J", (t) => ({
      ...t,
      callCatalog: { actions: ["OnlyThis"], isSupported: () => false },
    }));
    await expect(
      cp.sendOcppCall({ action: "Heartbeat", payload: {} } as never),
    ).rejects.toThrow(/expected one of OnlyThis/);
    cp.disconnect();
  });

  it("asks a SOAP transport whether it receives a CSMS call", () => {
    const receivesCsmsCall = vi.fn((action: string) => action === "Custom");
    const { cp } = build("OCPP-1.5", (t) => ({ ...t, receivesCsmsCall }), {
      centralSystemUrl: "http://localhost:9/cs",
      soapCallbackUrl: "http://localhost:9/cp",
    });
    expect(cp.canReceiveCsmsCall("Custom")).toBe(true);
    expect(cp.canReceiveCsmsCall("Reset")).toBe(false);
    expect(receivesCsmsCall).toHaveBeenCalledWith("Custom");
  });

  it("keeps the SOAP signal: no socket and no raw-frame sink", () => {
    const { cp, transport } = build("OCPP-1.5", undefined, {
      centralSystemUrl: "http://localhost:9/cs",
    });
    expect(transport().socket).toBeNull();
    expect(transport().rawFrames).toBeNull();
    expect(transport().callCatalog).toBeNull();
    expect(cp.isSoapChargePoint()).toBe(true);
    expect(cp.wsUrl).toBe("http://localhost:9/cs");
  });
});

describe("ChargePoint deps.logSink and deps.fileUploader (#575)", () => {
  function sink() {
    return {
      append: vi.fn<LogSink["append"]>(),
      flush: vi.fn<LogSink["flush"]>(),
      close: vi.fn<LogSink["close"]>(),
    };
  }

  it("appends every log entry to the log sink under the charge point id", () => {
    const logSink = sink();
    const { cp } = build("OCPP-1.6J", undefined, {}, { logSink });
    logSink.append.mockClear();
    cp.logger.info("hello sink");
    expect(logSink.append).toHaveBeenCalledWith(
      "cp-deps",
      expect.objectContaining({ message: "hello sink" }),
    );
    cp.disconnect();
  });

  it("flushes the log sink on flushLogs and closes it on dispose", () => {
    const logSink = sink();
    const { cp } = build("OCPP-1.6J", undefined, {}, { logSink });
    cp.flushLogs();
    expect(logSink.flush).toHaveBeenCalledTimes(1);
    expect(logSink.close).not.toHaveBeenCalled();
    cp.dispose();
    expect(logSink.close).toHaveBeenCalledTimes(1);
  });

  it("exposes the file uploader it was given", () => {
    const fileUploader = vi.fn();
    const { cp } = build("OCPP-1.6J", undefined, {}, { fileUploader });
    expect(cp.fileUploader).toBe(fileUploader);
    cp.disconnect();
  });
});
