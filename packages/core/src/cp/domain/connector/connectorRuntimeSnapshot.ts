import type { EventEmitter } from "../../shared/EventEmitter";
import { OCPPStatus, type OCPPAvailability } from "../types/OcppTypes";
import type { Transaction } from "./Transaction";
import { recordOfTransaction, transactionOfRecord } from "./TransactionRecord";
import type { ConnectorRecord, ConnectorWrite } from "./ConnectorRecord";
import type { ConnectorEvents } from "./Connector";

/** What the runtime snapshot needs from the connector that owns the state. */
export interface ConnectorRuntimeSnapshotHost {
  record(): ConnectorRecord;
  writeRecord(write: ConnectorWrite): void;
  meterValueWh(): number;
  setMeterValueWh(value: number): void;
  socPercent(): number | null;
  setSocPercent(value: number | null): void;
  socAwaitsNextTransaction(): boolean;
  setSocAwaitsNextTransaction(value: boolean): void;
  lastAutoStartedScenarioKey(): string | null;
  setLastAutoStartedScenarioKey(value: string | null): void;
  setEvCableConnected(value: boolean): void;
  setEvReady(value: boolean): void;
  transaction(): Transaction | null;
  hasRunningTransaction(): boolean;
  emit: EventEmitter<ConnectorEvents>["emit"];
}

/**
 * Capture and restore of the connector's runtime state across a daemon
 * restart. Moved verbatim out of `Connector` (#877).
 */
export class ConnectorRuntimeSnapshot {
  constructor(private readonly host: ConnectorRuntimeSnapshotHost) {}

  /**
   * Capture the runtime state needed to resume this connector after a
   * daemon restart. Paired with {@link restoreRuntimeSnapshot}. The
   * returned shape is a structural copy: callers can persist it and
   * round-trip it through JSON without aliasing live connector state.
   */
  snapshotRuntime(): {
    status: OCPPStatus;
    availability: OCPPAvailability;
    scheduledAvailability: OCPPAvailability | null;
    transaction: Transaction | null;
    meterValueWh: number;
    socPercent: number | null;
    socAwaitsNextTransaction: boolean;
    lastAutoStartedScenarioKey: string | null;
  } {
    // The engine-owned part is read from the connector's record, which is
    // the charger engine's state, in one go.
    const record = this.host.record();
    return {
      status: record.status,
      availability: record.availability,
      scheduledAvailability: record.scheduledAvailability,
      transaction: record.transaction
        ? transactionOfRecord(record.transaction)
        : null,
      meterValueWh: this.host.meterValueWh(),
      socPercent: this.host.socPercent(),
      socAwaitsNextTransaction: this.host.socAwaitsNextTransaction(),
      lastAutoStartedScenarioKey: this.host.lastAutoStartedScenarioKey(),
    };
  }

  /**
   * Apply a snapshot captured before a daemon restart. Writes the
   * private fields directly so we do NOT emit `statusChange` /
   * `meterChange` / etc. — emitting on restore would cause the
   * ChargePoint to push a duplicate StatusNotification or MeterValues
   * before the WebSocket is even up, and would cause the auto-start
   * dedup key to be cleared by re-triggering its setter.
   *
   * Restore is idempotent on already-default values: nulls and
   * `meterValueWh = 0` simply rewrite the existing zero state.
   */
  restoreRuntimeSnapshot(snapshot: {
    status: OCPPStatus;
    availability: OCPPAvailability;
    scheduledAvailability: OCPPAvailability | null;
    transaction: Transaction | null;
    meterValueWh: number;
    socPercent: number | null;
    /** Absent in snapshots written before this field existed; `false` there,
     *  which is the behaviour those builds had. */
    /** Absent in snapshots written before this field existed; `false` there,
     *  so a restored value is treated as a leftover rather than inherited by
     *  the next transaction. */
    socAwaitsNextTransaction?: boolean;
    lastAutoStartedScenarioKey: string | null;
  }): void {
    this.host.writeRecord({
      kind: "restore",
      status: snapshot.status,
      availability: snapshot.availability,
      scheduledAvailability: snapshot.scheduledAvailability,
      transaction: snapshot.transaction
        ? recordOfTransaction({
            ...snapshot.transaction,
            signedBeginOcmf: undefined,
          })
        : null,
    });
    // #315: the signing key is in memory only, so a begin reading signed
    // before the restart no longer matches MeterPublicKey<id>; drop it.
    this.host.setMeterValueWh(snapshot.meterValueWh);
    this.host.setSocPercent(snapshot.socPercent);
    // Carried across the restart with the SoC it describes. Without it a
    // restored meter-derived SoC came back looking explicit, and the next
    // transaction on that connector opened on the previous battery's charge
    // again — the defect this marker exists to prevent, reachable a second
    // time through persistence (#301).
    // Carried across the restart with the SoC it describes, not inferred from
    // it. Reconstructing this from "does the snapshot carry a transaction?"
    // could not see the case that matters: a session that has *ended* leaves a
    // value that is session-owned and transaction-less, indistinguishable from
    // one waiting for the next session (#301).
    this.host.setSocAwaitsNextTransaction(
      snapshot.socAwaitsNextTransaction ?? false,
    );
    this.host.setLastAutoStartedScenarioKey(
      snapshot.lastAutoStartedScenarioKey,
    );
    // The cable is not stored (#453). What a restart shows of it is inferred
    // from what the snapshot proves: a running transaction, or a status that
    // only exists with an EV on the cable, means a plugged-in EV. Nothing
    // else is invented; a restart is not a cable event.
    this.host.setEvCableConnected(
      (snapshot.transaction !== null &&
        snapshot.transaction.stopTime === null) ||
        snapshot.status === OCPPStatus.Preparing ||
        snapshot.status === OCPPStatus.Finishing ||
        snapshot.status === OCPPStatus.SuspendedEV ||
        snapshot.status === OCPPStatus.SuspendedEVSE ||
        snapshot.status === OCPPStatus.Charging,
    );
    this.host.setEvReady(snapshot.status !== OCPPStatus.SuspendedEV);
    const restored = this.host.transaction();
    if (restored && this.host.hasRunningTransaction()) {
      this.host.emit("transactionRestored", {
        transaction: restored,
      });
    }
  }
}
