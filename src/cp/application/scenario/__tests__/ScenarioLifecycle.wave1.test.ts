import { describe, expect, it, vi } from "vitest";
import { ScenarioExecutor } from "../ScenarioExecutor";
import { createScenarioExecutorCallbacks } from "../ScenarioRuntime";
import {
  ScenarioDefinition,
  ScenarioExecutorCallbacks,
  ScenarioNodeType,
} from "../ScenarioTypes";
import { EventEmitter } from "../../../shared/EventEmitter";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { Connector } from "../../../domain/connector/Connector";
import type { Transaction } from "../../../domain/connector/Transaction";
import {
  DefaultBootNotification,
  OCPPStatus,
} from "../../../domain/types/OcppTypes";

function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function waitUntil(predicate: () => boolean, ms = 250): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) {
      throw new Error("Timed out waiting for predicate");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function scenarioWithNodes(
  id: string,
  nodes: ScenarioDefinition["nodes"],
  edges: ScenarioDefinition["edges"],
): ScenarioDefinition {
  return {
    id,
    name: id,
    targetType: "connector",
    targetId: 1,
    nodes,
    edges,
    createdAt: "2026-06-28T00:00:00.000Z",
    updatedAt: "2026-06-28T00:00:00.000Z",
    defaultExecutionMode: "oneshot",
    enabled: true,
    trigger: { type: "manual" },
  };
}

function autoMeterMaxValueScenario(): ScenarioDefinition {
  return scenarioWithNodes(
    "w1-a-auto-meter-external-stop",
    [
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
        data: {
          label: "Auto Meter",
          value: 0,
          sendMessage: false,
          autoIncrement: true,
          incrementInterval: 1,
          incrementAmount: 10,
          maxValue: 10_000,
        },
      },
      {
        id: "end",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 200 },
        data: { label: "End" },
      },
    ],
    [
      { id: "e-start-meter", source: "start", target: "meter" },
      { id: "e-meter-end", source: "meter", target: "end" },
    ],
  );
}

function remoteTriggerScenario(
  id: string,
  triggerType:
    | ScenarioNodeType.REMOTE_START_TRIGGER
    | ScenarioNodeType.REMOTE_STOP_TRIGGER,
): ScenarioDefinition {
  return scenarioWithNodes(
    id,
    [
      {
        id: "start",
        type: ScenarioNodeType.START,
        position: { x: 0, y: 0 },
        data: { label: "Start" },
      },
      {
        id: "remote-trigger",
        type: triggerType,
        position: { x: 0, y: 100 },
        data: { label: "Remote Trigger", timeout: 0 },
      },
      {
        id: "end",
        type: ScenarioNodeType.END,
        position: { x: 0, y: 200 },
        data: { label: "End" },
      },
    ],
    [
      { id: "e-start-trigger", source: "start", target: "remote-trigger" },
      { id: "e-trigger-end", source: "remote-trigger", target: "end" },
    ],
  );
}

function activeTransaction(tagId = "TAG-1"): Transaction {
  return {
    id: 101,
    connectorId: 1,
    tagId,
    meterStart: 0,
    meterStop: null,
    startTime: new Date("2026-06-28T00:00:00.000Z"),
    stopTime: null,
    meterSent: false,
  };
}

function runtimeCallbacksWithActiveTransaction(): {
  callbacks: ScenarioExecutorCallbacks;
  connectorEvents: EventEmitter<Record<string, unknown>>;
  connectorShape: {
    transaction: Transaction | null;
    startManualMeterStrategy: ReturnType<typeof vi.fn>;
    stopAutoMeterValue: ReturnType<typeof vi.fn>;
  };
} {
  const connectorEvents = new EventEmitter<Record<string, unknown>>();
  const chargePointEvents = new EventEmitter<Record<string, unknown>>();
  const connectorShape = {
    id: 1,
    status: OCPPStatus.Charging,
    meterValue: 0,
    transaction: activeTransaction(),
    unlockResponse: "UnlockFailed" as const,
    evSettings: {
      batteryCapacityKwh: 40,
      initialSoc: 20,
      targetSoc: 80,
      stopAtTargetSoc: true,
    },
    events: connectorEvents,
    startManualMeterStrategy: vi.fn(),
    stopAutoMeterValue: vi.fn(),
  };

  const chargePointShape = {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    events: chargePointEvents,
    updateConnectorStatus: vi.fn((_connectorId: number, status: OCPPStatus) => {
      connectorShape.status = status;
    }),
    startTransaction: vi.fn(),
    stopTransaction: vi.fn(),
    setMeterValue: vi.fn((_connectorId: number, value: number) => {
      connectorShape.meterValue = value;
      connectorEvents.emit("meterValueChange", { meterValue: value });
    }),
    sendMeterValue: vi.fn(),
    sendHeartbeat: vi.fn(),
    sendStatusNotificationRaw: vi.fn(),
    sendDataTransfer: vi.fn(),
    getConnector: vi.fn(() => connectorShape),
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
  };

  return {
    callbacks: createScenarioExecutorCallbacks({
      chargePoint: chargePointShape as unknown as ChargePoint,
      connector: connectorShape as unknown as Connector,
    }),
    connectorEvents,
    connectorShape,
  };
}

function newChargePoint(id: string): ChargePoint {
  const cp = new ChargePoint(
    id,
    DefaultBootNotification,
    1,
    "ws://127.0.0.1:9/",
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    {},
  );
  cp.events.on("error", () => undefined);
  return cp;
}

describe("WAVE 1 scenario and transaction lifecycle regressions", () => {
  it("W1-a resolves an auto-meter maxValue wait when the connector transaction ends externally", async () => {
    const { callbacks, connectorEvents, connectorShape } =
      runtimeCallbacksWithActiveTransaction();
    const executor = new ScenarioExecutor(
      autoMeterMaxValueScenario(),
      callbacks,
    );
    const execution = executor.start();

    try {
      await waitUntil(
        () => connectorShape.startManualMeterStrategy.mock.calls.length === 1,
      );

      connectorShape.transaction = null;
      connectorEvents.emit("transactionChange", { transaction: null });

      await expect(timeout(execution, 100)).resolves.toBeUndefined();
      expect(connectorShape.stopAutoMeterValue).toHaveBeenCalledTimes(1);
      expect(executor.getContext().state).toBe("completed");
    } finally {
      if (executor.getContext().state !== "completed") {
        executor.stop();
        await timeout(
          execution.catch(() => undefined),
          100,
        ).catch(() => undefined);
      }
    }
  });

  it("W1-b unregisters remote-start scenario handling when stopped while parked", async () => {
    const cp = newChargePoint("CP-W1-B-REMOTE-START");
    const connector = cp.getConnector(1);
    expect(connector).toBeDefined();

    const executor = new ScenarioExecutor(
      remoteTriggerScenario(
        "w1-b-remote-start-stop",
        ScenarioNodeType.REMOTE_START_TRIGGER,
      ),
      createScenarioExecutorCallbacks({
        chargePoint: cp,
        connector: connector!,
      }),
    );
    const execution = executor.start();

    await waitUntil(() => cp.isScenarioHandled(1));
    executor.stop();
    await timeout(execution, 100);

    expect(cp.isScenarioHandled(1)).toBe(false);
  });

  it("W1-b unregisters remote-stop scenario handling when stopped while parked", async () => {
    const cp = newChargePoint("CP-W1-B-REMOTE-STOP");
    const connector = cp.getConnector(1);
    expect(connector).toBeDefined();

    const executor = new ScenarioExecutor(
      remoteTriggerScenario(
        "w1-b-remote-stop-stop",
        ScenarioNodeType.REMOTE_STOP_TRIGGER,
      ),
      createScenarioExecutorCallbacks({
        chargePoint: cp,
        connector: connector!,
      }),
    );
    const execution = executor.start();

    await waitUntil(() => cp.isScenarioStopHandled(1));
    executor.stop();
    await timeout(execution, 100);

    expect(cp.isScenarioStopHandled(1)).toBe(false);
  });

  it("W1-c leaves the active transaction intact on a duplicate start", () => {
    const cp = newChargePoint("CP-W1-C-DOUBLE-START");
    const connector = cp.getConnector(1);
    expect(connector).toBeDefined();

    cp.startTransaction("TAG-FIRST", 1, 50, 25);
    const firstTransaction = connector!.transaction;
    expect(firstTransaction?.tagId).toBe("TAG-FIRST");

    cp.startTransaction("TAG-SECOND", 1, 80, 90);

    expect(connector!.transaction).toBe(firstTransaction);
    expect(connector!.transaction?.tagId).toBe("TAG-FIRST");
    expect(connector!.transaction?.batteryCapacityKwh).toBe(50);
    expect(connector!.soc).toBe(25);
  });

  it("W1-c allows a retry after rejected start cleanup leaves the transaction object", () => {
    const cp = newChargePoint("CP-W1-C-CLEANED-RETRY");
    const connector = cp.getConnector(1);
    expect(connector).toBeDefined();

    cp.startTransaction("TAG-REJECTED", 1, 50, 25);
    const rejectedTransaction = connector!.transaction;
    expect(rejectedTransaction?.stopTime).toBeNull();

    cp.cleanTransaction(connector!);
    expect(connector!.transaction).toBe(rejectedTransaction);
    expect(rejectedTransaction?.stopTime).toBeInstanceOf(Date);

    cp.startTransaction("TAG-RETRY", 1, 80, 90);

    expect(connector!.transaction).not.toBe(rejectedTransaction);
    expect(connector!.transaction?.tagId).toBe("TAG-RETRY");
    expect(connector!.transaction?.stopTime).toBeNull();
    expect(connector!.transaction?.batteryCapacityKwh).toBe(80);
    expect(connector!.soc).toBe(90);
  });

  it("W1-d rejects transaction starts while the connector is Inoperative", () => {
    const cp = newChargePoint("CP-W1-D-INOPERATIVE");
    const connector = cp.getConnector(1);
    expect(connector).toBeDefined();

    connector!.availability = "Inoperative";
    cp.startTransaction("TAG-BLOCKED", 1);
    expect(connector!.transaction).toBeNull();

    connector!.availability = "Operative";
    cp.startTransaction("TAG-ALLOWED", 1);
    expect(connector!.transaction?.tagId).toBe("TAG-ALLOWED");
  });
});
