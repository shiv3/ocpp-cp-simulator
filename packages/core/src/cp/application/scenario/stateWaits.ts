// Scenario waits on charge point state (connector status, connection,
// reservation, meter value), split out of ScenarioRuntime.ts (#877).
import type { CancellableWait } from "./cancellable";
import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
import type { Connector } from "../../domain/connector/Connector";
import type { OCPPStatus } from "../../domain/types/OcppTypes";
import { clockOf, type SimClock, type TimerHandle } from "../../shared/clock";

export const waitForStatus = (
  connector: Connector,
  targetStatus: OCPPStatus,
): CancellableWait<void> => {
  if (connector.status === targetStatus) {
    return { promise: Promise.resolve(), cancel: () => {} };
  }

  let cleanupFn: (() => void) | null = null;

  const promise = new Promise<void>((resolve) => {
    const cleanup = () => {
      connector.events.off("statusChange", statusChangeHandler);
    };
    cleanupFn = cleanup;

    const statusChangeHandler = (data: {
      status: OCPPStatus;
      previousStatus: OCPPStatus;
    }) => {
      if (data.status === targetStatus) {
        cleanup();
        resolve();
      }
    };

    connector.events.on("statusChange", statusChangeHandler);
  });

  return { promise, cancel: () => cleanupFn?.() };
};

/** Issue #240: park until the WebSocket reaches `event`. Level-triggered —
 *  if the charge point is already in the target state, resolve immediately
 *  (same convention as waitForStatus / waitForReservation). Deliberately
 *  does NOT subscribe the reject-on-disconnect handler the other waits use:
 *  surviving the disconnected span is this wait's entire purpose. */
export const waitForConnection = (
  chargePoint: ChargePoint,
  event: "connected" | "disconnected",
): CancellableWait<void> => {
  const inTargetState = () =>
    event === "connected"
      ? chargePoint.isWebSocketConnected
      : !chargePoint.isWebSocketConnected;

  if (inTargetState()) {
    return { promise: Promise.resolve(), cancel: () => {} };
  }

  let cleanupFn: (() => void) | null = null;

  const promise = new Promise<void>((resolve) => {
    let settled = false;

    const handler = () => {
      cleanup();
      resolve();
    };
    const off = chargePoint.events.on(event, handler);

    const cleanup = () => {
      if (settled) return;
      settled = true;
      off();
    };
    cleanupFn = cleanup;
  });

  return { promise, cancel: () => cleanupFn?.() };
};

export const waitForReservation = (
  chargePoint: ChargePoint,
  connector: Connector,
): CancellableWait<number> => {
  // §4.9 S3: fail-fast if the charge point cannot receive ReserveNow
  if (!chargePoint.canReceiveCsmsCall("ReserveNow")) {
    const version = chargePoint.ocppVersion;
    const versionDesc = chargePoint.isSoapChargePoint()
      ? version === "OCPP-1.5"
        ? "OCPP-1.5 SOAP"
        : "send-only SOAP"
      : version;
    const errorMsg =
      `Reservation trigger requires ReserveNow capability; ` +
      `this charge point (${versionDesc}) does not support it — the scenario would wait forever`;
    return { promise: Promise.reject(new Error(errorMsg)), cancel: () => {} };
  }

  const getReservationId = (): number | null => {
    const reservation =
      chargePoint.reservationManager.getReservationForConnector(connector.id);
    return reservation?.reservationId ?? null;
  };

  const existing = getReservationId();
  if (existing !== null) {
    return { promise: Promise.resolve(existing), cancel: () => {} };
  }

  let cleanupFn: (() => void) | null = null;

  const promise = new Promise<number>((resolve) => {
    const cleanup = () => {
      connector.events.off("statusChange", statusChangeHandler);
      clockOf(chargePoint).clearInterval(pollingId);
    };
    cleanupFn = cleanup;

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

    const pollingId = clockOf(chargePoint).setInterval(tryResolve, 250);
  });

  return { promise, cancel: () => cleanupFn?.() };
};

export const waitForMeterValue = (
  connector: Connector,
  targetValue: number,
  timeout: number | undefined,
  clock: SimClock,
): Promise<void> => {
  if (connector.meterValue >= targetValue || connector.transaction === null) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let timeoutId: TimerHandle | null = null;
    let settled = false;

    const cleanup = () => {
      if (settled) return false;
      settled = true;
      if (timeoutId) clock.clearTimeout(timeoutId);
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
      timeoutId = clock.setTimeout(() => {
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
