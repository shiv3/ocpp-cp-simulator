import { LogType, type Logger } from "../../shared/Logger";
import type { EventEmitter } from "../../shared/EventEmitter";
import type { SimClock, TimerHandle } from "../../shared/clock";
import type { Connector } from "../connector/Connector";
import type { TransactionStopTriggerReason } from "../connector/Transaction";
import type { Outbox } from "../transport/Outbox";
import type { ChargePointSocket } from "../transport/ChargePointSocket";
import { OCPPStatus } from "../types/OcppTypes";
import { isOcpp2Version, OCPP_2_0_1, OCPP_2_1 } from "../types/OcppVersion";
import type { ChargePoint } from "./ChargePoint";
import type { ChargePointEvents } from "./ChargePointEvents";
import {
  PowerStateError,
  type PowerLossOptions,
  type PowerLossRecord,
  type PowerRecovery,
  type PowerRestoreOptions,
  type PowerRestoreResult,
} from "./ChargePointTypes";

/** What the power loss controller needs from its charge point. */
export interface PowerLossHost {
  /** Public members go through it so spies on the charge point still see
   *  them. */
  readonly chargePoint: Pick<
    ChargePoint,
    | "connect"
    | "getConnector"
    | "isSoapChargePoint"
    | "restorePower"
    | "stopTransaction"
  >;
  readonly clock: () => SimClock;
  readonly connectors: () => Map<number, Connector>;
  readonly events: () => EventEmitter<ChargePointEvents>;
  readonly logger: () => Logger;
  readonly nowDate: () => Date;
  readonly ocppVersion: () => string;
  readonly outbox: () => Outbox;
  /** Power returning is a start of the device (#734, A04.FR.01). */
  readonly markStartupEventPending: () => void;
  /** The charge point's close teardown (`teardownAfterClose`). */
  readonly teardownAfterClose: () => void;
  readonly webSocket: () => ChargePointSocket | null;
}

/**
 * Power loss and restore (#455) with the recovery of the interrupted
 * transactions. Owns the loss record, the pending recovery and the timed
 * restore; the charge point keeps the public methods as thin delegates and
 * asks `poweredOff` wherever it must not act without power.
 */
export class PowerLossController {
  private _powerLoss: PowerLossRecord | null = null;
  private _powerRestoreTimer: TimerHandle | null = null;
  /** #455: the recovery to run once the next BootNotification is Accepted. */
  private _powerRecovery: {
    loss: PowerLossRecord;
    options: PowerRestoreOptions;
    restoredAt: Date;
  } | null = null;

  constructor(private readonly host: PowerLossHost) {}

  /** Drop the timed restore (dispose). */
  clearRestoreTimer(): void {
    if (this._powerRestoreTimer !== null) {
      this.host.clock().clearTimeout(this._powerRestoreTimer);
      this._powerRestoreTimer = null;
    }
  }

  /** Whether the station is without power (#455). */
  get poweredOff(): boolean {
    return this._powerLoss !== null;
  }

  /**
   * Simulate a power loss (#455): the station disappears without a clean
   * stop. The socket closes at once, nothing is sent until
   * {@link restorePower}, and no transaction ends. What a real station keeps
   * in non-volatile storage stays: the transactions (id, meter, tag) and the
   * queue of transaction messages that could not be delivered. A network
   * loss, an OCPP Reset and this are different events: a Reset ends the
   * transactions first (1.6 §5.14, 2.x B11/B12), a network loss keeps the
   * station running.
   */
  powerLoss(options: PowerLossOptions = {}): PowerLossRecord {
    if (this.host.chargePoint.isSoapChargePoint()) {
      throw new PowerStateError("unsupported_transport");
    }
    if (this._powerLoss) throw new PowerStateError("already_powered_off");
    const record: PowerLossRecord = {
      at: this.host.nowDate(),
      transactions: [...this.host.connectors().values()]
        .filter((connector) => connector.hasRunningTransaction)
        .map((connector) => ({
          connectorId: connector.id,
          transactionId: connector.transaction?.id ?? 0,
        })),
    };
    this._powerLoss = record;
    // Power was lost before it was restored: a recovery still waiting for a
    // boot is moot, the new loss defines it.
    this._powerRecovery = null;
    this.host
      .logger()
      .warn(
        `Power loss: ${record.transactions.length} transaction(s) interrupted`,
        LogType.TRANSACTION,
      );
    this.host.events().emit("powerLost", {
      transactions: record.transactions.length,
    });
    this.host.webSocket()?.disconnect();
    this.host.teardownAfterClose();
    const { restoreAfterMs, ...restore } = options;
    if (restoreAfterMs !== undefined) {
      this._powerRestoreTimer = this.host.clock().setTimeout(() => {
        this._powerRestoreTimer = null;
        if (this._powerLoss) this.host.chargePoint.restorePower(restore);
      }, restoreAfterMs);
    }
    return record;
  }

  /**
   * Power returns (#455). The station boots: BootNotification first (1.6
   * §4.2, 2.x B01.FR.03 "after a reboot (for instance due to ... power
   * outage)"), nothing else before it is Accepted, then the transaction
   * messages the outage left queued, then the recovery of the interrupted
   * transactions (see {@link PowerRestoreOptions}).
   */
  restorePower(options: PowerRestoreOptions = {}): PowerRestoreResult {
    const loss = this._powerLoss;
    if (!loss) throw new PowerStateError("not_powered_off");
    if (this._powerRestoreTimer !== null) {
      this.host.clock().clearTimeout(this._powerRestoreTimer);
      this._powerRestoreTimer = null;
    }
    const restoredAt = this.host.nowDate();
    const outageMs = Math.max(0, restoredAt.getTime() - loss.at.getTime());
    this._powerLoss = null;
    // Power returning is a start of the device: the Accepted boot that follows
    // reports StartupOfTheDevice again (#734, A04.FR.01).
    this.host.markStartupEventPending();
    const recovery = this.planPowerRecovery(loss, outageMs, options);
    this._powerRecovery =
      loss.transactions.length > 0
        ? { loss, options: { ...options, transactions: recovery }, restoredAt }
        : null;
    this.host
      .logger()
      .info(
        `Power restored after ${Math.round(outageMs / 1000)}s`,
        LogType.TRANSACTION,
      );
    this.host.events().emit("powerRestored", {
      outageMs,
      recovery: loss.transactions.length > 0 ? recovery : "none",
      transactions: loss.transactions.length,
    });
    this.host.chargePoint.connect();
    return {
      outageMs,
      recovery: loss.transactions.length > 0 ? recovery : "none",
      transactions: loss.transactions.length,
    };
  }

  /**
   * 1.x: the spec leaves it open, so `resume` is the default and `end` is
   * available. 2.1 E17.FR.10/20: resume only when the outage lasted at most
   * `TxResumptionTimeout` (> 0), otherwise end. 2.0.1 has no resumption
   * (no `TxResumed` trigger reason): the default is `end`.
   */
  planPowerRecovery(
    loss: PowerLossRecord,
    outageMs: number,
    options: PowerRestoreOptions,
  ): PowerRecovery {
    if (loss.transactions.length === 0) return options.transactions ?? "resume";
    const wanted =
      options.transactions ??
      (this.host.ocppVersion() === OCPP_2_0_1 ? "end" : "resume");
    if (wanted === "end") return "end";
    if (this.host.ocppVersion() !== OCPP_2_1) return "resume";
    const timeout = options.txResumptionTimeoutSeconds ?? 0;
    return timeout > 0 && outageMs <= timeout * 1000 ? "resume" : "end";
  }

  /** Connectors whose running transaction the pending recovery will end. */
  connectorsEndedByPowerRecovery(): ReadonlySet<number> {
    const pending = this._powerRecovery;
    const out = new Set<number>();
    if (!pending || pending.options.transactions !== "end") return out;
    for (const { connectorId } of pending.loss.transactions) {
      if (
        this.host.chargePoint.getConnector(connectorId)?.hasRunningTransaction
      ) {
        out.add(connectorId);
      }
    }
    return out;
  }

  /** Run the pending power-loss recovery; the boot is Accepted. */
  runPowerRecovery(): void {
    const pending = this._powerRecovery;
    if (!pending) return;
    this._powerRecovery = null;
    const recovery = pending.options.transactions ?? "resume";
    const twoX = isOcpp2Version(this.host.ocppVersion());
    for (const { connectorId } of pending.loss.transactions) {
      const connector = this.host.chargePoint.getConnector(connectorId);
      if (!connector?.hasRunningTransaction) continue;
      if (recovery === "end") {
        // 1.6 reason `PowerLoss`; 2.x E17.FR.21 Ended + AbnormalCondition +
        // PowerLoss. Stamped with the loss, the moment the station recorded
        // the shutdown (E17.FR.02).
        this.host.chargePoint.stopTransaction(connector, "PowerLoss", {
          triggerReason: "AbnormalCondition",
          stoppedReason: "PowerLoss",
          stoppedAt: pending.loss.at,
        });
        continue;
      }
      if (!connector.isAutoMeterValueActive()) {
        connector.startConfiguredMeterValue();
      }
      if (this.host.ocppVersion() === OCPP_2_1) {
        // B13.FR.30, E17.FR.14: Updated + TxResumed with the charging state.
        const status = connector.status;
        this.host.outbox().sendTransactionUpdate(connectorId, {
          // Not in the 2.0.1 vocabulary the encoder is typed against; 2.1 only.
          triggerReason: "TxResumed" as TransactionStopTriggerReason,
          chargingState:
            status === OCPPStatus.Charging
              ? "Charging"
              : status === OCPPStatus.SuspendedEV
                ? "SuspendedEV"
                : status === OCPPStatus.SuspendedEVSE
                  ? "SuspendedEVSE"
                  : "EVConnected",
        });
      } else if (twoX) {
        this.host
          .logger()
          .info(
            `Transaction on connector ${connectorId} continues; OCPP 2.0.1 has no TxResumed trigger reason`,
            LogType.TRANSACTION,
          );
      }
    }
  }
}
