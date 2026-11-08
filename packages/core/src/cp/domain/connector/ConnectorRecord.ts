import type {
  ChargePointErrorCode,
  OCPPAvailability,
} from "../types/OcppTypes";
import { OCPPStatus } from "../types/OcppTypes";
import {
  reduceTransactionPatch,
  type TransactionPatch,
  type TransactionRecord,
} from "./TransactionRecord";

/**
 * What the charger engine owns about one connector
 * (docs/concepts/charger-engine.md, "Charger engine"): status, availability
 * (with the change that waits for the running transaction) and the error
 * fields a StatusNotification carries. Plain JSON, no behavior.
 */
export interface ConnectorRecord {
  readonly status: OCPPStatus;
  readonly availability: OCPPAvailability;
  /** §5.2: a ChangeAvailability answered `Scheduled`, applied when the transaction ends. */
  readonly scheduledAvailability: OCPPAvailability | null;
  /** OCPP 1.6 §7.6 ChargePointErrorCode of the next StatusNotification. */
  readonly errorCode: ChargePointErrorCode;
  readonly errorInfo: string | null;
  readonly vendorErrorCode: string | null;
  /**
   * The transaction on this connector, running or closed-but-not-detached
   * (`cleanTransaction` stamps `stopTime` without detaching). Plain JSON.
   */
  readonly transaction: TransactionRecord | null;
}

export function initialConnectorRecord(): ConnectorRecord {
  return {
    status: OCPPStatus.Unavailable,
    availability: "Operative",
    scheduledAvailability: null,
    errorCode: "NoError",
    errorInfo: null,
    vendorErrorCode: null,
    transaction: null,
  };
}

/**
 * How far a status write reaches. Today's code has three kinds of write and
 * the wire depends on telling them apart:
 *
 * - `local`: the connector's own `statusChange` listeners only (a bare
 *   `connector.status = …`).
 * - `event`: also `ChargePointEvents.connectorStatusChange`, with no
 *   StatusNotification (the charge point went offline).
 * - `full`: also the connection-timeout timer and the StatusNotification
 *   (`ChargePoint.updateConnectorStatus`).
 */
export type StatusScope = "local" | "event" | "full";

/** Every change to a {@link ConnectorRecord}. */
export type ConnectorWrite =
  | {
      readonly kind: "status";
      readonly status: OCPPStatus;
      readonly scope: StatusScope;
    }
  | { readonly kind: "availability"; readonly availability: OCPPAvailability }
  | {
      readonly kind: "scheduledAvailability";
      readonly value: OCPPAvailability | null;
    }
  | { readonly kind: "errorCode"; readonly errorCode: ChargePointErrorCode }
  | { readonly kind: "errorInfo"; readonly errorInfo: string | null }
  | {
      readonly kind: "vendorErrorCode";
      readonly vendorErrorCode: string | null;
    }
  /** A transaction begins, or the connector's transaction is replaced or removed. */
  | {
      readonly kind: "transaction.set";
      readonly transaction: TransactionRecord | null;
    }
  /** Fields of the connector's transaction change; no-op without one. */
  | { readonly kind: "transaction.patch"; readonly patch: TransactionPatch }
  /** A snapshot taken before a restart: no listener hears of it. */
  | {
      readonly kind: "restore";
      readonly status: OCPPStatus;
      readonly availability: OCPPAvailability;
      readonly scheduledAvailability: OCPPAvailability | null;
      /** Absent: the transaction is left as it is. */
      readonly transaction?: TransactionRecord | null;
    };

export function reduceConnectorRecord(
  record: ConnectorRecord,
  write: ConnectorWrite,
): ConnectorRecord {
  switch (write.kind) {
    case "status":
      return { ...record, status: write.status };
    case "availability":
      return { ...record, availability: write.availability };
    case "scheduledAvailability":
      return { ...record, scheduledAvailability: write.value };
    case "errorCode":
      return { ...record, errorCode: write.errorCode };
    case "errorInfo":
      return { ...record, errorInfo: write.errorInfo };
    case "vendorErrorCode":
      return { ...record, vendorErrorCode: write.vendorErrorCode };
    case "transaction.set":
      return { ...record, transaction: write.transaction };
    case "transaction.patch":
      return record.transaction
        ? {
            ...record,
            transaction: reduceTransactionPatch(
              record.transaction,
              write.patch,
            ),
          }
        : record;
    case "restore":
      return {
        ...record,
        status: write.status,
        availability: write.availability,
        scheduledAvailability: write.scheduledAvailability,
        transaction:
          write.transaction === undefined
            ? record.transaction
            : write.transaction,
      };
  }
}

/**
 * Where a connector's record lives. A connector of a charge point reads and
 * writes the charger engine's state through this port; a connector on its own
 * (a unit test) keeps the record in a private cell that applies the same
 * reducer.
 */
export interface ConnectorStateStore {
  read(): ConnectorRecord;
  write(write: ConnectorWrite): void;
}
