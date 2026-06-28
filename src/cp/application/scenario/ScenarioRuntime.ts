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

interface CancellableWait<T> {
  promise: Promise<T>;
  cancel: () => void;
}

type CancellablePromise<T> = Promise<T> & { cancel?: () => void };

const cancellablePromise = <T>({
  promise,
  cancel,
}: CancellableWait<T>): CancellablePromise<T> => {
  const wrapped = promise.finally(cancel) as CancellablePromise<T>;
  wrapped.cancel = cancel;
  return wrapped;
};

const waitForRemoteStart = (
  chargePoint: ChargePoint,
  connector: Connector,
  timeout?: number,
): CancellableWait<string> => {
  // Register so the handler emits remoteStartReceived instead of starting a transaction
  chargePoint.registerScenarioHandler(connector.id);

  let cleanupFn: (() => void) | null = null;

  const promise = new Promise<string>((resolve, reject) => {
    let timeoutId: NodeJS.Timeout | null = null;
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      chargePoint.events.off("remoteStartReceived", handler);
      chargePoint.events.off("disconnected", disconnectHandler);
      chargePoint.unregisterScenarioHandler(connector.id);
    };

    cleanupFn = cleanup;

    const handler = (data: { connectorId: number; tagId: string }) => {
      if (data.connectorId !== connector.id) return;
      cleanup();
      resolve(data.tagId);
    };

    const disconnectHandler = () => {
      cleanup();
      reject(new Error("Disconnected while waiting for remote start"));
    };

    chargePoint.events.on("remoteStartReceived", handler);
    chargePoint.events.on("disconnected", disconnectHandler);

    if (timeout && timeout > 0) {
      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for remote start (${timeout}s)`));
      }, timeout * 1000);
    }
  });

  return {
    promise,
    cancel: () => cleanupFn?.(),
  };
};

/** Mirror of waitForRemoteStart, but for the CSMS-initiated stop side.
 *  Registers a scenario-stop handler on the CP so the default
 *  RemoteStopTransactionHandler defers, then waits for the emitted
 *  `remoteStopReceived` event. Resolves with the transactionId AND the
 *  OCPP §6.21 stop reason ("Remote" for the CSMS-initiated path) so the
 *  subsequent Transaction Stop node can pass it through to
 *  StopTransaction.req. Rejects on disconnect or timeout. */
const waitForRemoteStop = (
  chargePoint: ChargePoint,
  connector: Connector,
  timeout?: number,
): CancellableWait<{ transactionId: number; reason: string }> => {
  chargePoint.registerScenarioStopHandler(connector.id);

  let cleanupFn: (() => void) | null = null;

  const promise = new Promise<{ transactionId: number; reason: string }>(
    (resolve, reject) => {
      let timeoutId: NodeJS.Timeout | null = null;
      let settled = false;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        chargePoint.events.off("remoteStopReceived", handler);
        chargePoint.events.off("disconnected", disconnectHandler);
        chargePoint.unregisterScenarioStopHandler(connector.id);
      };

      cleanupFn = cleanup;

      const handler = (data: {
        connectorId: number;
        transactionId: number;
      }) => {
        if (data.connectorId !== connector.id) return;
        cleanup();
        // §6.21: CSMS-initiated stop → reason="Remote". Hard-code here
        // since the request payload itself doesn't carry a reason field;
        // the handler is what knows the provenance.
        resolve({ transactionId: data.transactionId, reason: "Remote" });
      };

      const disconnectHandler = () => {
        cleanup();
        reject(new Error("Disconnected while waiting for remote stop"));
      };

      chargePoint.events.on("remoteStopReceived", handler);
      chargePoint.events.on("disconnected", disconnectHandler);

      if (timeout && timeout > 0) {
        timeoutId = setTimeout(() => {
          cleanup();
          reject(new Error(`Timeout waiting for remote stop (${timeout}s)`));
        }, timeout * 1000);
      }
    },
  );

  return {
    promise,
    cancel: () => cleanupFn?.(),
  };
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
  if (connector.meterValue >= targetValue || connector.transaction === null) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let timeoutId: NodeJS.Timeout | null = null;
    let settled = false;

    const cleanup = () => {
      if (settled) return false;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      connector.events.off("meterValueChange", meterHandler);
      connector.events.off("transactionChange", transactionHandler);
      return true;
    };

    const meterHandler = (data: { meterValue: number }) => {
      if (data.meterValue >= targetValue) {
        if (cleanup()) resolve();
      }
    };

    const transactionHandler = (data: { transaction: unknown | null }) => {
      if (data.transaction === null || connector.transaction === null) {
        if (cleanup()) resolve();
      }
    };

    connector.events.on("meterValueChange", meterHandler);
    connector.events.on("transactionChange", transactionHandler);

    if (timeout && timeout > 0) {
      timeoutId = setTimeout(() => {
        if (!cleanup()) return;
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
    onStopTransaction: async (reason) => {
      // The cast keeps stopTransaction's StopTransactionReason union
      // happy without dragging the enum import into the callbacks
      // declaration. ChargePoint.stopTransaction safely no-ops if there
      // is no active transaction, so we don't guard here either.
      chargePoint.stopTransaction(
        connector.id,
        reason as Parameters<typeof chargePoint.stopTransaction>[1],
      );
    },
    onSetMeterValue: (value) => {
      chargePoint.setMeterValue(connector.id, value);
    },
    onGetMeterValue: () => connector.meterValue,
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
    onSetEVSettings: (settings) => {
      // Merge — only specified fields land on the connector. The connector
      // setter spreads `_evSettings = { ...settings }` and emits
      // `evSettingsChange`, which surfaces to subscribers and (in remote
      // mode) the browser via the `connector_ev_settings` event.
      connector.evSettings = { ...connector.evSettings, ...settings };
    },
    onGetEVSettings: () => connector.evSettings,
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
    onWaitForRemoteStart: (timeout) => {
      return cancellablePromise(
        waitForRemoteStart(chargePoint, connector, timeout),
      );
    },
    onWaitForRemoteStop: (timeout) => {
      return cancellablePromise(
        waitForRemoteStop(chargePoint, connector, timeout),
      );
    },
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
        chargePoint.updateConnectorStatus(connector.id, OCPPStatus.Reserved);
      }
      return resolvedId;
    },
    onCancelReservation: async (reservationId) => {
      const reservation =
        chargePoint.reservationManager.getReservation(reservationId);
      const cancelled =
        chargePoint.reservationManager.cancelReservation(reservationId);
      if (cancelled && reservation) {
        // Free the connector the reservation was actually for — NOT the
        // scenario-bound connector — so cancelling a reservation on another
        // connector of a multi-connector CP doesn't clear the wrong one.
        const reserved = chargePoint.getConnector(reservation.connectorId);
        if (reserved && reserved.status === OCPPStatus.Reserved) {
          chargePoint.updateConnectorStatus(
            reservation.connectorId,
            OCPPStatus.Available,
          );
        }
      }
    },
    onWaitForReservation: async (timeout) =>
      waitForReservation(chargePoint, connector, timeout),
    onStateChange: hooks?.onStateChange,
    onNodeExecute: hooks?.onNodeExecute,
    onNodeProgress: hooks?.onNodeProgress,
    onError: hooks?.onError,
    log: buildLogger(chargePoint, hooks),
    // §4.9: connectorId === -1 sentinel means "use the scenario's bound
    // connector"; otherwise the node specified an explicit target (0 for
    // CP main controller, >0 for another connector).
    onSendStatusNotification: (connectorId, status, opts) => {
      const targetId = connectorId === -1 ? connector.id : connectorId;
      chargePoint.sendStatusNotificationRaw(targetId, status, opts);
    },
    onSetUnlockOutcome: (outcome) => {
      connector.unlockResponse = outcome;
    },
    onConfigSet: (key, value) => {
      chargePoint.configuration.applyChange(key, value);
    },
    onSendDataTransfer: (vendorId, messageId, data) => {
      chargePoint.sendDataTransfer(vendorId, messageId, data);
    },
  };
};
