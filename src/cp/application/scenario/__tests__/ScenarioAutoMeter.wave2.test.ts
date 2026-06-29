import { afterEach, describe, expect, it, vi } from "vitest";
import { ScenarioExecutor } from "../ScenarioExecutor";
import { createScenarioExecutorCallbacks } from "../ScenarioRuntime";
import {
  ScenarioDefinition,
  type ScenarioExecutorCallbacks,
  ScenarioNodeType,
  type MeterValueNodeData,
} from "../ScenarioTypes";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { Connector } from "../../../domain/connector/Connector";
import type { Transaction } from "../../../domain/connector/Transaction";
import { OCPPStatus } from "../../../domain/types/OcppTypes";
import { Logger, LogLevel } from "../../../shared/Logger";

const STAMP = "2026-06-28T00:00:00.000Z";

function transaction(meterStart: number): Transaction {
  return {
    id: 101,
    connectorId: 1,
    tagId: "TAG-W2",
    meterStart,
    meterStop: null,
    startTime: new Date(STAMP),
    stopTime: null,
    meterSent: false,
  };
}

function makeConnector(meterStart = 0): Connector {
  const connector = new Connector(1, new Logger(LogLevel.ERROR));
  connector.status = OCPPStatus.Charging;
  connector.meterValue = meterStart;
  connector.beginTransaction(transaction(meterStart));
  return connector;
}

function autoMeterScenario(
  id: string,
  data: Omit<MeterValueNodeData, "label">,
): ScenarioDefinition {
  return {
    id,
    name: id,
    targetType: "connector",
    targetId: 1,
    trigger: { type: "manual" },
    defaultExecutionMode: "oneshot",
    enabled: true,
    createdAt: STAMP,
    updatedAt: STAMP,
    nodes: [
      {
        id: "start",
        type: ScenarioNodeType.START,
        position: { x: 0, y: 0 },
        data: { label: "Start" },
      },
      {
        id: "meter",
        type: ScenarioNodeType.METER_VALUE,
        position: { x: 0, y: 100 },
        data: { label: "Auto Meter", ...data },
      },
      {
        id: "end",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 200 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "e-start-meter", source: "start", target: "meter" },
      { id: "e-meter-end", source: "meter", target: "end" },
    ],
  };
}

function runtimeFor(connector: Connector): {
  callbacks: ReturnType<typeof createScenarioExecutorCallbacks>;
  sentMeterValues: number[];
} {
  const sentMeterValues: number[] = [];
  const chargePointShape = {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    updateConnectorStatus: vi.fn((_connectorId: number, status: OCPPStatus) => {
      connector.status = status;
    }),
    startTransaction: vi.fn(),
    stopTransaction: vi.fn(),
    setMeterValue: vi.fn((_connectorId: number, value: number) => {
      connector.meterValue = value;
    }),
    sendMeterValue: vi.fn(() => {
      sentMeterValues.push(connector.meterValue);
    }),
    sendHeartbeat: vi.fn(),
    sendStatusNotificationRaw: vi.fn(),
    sendDataTransfer: vi.fn(),
    getConnector: vi.fn(() => connector),
    configuration: {
      applyChange: vi.fn(),
    },
    reservationManager: {
      createReservation: vi.fn(),
      getReservation: vi.fn(),
      getReservationForConnector: vi.fn(),
      cancelReservation: vi.fn(),
    },
    registerScenarioHandler: vi.fn(),
    unregisterScenarioHandler: vi.fn(),
    registerScenarioStopHandler: vi.fn(),
    unregisterScenarioStopHandler: vi.fn(),
    events: {
      on: vi.fn(),
      off: vi.fn(),
    },
  };

  connector.setOnMeterValueSend(() => {
    sentMeterValues.push(connector.meterValue);
  });

  return {
    callbacks: createScenarioExecutorCallbacks({
      chargePoint: chargePointShape as unknown as ChargePoint,
      connector,
    }),
    sentMeterValues,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function advanceTimersByTime(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await settle();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("WAVE 2 auto-meter regressions", () => {
  it("W2-a completes at maxValue even when maxTime is larger", async () => {
    vi.useFakeTimers();
    const connector = makeConnector();
    const { callbacks } = runtimeFor(connector);
    const executor = new ScenarioExecutor(
      autoMeterScenario("w2-a-max-value-before-max-time", {
        value: 0,
        sendMessage: false,
        autoIncrement: true,
        incrementInterval: 1,
        incrementAmount: 100,
        maxValue: 200,
        maxTime: 60,
      }),
      callbacks,
    );

    const execution = executor.start();
    await settle();
    const startedAt = Date.now();
    let completed = false;
    execution.then(() => {
      completed = true;
    });

    try {
      await advanceTimersByTime(2_000);
      await execution;

      expect(connector.meterValue).toBe(200);
      expect(completed).toBe(true);
      expect(executor.getContext().state).toBe("completed");
      expect(Date.now() - startedAt).toBeLessThan(60_000);
    } finally {
      if (executor.getContext().state !== "completed") {
        executor.stop();
        await execution.catch(() => undefined);
      }
    }
  });

  it("W2-b increments locally without MeterValues when sendMessage is false", async () => {
    vi.useFakeTimers();
    const connector = makeConnector();
    const { callbacks, sentMeterValues } = runtimeFor(connector);
    const executor = new ScenarioExecutor(
      autoMeterScenario("w2-b-no-auto-send", {
        value: 0,
        sendMessage: false,
        autoIncrement: true,
        incrementInterval: 1,
        incrementAmount: 100,
        maxValue: 200,
      }),
      callbacks,
    );

    const execution = executor.start();
    await settle();

    try {
      await advanceTimersByTime(2_000);
      await execution;

      expect(connector.meterValue).toBe(200);
      expect(sentMeterValues).toEqual([]);
    } finally {
      if (executor.getContext().state !== "completed") {
        executor.stop();
        await execution.catch(() => undefined);
      }
    }
  });

  it("W2-c sends the capped final auto-meter sample once", async () => {
    vi.useFakeTimers();
    const connector = makeConnector();
    const { callbacks, sentMeterValues } = runtimeFor(connector);
    const executor = new ScenarioExecutor(
      autoMeterScenario("w2-c-no-duplicate-final-sample", {
        value: 0,
        sendMessage: true,
        autoIncrement: true,
        incrementInterval: 1,
        incrementAmount: 100,
        maxValue: 200,
      }),
      callbacks,
    );

    const execution = executor.start();
    await settle();

    try {
      await advanceTimersByTime(2_000);
      await execution;

      expect(sentMeterValues).toEqual([100, 200]);
    } finally {
      if (executor.getContext().state !== "completed") {
        executor.stop();
        await execution.catch(() => undefined);
      }
    }
  });

  it("W2-d treats maxValue as energy added since transaction start", async () => {
    vi.useFakeTimers();
    const connector = makeConnector(10_000);
    const { callbacks } = runtimeFor(connector);
    const executor = new ScenarioExecutor(
      autoMeterScenario("w2-d-relative-energy-cap", {
        value: 0,
        sendMessage: false,
        autoIncrement: true,
        incrementInterval: 1,
        incrementAmount: 2_500,
        maxValue: 5_000,
      }),
      callbacks,
    );

    const execution = executor.start();
    await settle();

    try {
      await advanceTimersByTime(1_000);
      expect(connector.meterValue).toBe(12_500);

      await advanceTimersByTime(1_000);
      await execution;

      expect(connector.meterValue).toBe(15_000);
    } finally {
      if (executor.getContext().state !== "completed") {
        executor.stop();
        await execution.catch(() => undefined);
      }
    }
  });

  it("W2-d bases no-transaction maxValue on the seeded meter value", async () => {
    vi.useFakeTimers();
    let meterValue = 0;
    let getMeterReads = 0;
    let interval: ReturnType<typeof setInterval> | null = null;
    let waitTarget: number | null = null;
    let waitResolve: (() => void) | null = null;
    let startedMaxValue: number | undefined;

    const resolveIfTargetReached = () => {
      if (waitTarget === null || meterValue < waitTarget) return;
      const resolve = waitResolve;
      waitTarget = null;
      waitResolve = null;
      resolve?.();
    };

    const callbacks = {
      onSetMeterValue: (value: number) => {
        meterValue = value;
      },
      onGetMeterValue: () => {
        getMeterReads += 1;
        return getMeterReads <= 2 ? 0 : meterValue;
      },
      onGetTransactionMeterStart: () => null,
      onStartAutoMeterValue: (config) => {
        startedMaxValue = config.maxValue;
        interval = setInterval(() => {
          const maxValue = config.maxValue ?? Number.POSITIVE_INFINITY;
          meterValue = Math.min(meterValue + config.incrementValue, maxValue);
          resolveIfTargetReached();
          if (meterValue >= maxValue && interval) {
            clearInterval(interval);
            interval = null;
          }
        }, config.intervalSeconds * 1000);
      },
      onWaitForMeterValue: (targetValue) =>
        new Promise<void>((resolve) => {
          waitTarget = targetValue;
          waitResolve = resolve;
          resolveIfTargetReached();
        }),
      onStopAutoMeterValue: () => {
        if (interval) {
          clearInterval(interval);
          interval = null;
        }
      },
    } satisfies ScenarioExecutorCallbacks & {
      onGetTransactionMeterStart: () => number | null;
    };

    const executor = new ScenarioExecutor(
      autoMeterScenario("w2-d-no-tx-seeded-cap-base", {
        value: 1_000,
        sendMessage: false,
        autoIncrement: true,
        incrementInterval: 1,
        incrementAmount: 1_000,
        maxValue: 2_000,
      }),
      callbacks,
    );

    const execution = executor.start();
    await settle();

    try {
      await advanceTimersByTime(2_000);
      await execution;

      expect(startedMaxValue).toBe(3_000);
      expect(meterValue).toBe(3_000);
    } finally {
      if (executor.getContext().state !== "completed") {
        executor.stop();
        await execution.catch(() => undefined);
      } else if (interval) {
        clearInterval(interval);
      }
    }
  });

  it("W2-f completes immediately for evSettings stop mode when target is already reached", async () => {
    const onStartAutoMeterValue = vi.fn();
    const onStopAutoMeterValue = vi.fn();
    const executor = new ScenarioExecutor(
      autoMeterScenario("w2-f-ev-settings-already-at-target", {
        value: 0,
        sendMessage: false,
        autoIncrement: true,
        stopMode: "evSettings",
        incrementInterval: 1,
        incrementAmount: 100,
      }),
      {
        onSetMeterValue: vi.fn(),
        onStartAutoMeterValue,
        onStopAutoMeterValue,
        onGetEVSettings: () => ({
          modelName: "W2 EV",
          batteryCapacityKwh: 40,
          maxChargingPowerKw: 50,
          initialSoc: 80,
          targetSoc: 80,
        }),
      },
    );

    await expect(executor.start()).resolves.toBeUndefined();

    expect(executor.getContext().state).toBe("completed");
    expect(onStartAutoMeterValue).not.toHaveBeenCalled();
    expect(onStopAutoMeterValue).not.toHaveBeenCalled();
  });
});
