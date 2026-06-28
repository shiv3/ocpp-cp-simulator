import { describe, expect, it, vi } from "vitest";
import { ScenarioExecutor } from "../ScenarioExecutor";
import { createScenarioExecutorCallbacks } from "../ScenarioRuntime";
import {
  ScenarioDefinition,
  ScenarioExecutorCallbacks,
  ScenarioNode,
  ScenarioNodeData,
  ScenarioNodeType,
} from "../ScenarioTypes";
import { OCPPStatus } from "../../../domain/types/OcppTypes";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { Connector } from "../../../domain/connector/Connector";

function node(
  id: string,
  type: ScenarioNodeType,
  data: ScenarioNodeData,
): ScenarioNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data,
  };
}

function scenarioWithMiddleNodes(
  id: string,
  middleNodes: ScenarioNode[],
): ScenarioDefinition {
  const nodes = [
    node("start", ScenarioNodeType.START, { label: "Start" }),
    ...middleNodes,
    node("end", ScenarioNodeType.END, { label: "End" }),
  ];

  return {
    id,
    name: id,
    targetType: "connector",
    targetId: 1,
    nodes,
    edges: nodes.slice(0, -1).map((source, index) => ({
      id: `e-${source.id}`,
      source: source.id,
      target: nodes[index + 1]!.id,
    })),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    defaultExecutionMode: "oneshot",
    enabled: true,
    trigger: { type: "manual" },
  };
}

async function runSingleNode(
  type: ScenarioNodeType,
  data: ScenarioNodeData,
  callbacks: ScenarioExecutorCallbacks,
): Promise<void> {
  const executor = new ScenarioExecutor(
    scenarioWithMiddleNodes(`node-${type}`, [node("under-test", type, data)]),
    callbacks,
  );
  await executor.start();
}

function createRuntimeMocks() {
  const connectorShape = {
    id: 1,
    status: OCPPStatus.Available,
    meterValue: 0,
    unlockResponse: "UnlockFailed" as
      | "Unlocked"
      | "UnlockFailed"
      | "NotSupported",
    evSettings: {
      batteryCapacityKwh: 40,
      initialSoc: 20,
      targetSoc: 80,
      stopAtTargetSoc: true,
    },
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
    updateConnectorStatus: vi.fn((connectorId: number, status: OCPPStatus) => {
      if (connectorId === connectorShape.id) {
        connectorShape.status = status;
      }
    }),
    startTransaction: vi.fn(),
    stopTransaction: vi.fn(),
    setMeterValue: vi.fn((connectorId: number, value: number) => {
      if (connectorId === connectorShape.id) {
        connectorShape.meterValue = value;
      }
    }),
    sendMeterValue: vi.fn(),
    sendHeartbeat: vi.fn(),
    sendStatusNotificationRaw: vi.fn(),
    sendDataTransfer: vi.fn(),
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

  return {
    chargePointShape,
    connectorShape,
    chargePoint: chargePointShape as unknown as ChargePoint,
    connector: connectorShape as unknown as Connector,
  };
}

describe("ScenarioExecutor node dispatch", () => {
  it("dispatches statusChange nodes to onStatusChange", async () => {
    const onStatusChange = vi.fn(async () => {});

    await runSingleNode(
      ScenarioNodeType.STATUS_CHANGE,
      { label: "Status", status: OCPPStatus.Charging },
      { onStatusChange },
    );

    expect(onStatusChange).toHaveBeenCalledWith(OCPPStatus.Charging);
  });

  it("dispatches transaction start nodes to onStartTransaction", async () => {
    const onStartTransaction = vi.fn(async () => {});

    await runSingleNode(
      ScenarioNodeType.TRANSACTION,
      {
        label: "Start Transaction",
        action: "start",
        tagId: "TAG-1",
        batteryCapacityKwh: 77,
        initialSoc: 12,
      },
      { onStartTransaction },
    );

    expect(onStartTransaction).toHaveBeenCalledWith("TAG-1", 77, 12);
  });

  it("dispatches transaction stop nodes to onStopTransaction", async () => {
    const onStopTransaction = vi.fn(async () => {});

    await runSingleNode(
      ScenarioNodeType.TRANSACTION,
      { label: "Stop Transaction", action: "stop" },
      { onStopTransaction },
    );

    expect(onStopTransaction).toHaveBeenCalledWith(undefined);
  });

  it("dispatches meterValue nodes to onSetMeterValue and onSendMeterValue", async () => {
    const onSetMeterValue = vi.fn();
    const onSendMeterValue = vi.fn(async () => {});

    await runSingleNode(
      ScenarioNodeType.METER_VALUE,
      { label: "Meter", value: 321, sendMessage: true },
      { onSetMeterValue, onSendMeterValue },
    );

    expect(onSetMeterValue).toHaveBeenCalledWith(321);
    expect(onSendMeterValue).toHaveBeenCalledTimes(1);
  });

  it("dispatches delay nodes to onDelay", async () => {
    const onDelay = vi.fn(async () => {});

    await runSingleNode(
      ScenarioNodeType.DELAY,
      { label: "Delay", delaySeconds: 0 },
      { onDelay },
    );

    expect(onDelay).toHaveBeenCalledWith(0);
  });

  it("dispatches notification nodes to onSendNotification", async () => {
    const onSendNotification = vi.fn(async () => {});
    const payload = { connectorId: 1, status: OCPPStatus.Available };

    await runSingleNode(
      ScenarioNodeType.NOTIFICATION,
      { label: "Notify", messageType: "StatusNotification", payload },
      { onSendNotification },
    );

    expect(onSendNotification).toHaveBeenCalledWith(
      "StatusNotification",
      payload,
    );
  });

  it("dispatches connectorPlug nodes to onConnectorPlug", async () => {
    const onConnectorPlug = vi.fn(async () => {});

    await runSingleNode(
      ScenarioNodeType.CONNECTOR_PLUG,
      { label: "Plug In", action: "plugin" },
      { onConnectorPlug },
    );

    expect(onConnectorPlug).toHaveBeenCalledWith("plugin");
  });

  it("dispatches remoteStartTrigger nodes to onWaitForRemoteStart", async () => {
    const onWaitForRemoteStart = vi.fn(async () => "REMOTE-TAG");

    await runSingleNode(
      ScenarioNodeType.REMOTE_START_TRIGGER,
      { label: "Remote Start", timeout: 5 },
      { onWaitForRemoteStart },
    );

    expect(onWaitForRemoteStart).toHaveBeenCalledWith(5);
  });

  it("dispatches remoteStopTrigger nodes to onWaitForRemoteStop", async () => {
    const onWaitForRemoteStop = vi.fn(async () => ({
      transactionId: 9,
      reason: "Remote",
    }));

    await runSingleNode(
      ScenarioNodeType.REMOTE_STOP_TRIGGER,
      { label: "Remote Stop", timeout: 6 },
      { onWaitForRemoteStop },
    );

    expect(onWaitForRemoteStop).toHaveBeenCalledWith(6);
  });

  it("dispatches statusTrigger nodes to onWaitForStatus", async () => {
    const onWaitForStatus = vi.fn(async () => {});

    await runSingleNode(
      ScenarioNodeType.STATUS_TRIGGER,
      {
        label: "Wait Status",
        targetStatus: OCPPStatus.Preparing,
        timeout: 7,
      },
      { onWaitForStatus },
    );

    expect(onWaitForStatus).toHaveBeenCalledWith(OCPPStatus.Preparing, 7);
  });

  it("dispatches reserveNow nodes to onReserveNow", async () => {
    const onReserveNow = vi.fn(async () => 42);

    await runSingleNode(
      ScenarioNodeType.RESERVE_NOW,
      {
        label: "Reserve",
        expiryMinutes: 15,
        idTag: "ID-1",
        parentIdTag: "PARENT",
        reservationId: 42,
      },
      { onReserveNow },
    );

    expect(onReserveNow).toHaveBeenCalledWith(15, "ID-1", "PARENT", 42);
  });

  it("dispatches cancelReservation nodes to onCancelReservation", async () => {
    const onCancelReservation = vi.fn(async () => {});

    await runSingleNode(
      ScenarioNodeType.CANCEL_RESERVATION,
      { label: "Cancel", reservationId: 42 },
      { onCancelReservation },
    );

    expect(onCancelReservation).toHaveBeenCalledWith(42);
  });

  it("dispatches reservationTrigger nodes to onWaitForReservation", async () => {
    const onWaitForReservation = vi.fn(async () => 42);

    await runSingleNode(
      ScenarioNodeType.RESERVATION_TRIGGER,
      { label: "Wait Reservation", timeout: 8 },
      { onWaitForReservation },
    );

    expect(onWaitForReservation).toHaveBeenCalledWith(8);
  });

  it("dispatches statusNotification nodes to onSendStatusNotification", async () => {
    const onSendStatusNotification = vi.fn();

    await runSingleNode(
      ScenarioNodeType.STATUS_NOTIFICATION,
      {
        label: "Raw Status",
        connectorId: 0,
        status: OCPPStatus.Faulted,
        errorCode: "GroundFailure",
        info: "fault details",
        vendorErrorCode: "E-1",
        vendorId: "ACME",
      },
      { onSendStatusNotification },
    );

    expect(onSendStatusNotification).toHaveBeenCalledWith(
      0,
      OCPPStatus.Faulted,
      {
        errorCode: "GroundFailure",
        info: "fault details",
        vendorErrorCode: "E-1",
        vendorId: "ACME",
      },
    );
  });

  it("dispatches unlockOutcome nodes to onSetUnlockOutcome", async () => {
    const onSetUnlockOutcome = vi.fn();

    await runSingleNode(
      ScenarioNodeType.UNLOCK_OUTCOME,
      { label: "Unlock", outcome: "Unlocked" },
      { onSetUnlockOutcome },
    );

    expect(onSetUnlockOutcome).toHaveBeenCalledWith("Unlocked");
  });

  it("dispatches configSet nodes to onConfigSet", async () => {
    const onConfigSet = vi.fn();

    await runSingleNode(
      ScenarioNodeType.CONFIG_SET,
      { label: "Config", key: "MeterValueSampleInterval", value: "5" },
      { onConfigSet },
    );

    expect(onConfigSet).toHaveBeenCalledWith("MeterValueSampleInterval", "5");
  });

  it("dispatches dataTransfer nodes to onSendDataTransfer", async () => {
    const onSendDataTransfer = vi.fn();

    await runSingleNode(
      ScenarioNodeType.DATA_TRANSFER,
      {
        label: "DataTransfer",
        vendorId: "vendor",
        messageId: "message",
        data: '{"ok":true}',
      },
      { onSendDataTransfer },
    );

    expect(onSendDataTransfer).toHaveBeenCalledWith(
      "vendor",
      "message",
      '{"ok":true}',
    );
  });
});

describe("createScenarioExecutorCallbacks runtime effects", () => {
  it("wires runtime callbacks to the charge point and connector", async () => {
    const { chargePoint, chargePointShape, connector, connectorShape } =
      createRuntimeMocks();
    const callbacks = createScenarioExecutorCallbacks({
      chargePoint,
      connector,
    });

    await callbacks.onStatusChange?.(OCPPStatus.Charging);
    callbacks.onSetMeterValue?.(456);
    await callbacks.onSendMeterValue?.();
    callbacks.onSetUnlockOutcome?.("Unlocked");
    callbacks.onConfigSet?.("MeterValueSampleInterval", "5");
    callbacks.onSendStatusNotification?.(0, OCPPStatus.Faulted, {
      errorCode: "GroundFailure",
      info: "fault",
      vendorErrorCode: "E-1",
      vendorId: "ACME",
    });
    callbacks.onSendDataTransfer?.("vendor", "message", '{"ok":true}');

    expect(chargePointShape.updateConnectorStatus).toHaveBeenCalledWith(
      1,
      OCPPStatus.Charging,
    );
    expect(connectorShape.status).toBe(OCPPStatus.Charging);
    expect(chargePointShape.setMeterValue).toHaveBeenCalledWith(1, 456);
    expect(connectorShape.meterValue).toBe(456);
    expect(chargePointShape.sendMeterValue).toHaveBeenCalledWith(1);
    expect(connectorShape.unlockResponse).toBe("Unlocked");
    expect(chargePointShape.configuration.applyChange).toHaveBeenCalledWith(
      "MeterValueSampleInterval",
      "5",
    );
    expect(chargePointShape.sendStatusNotificationRaw).toHaveBeenCalledWith(
      0,
      OCPPStatus.Faulted,
      {
        errorCode: "GroundFailure",
        info: "fault",
        vendorErrorCode: "E-1",
        vendorId: "ACME",
      },
    );
    expect(chargePointShape.sendDataTransfer).toHaveBeenCalledWith(
      "vendor",
      "message",
      '{"ok":true}',
    );
  });

  it("documents the runtime connectorPlug callback as a no-op that still advances the flow", async () => {
    const { chargePoint, chargePointShape, connector } = createRuntimeMocks();
    const callbacks = createScenarioExecutorCallbacks({
      chargePoint,
      connector,
    });
    const executor = new ScenarioExecutor(
      scenarioWithMiddleNodes("runtime-connector-plug-noop", [
        node("plug", ScenarioNodeType.CONNECTOR_PLUG, {
          label: "Plug In",
          action: "plugin",
        }),
        node("meter", ScenarioNodeType.METER_VALUE, {
          label: "Meter",
          value: 42,
          sendMessage: false,
        }),
      ]),
      callbacks,
    );

    // Runtime onConnectorPlug is intentionally a no-op today: connector plug
    // state is not represented in the domain model, but the scenario flow must
    // keep advancing so authored plug nodes do not stall production scenarios.
    await expect(executor.start()).resolves.toBeUndefined();

    expect(executor.getContext().state).toBe("completed");
    expect(chargePointShape.setMeterValue).toHaveBeenCalledWith(1, 42);
  });
});
