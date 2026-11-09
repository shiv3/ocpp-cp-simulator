import { describe, expect, it, vi } from "vitest";
import { ChargePoint } from "../ChargePoint";
import type {
  ChargePointDeps,
  ChargePointTransport,
  TransportContext,
} from "../ChargePointDeps";
import { DEFAULT_SERVICES } from "../../../infrastructure/charge-point/createDefaultServices";
import { createDefaultTransport } from "../../../infrastructure/charge-point/createDefaultTransport";
import { LogRepository } from "../../../infrastructure/persistence/LogRepository";
import { UploadFile } from "../../../infrastructure/fileUpload";
import { DefaultBootNotification } from "../../types/OcppTypes";
import type { LogSink } from "../../persistence/LogSink";
import { LogLevel } from "../../../shared/Logger";

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
    ...DEFAULT_SERVICES,
    logSink: new LogRepository(null),
    fileUploader: UploadFile,
    ...overrides,
    createTransport: (cp, ctx) => {
      calls.push({ cp, ctx });
      built = wrap(createDefaultTransport(cp, ctx));
      return built;
    },
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

describe("ChargePoint service factories (#575)", () => {
  type Factories = Omit<
    ChargePointDeps,
    "createTransport" | "logSink" | "fileUploader"
  >;

  /** The default factories wrapped so each call is recorded in `order`. */
  function traced(order: string[]) {
    const spies = {
      createBehaviorRegistry: vi.fn<Factories["createBehaviorRegistry"]>(
        (options) => {
          order.push("registry");
          return DEFAULT_SERVICES.createBehaviorRegistry(options);
        },
      ),
      createEngine: vi.fn<Factories["createEngine"]>((cp) => {
        order.push("engine");
        return DEFAULT_SERVICES.createEngine(cp);
      }),
      createHeartbeat: vi.fn<Factories["createHeartbeat"]>((logger, clock) => {
        order.push("heartbeat");
        const heartbeat = DEFAULT_SERVICES.createHeartbeat(logger, clock);
        vi.spyOn(heartbeat, "setHeartbeatCallback");
        return heartbeat;
      }),
      createStateManager: vi.fn<Factories["createStateManager"]>((ctx) => {
        order.push("stateManager");
        return DEFAULT_SERVICES.createStateManager(ctx);
      }),
      createTimeline: vi.fn<Factories["createTimeline"]>((ctx) => {
        order.push("timeline");
        const built = DEFAULT_SERVICES.createTimeline(ctx);
        vi.spyOn(built.projector, "dispose");
        return built;
      }),
    };
    return spies;
  }

  function buildTraced() {
    const order: string[] = [];
    const spies = traced(order);
    const rng = vi.spyOn(ChargePoint.prototype, "rng");
    const { cp } = build(
      "OCPP-1.6J",
      (t) => {
        order.push("transport");
        return t;
      },
      {},
      spies,
    );
    const rngOf = (name: string) =>
      rng.mock.results[rng.mock.calls.findIndex(([n]) => n === name)]?.value;
    const streams = {
      stateHistory: rngOf("state-history"),
      timeline: rngOf("timeline"),
    };
    rng.mockRestore();
    return { cp, order, spies, streams };
  }

  it("builds the registry, then the engine, before the transport", () => {
    const { cp, order, spies } = buildTraced();
    expect(order.slice(0, 3)).toEqual(["registry", "engine", "transport"]);
    expect(spies.createBehaviorRegistry).toHaveBeenCalledTimes(1);
    expect(spies.createEngine).toHaveBeenCalledTimes(1);
    expect(spies.createEngine).toHaveBeenCalledWith(cp);
    expect(cp.behaviors).toBe(
      spies.createBehaviorRegistry.mock.results[0]!.value,
    );
    expect(cp.engine).toBe(spies.createEngine.mock.results[0]!.value);
    cp.disconnect();
  });

  it("gives the registry the station's OCPP version and logger", () => {
    const { cp, spies } = buildTraced();
    const options = spies.createBehaviorRegistry.mock.calls[0]![0];
    expect(options.ocppVersion?.()).toBe("OCPP-1.6J");
    const logs: { level: LogLevel; message: string }[] = [];
    cp.events.on("log", ({ level, message }) => logs.push({ level, message }));
    options.warn?.("registry says");
    expect(logs).toContainEqual({
      level: LogLevel.WARN,
      message: "registry says",
    });
    cp.disconnect();
  });

  it("builds the heartbeat after the transport and installs its callback", () => {
    const { cp, order, spies } = buildTraced();
    expect(order.indexOf("heartbeat")).toBeGreaterThan(
      order.indexOf("transport"),
    );
    expect(spies.createHeartbeat).toHaveBeenCalledWith(cp.logger, cp.clock);
    const heartbeat = spies.createHeartbeat.mock.results[0]!.value;
    expect(cp.heartbeat).toBe(heartbeat);
    expect(heartbeat.setHeartbeatCallback).toHaveBeenCalledTimes(1);
    expect(heartbeat.setHeartbeatCallback).toHaveBeenCalledWith(
      expect.any(Function),
    );
    cp.disconnect();
  });

  it("builds the state manager over the station's state and stream", () => {
    const { cp, order, spies, streams } = buildTraced();
    expect(order.indexOf("stateManager")).toBeGreaterThan(
      order.indexOf("heartbeat"),
    );
    const ctx = spies.createStateManager.mock.calls[0]![0];
    expect(ctx.logger).toBe(cp.logger);
    expect(ctx.events).toBe(cp.events);
    expect(ctx.clock).toBe(cp.clock);
    expect(ctx.rng).toBe(streams.stateHistory);
    expect(ctx.chargePoint()).toEqual({ status: cp.status, error: cp.error });
    expect(cp.stateManager).toBe(
      spies.createStateManager.mock.results[0]!.value,
    );
    cp.disconnect();
  });

  it("builds the timeline and its projector, and disposes the projector", () => {
    const { cp, order, spies, streams } = buildTraced();
    expect(order.indexOf("timeline")).toBeGreaterThan(
      order.indexOf("stateManager"),
    );
    const ctx = spies.createTimeline.mock.calls[0]![0];
    expect(ctx.cpId).toBe("cp-deps");
    expect(ctx.events).toBe(cp.events);
    expect(ctx.clock).toBe(cp.clock);
    expect(ctx.rng).toBe(streams.timeline);
    expect(ctx.connectors.get(1)).toBe(cp.getConnector(1));
    const built = spies.createTimeline.mock.results[0]!.value;
    expect(cp.timeline).toBe(built.timeline);
    expect(built.projector.dispose).not.toHaveBeenCalled();
    cp.dispose();
    expect(built.projector.dispose).toHaveBeenCalledTimes(1);
  });

  it("runs the transaction methods through deps.transactions", async () => {
    const outcome = { started: false };
    const transactions = {
      start: vi.fn().mockResolvedValue(outcome),
      stop: vi.fn(),
      clean: vi.fn(),
    };
    const { cp } = build("OCPP-1.6J", undefined, {}, { transactions });
    const ports = {
      sendTransactionEvent: expect.any(Function),
      startConnectionTimeout: expect.any(Function),
    };
    await expect(cp.startTransaction("TAG", 1)).resolves.toBe(outcome);
    expect(transactions.start).toHaveBeenCalledWith(
      cp,
      ports,
      "TAG",
      1,
      undefined,
      undefined,
      {},
    );
    cp.stopTransaction(1, "Local");
    expect(transactions.stop).toHaveBeenCalledWith(cp, ports, 1, "Local", {});
    cp.cleanTransaction(1);
    expect(transactions.clean).toHaveBeenCalledWith(cp, 1);
    cp.disconnect();
  });
});
