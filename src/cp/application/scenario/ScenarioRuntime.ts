import { ChargePoint } from "../../domain/charge-point/ChargePoint";
import { Connector } from "../../domain/connector/Connector";
import { OCPPStatus, ReservationStatus } from "../../domain/types/OcppTypes";
import { LogType } from "../../shared/Logger";
import type {
  ScenarioExecutionContext,
  ScenarioExecutorCallbacks,
} from "./ScenarioTypes";

export interface ScenarioRuntimeHooks {
  onStateChange?: (context: ScenarioExecutionContext) => void;
  onNodeExecute?: (nodeId: string) => void;
  onNodeProgress?: (nodeId: string, remaining: number, total: number) => void;
  onError?: (error: Error) => void;
  log?: (message: string, level?: "debug" | "info" | "warn" | "error") => void;
}

interface ScenarioRuntimeParams {
  chargePoint: ChargePoint;
  connector: Connector;
  hooks?: ScenarioRuntimeHooks;
}

const buildLogger = (
  chargePoint: ChargePoint,
  hooks?: ScenarioRuntimeHooks,
): ScenarioExecutorCallbacks["log"] => {
  return (message, level = "info") => {
    switch (level) {
      case "debug":
        chargePoint.logger.debug(message, LogType.SCENARIO);
        break;
      case "info":
        chargePoint.logger.info(message, LogType.SCENARIO);
        break;
      case "warn":
        chargePoint.logger.warn(message, LogType.SCENARIO);
        break;
      case "error":
        chargePoint.logger.error(message, LogType.SCENARIO);
        break;
    }
    hooks?.log?.(message, level);
  };
};

const waitForStatus = (
  connector: Connector,
  targetStatus: OCPPStatus,
  timeout?: number,
): Promise<void> => {
  if (connector.status === targetStatus) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let timeoutId: NodeJS.Timeout | null = null;

    const statusChangeHandler = (data: {
      status: OCPPStatus;
      previousStatus: OCPPStatus;
    }) => {
      if (data.status === targetStatus) {
        if (timeoutId) clearTimeout(timeoutId);
        connector.events.off("statusChange", statusChangeHandler);
        resolve();
      }
    };

    connector.events.on("statusChange", statusChangeHandler);

    if (timeout && timeout > 0) {
      timeoutId = setTimeout(() => {
        connector.events.off("statusChange", statusChangeHandler);
        reject(
          new Error(
            `Timeout waiting for status: ${targetStatus} (${timeout}s)`,
          ),
        );
      }, timeout * 1000);
    }
  });
};

const waitForRemoteStart = (
  chargePoint: ChargePoint,
  connector: Connector,
  timeout?: number,
): Promise<string> => {
  if (connector.transaction?.tagId) {
    return Promise.resolve(connector.transaction.tagId);
  }

  return new Promise<string>((resolve, reject) => {
    let timeoutId: NodeJS.Timeout | null = null;

    const handler = (data: { connectorId: number; tagId: string }) => {
      if (data.connectorId !== connector.id) return;
      if (timeoutId) clearTimeout(timeoutId);
      chargePoint.events.off("transactionStarted", handler);
      resolve(data.tagId);
    };

    chargePoint.events.on("transactionStarted", handler);

    if (timeout && timeout > 0) {
      timeoutId = setTimeout(() => {
        chargePoint.events.off("transactionStarted", handler);
        reject(new Error(`Timeout waiting for remote start (${timeout}s)`));
      }, timeout * 1000);
    }
  });
};

const waitForReservation = (
  chargePoint: ChargePoint,
  connector: Connector,
  timeout?: number,
): Promise<number> => {
  const getReservationId = (): number | null => {
    const reservation =
      chargePoint.reservationManager.getReservationForConnector(connector.id);
    return reservation?.reservationId ?? null;
  };

  const existing = getReservationId();
  if (existing !== null) {
    return Promise.resolve(existing);
  }

  return new Promise<number>((resolve, reject) => {
    let timeoutId: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      connector.events.off("statusChange", statusChangeHandler);
      clearInterval(pollingId);
    };

    const tryResolve = () => {
      const reservationId = getReservationId();
      if (reservationId !== null) {
        cleanup();
        resolve(reservationId);
      }
    };

    const statusChangeHandler = () => {
      tryResolve();
    };

    connector.events.on("statusChange", statusChangeHandler);

    const pollingId = setInterval(tryResolve, 250);

    if (timeout && timeout > 0) {
      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for reservation (${timeout}s)`));
      }, timeout * 1000);
    }
  });
};

const waitForMeterValue = (
  connector: Connector,
  targetValue: number,
  timeout?: number,
): Promise<void> => {
  if (connector.meterValue >= targetValue) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let timeoutId: NodeJS.Timeout | null = null;

    const handler = (data: { meterValue: number }) => {
      if (data.meterValue >= targetValue) {
        if (timeoutId) clearTimeout(timeoutId);
        connector.events.off("meterValueChange", handler);
        resolve();
      }
    };

    connector.events.on("meterValueChange", handler);

    if (timeout && timeout > 0) {
      timeoutId = setTimeout(() => {
        connector.events.off("meterValueChange", handler);
        reject(
          new Error(
            `Timeout waiting for meter value: ${targetValue} (${timeout}s)`,
          ),
        );
      }, timeout * 1000);
    }
  });
};

export const createScenarioExecutorCallbacks = (
  params: ScenarioRuntimeParams,
): ScenarioExecutorCallbacks => {
  const { chargePoint, connector, hooks } = params;

  return {
    onStatusChange: async (status) => {
      chargePoint.updateConnectorStatus(connector.id, status);
    },
    onStartTransaction: async (tagId, batteryCapacityKwh, initialSoc) => {
      chargePoint.startTransaction(
        tagId,
        connector.id,
        batteryCapacityKwh,
        initialSoc,
      );
    },
    onStopTransaction: async () => {
      chargePoint.stopTransaction(connector.id);
    },
    onSetMeterValue: (value) => {
      chargePoint.setMeterValue(connector.id, value);
    },
    onSendMeterValue: async () => {
      chargePoint.sendMeterValue(connector.id);
    },
    onStartAutoMeterValue: (config) => {
      connector.startManualMeterStrategy({
        kind: "increment",
        intervalSeconds: config.intervalSeconds,
        incrementValue: config.incrementValue,
        maxTimeSeconds: config.maxTimeSeconds,
        maxValue: config.maxValue,
      });
    },
    onStopAutoMeterValue: () => {
      connector.stopAutoMeterValue();
    },
    onSendNotification: async (messageType, payload) => {
      switch (messageType) {
        case "Heartbeat":
          chargePoint.sendHeartbeat();
          break;
        case "StatusNotification":
          if (payload?.status) {
            chargePoint.updateConnectorStatus(
              connector.id,
              payload.status as OCPPStatus,
            );
          }
          break;
        default:
          console.warn(
            `Unhandled scenario notification type: ${messageType}`,
            payload,
          );
      }
    },
    onConnectorPlug: async () => {},
    onDelay: async (seconds) => {
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    },
    onWaitForRemoteStart: async (timeout) =>
      waitForRemoteStart(chargePoint, connector, timeout),
    onWaitForStatus: async (targetStatus, timeout) =>
      waitForStatus(connector, targetStatus, timeout),
    onWaitForMeterValue: async (targetValue, timeout) =>
      waitForMeterValue(connector, targetValue, timeout),
    onReserveNow: async (expiryMinutes, idTag, parentIdTag, reservationId) => {
      const expiryDate = new Date(Date.now() + expiryMinutes * 60 * 1000);
      const resolvedId = reservationId || Math.floor(Math.random() * 1000000);
      const status = chargePoint.reservationManager.createReservation(
        connector.id,
        expiryDate,
        idTag,
        parentIdTag,
        resolvedId,
      );
      if (status === ReservationStatus.Accepted) {
        connector.status = OCPPStatus.Reserved;
      }
      return resolvedId;
    },
    onCancelReservation: async (reservationId) => {
      const reservation =
        chargePoint.reservationManager.getReservation(reservationId);
      const cancelled =
        chargePoint.reservationManager.cancelReservation(reservationId);
      if (
        cancelled &&
        reservation &&
        connector.status === OCPPStatus.Reserved
      ) {
        connector.status = OCPPStatus.Available;
      }
    },
    onWaitForReservation: async (timeout) =>
      waitForReservation(chargePoint, connector, timeout),
    onStateChange: hooks?.onStateChange,
    onNodeExecute: hooks?.onNodeExecute,
    onNodeProgress: hooks?.onNodeProgress,
    onError: hooks?.onError,
    log: buildLogger(chargePoint, hooks),
  };
};
