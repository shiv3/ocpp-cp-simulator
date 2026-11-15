import { LogType, type Logger } from "../../shared/Logger";
import type { SimClock, TimerHandle } from "../../shared/clock";
import type { Connector } from "../connector/Connector";
import {
  buildSampledValues,
  type MeterSampleOverrides,
  type ReadingContext,
} from "../connector/MeterValueBuilder";
import { measurandEnumFor } from "../connector/measurandEnum";
import {
  TX_ENDED_SAMPLES_MAX,
  type TransactionUpdateOptions,
} from "../connector/Transaction";
import type { Outbox } from "../transport/Outbox";
import { isOcpp2Version } from "../types/OcppVersion";
import type { ChargePoint } from "./ChargePoint";
import type { ConfigurationStore } from "./ConfigurationStore";
import type { MainMeter } from "./MainMeter";

/** What the meter sampling needs from its charge point. Members read
 *  through functions are assigned after the sampling is constructed. */
export interface MeterSamplingHost {
  /** Public members go through it so spies on the charge point still see
   *  them. */
  readonly chargePoint: Pick<
    ChargePoint,
    | "getConnector"
    | "ocppVersion"
    | "recordTxEndedSample"
    | "sendMeterValue"
    | "sendScheduledMeterValue"
    | "txUpdatedMeterValues"
  >;
  readonly clock: () => SimClock;
  readonly configuration: () => ConfigurationStore;
  readonly connectors: () => Map<number, Connector>;
  readonly logger: () => Logger;
  /** Reassigned (tests set it): always read through the function. */
  readonly mainMeter: () => MainMeter | undefined;
  readonly outbox: () => Outbox;
}

/**
 * The samples a charge point takes on its own: the per-connector periodic
 * sampler (#839), the clock-aligned sample (#454) and the transaction-end
 * history (#607). Owns the sampler timers; the charge point keeps the
 * public methods as thin delegates.
 */
export class MeterSampling {
  /** Station-driven periodic samplers of the running transactions. */
  readonly samplers: Map<number, TimerHandle> = new Map();

  constructor(private readonly host: MeterSamplingHost) {}

  setMeterValue(connectorId: number, value: number): void {
    const connector = this.host.chargePoint.getConnector(connectorId);
    if (!connector) {
      this.host
        .logger()
        .error(`Connector ${connectorId} not found`, LogType.METER_VALUE);
      return;
    }
    connector.meterValue = value;
  }

  sendMeterValue(
    connectorId: number,
    context?: ReadingContext,
    overrides?: MeterSampleOverrides,
  ): void {
    if (connectorId === 0 && this.host.mainMeter()) {
      this.host.outbox().sendMeterValue(undefined, 0, context, overrides);
      return;
    }
    const connector = this.host.chargePoint.getConnector(connectorId);
    if (!connector) {
      this.host
        .logger()
        .error(`Connector ${connectorId} not found`, LogType.METER_VALUE);
      return;
    }
    this.host
      .outbox()
      .sendMeterValue(
        connector.transaction?.id ?? undefined,
        connectorId,
        context,
        overrides,
      );
  }

  /**
   * One clock-aligned sample per connector for `boundaryMs` (#454), carrying
   * `MeterValuesAlignedData` with `Sample.Clock` and the boundary instant.
   * OCPP 2.x puts a sample for an EVSE with a live transaction into
   * TransactionEvent(Updated, MeterValueClock) — never the MeterValuePeriodic
   * trigger of #347 — and every other sample into MeterValues. On 1.x a live
   * transaction's id rides along once the CSMS has assigned one.
   */
  emitClockAlignedSamples(boundaryMs: number): void {
    // 1.6 samples the transaction-end history on the same grid
    // (`StopTxnAlignedData`, 1.6 §3.16.2); 2.x has a
    // grid of its own (`_txEndedAligned`).
    if (!isOcpp2Version(this.host.chargePoint.ocppVersion)) {
      this.recordAlignedTxEndedSamples(
        this.host.configuration().stopTxnAlignedData(),
        boundaryMs,
      );
    }
    // Empty by default; the interval change already logged that it is.
    const measurands = this.host.configuration().meterValuesAlignedData();
    if (measurands.length === 0) return;
    const timestamp = new Date(boundaryMs);
    // 2.x AlignedDataCtrlr.SendDuringIdle is a station-level variable: while
    // any transaction runs, no clock-aligned values go out for any EVSE or the
    // main meter (J01.FR.20; J01.FR.19 is the per-EVSE form the variable does
    // not have here).
    if (
      isOcpp2Version(this.host.chargePoint.ocppVersion) &&
      this.host.configuration().alignedDataSendDuringIdle() &&
      [...this.host.connectors().values()].some((c) => c.hasRunningTransaction)
    ) {
      return;
    }
    this.host.connectors().forEach((connector) => {
      if (
        this.sendSampleInTransactionEvent(connector, {
          triggerReason: "MeterValueClock",
          context: "Sample.Clock",
          measurands,
          timestamp,
        })
      ) {
        return;
      }
      // `0` until StartTransaction.conf assigns the id.
      const id = connector.transaction?.id;
      const transactionId =
        connector.hasRunningTransaction && id ? id : undefined;
      this.host
        .outbox()
        .sendMeterValue(transactionId, connector.id, "Sample.Clock", {
          measurands,
          timestamp,
        });
    });
    if (this.host.mainMeter()) {
      this.host.outbox().sendMeterValue(undefined, 0, "Sample.Clock", {
        measurands,
        timestamp,
      });
    }
  }

  /**
   * #607: append one formatted sample to the connector's transaction-end
   * history. Formatted now, from the point the sample set of this instant
   * reads, so a later configuration change cannot reformat it (#327 §3.3).
   */
  recordTxEndedSample(
    connector: Connector,
    measurands: string[],
    context: "Transaction.Begin" | "Sample.Periodic" | "Sample.Clock",
    timestamp: Date,
  ): void {
    const transaction = connector.transaction;
    if (!transaction || !connector.hasRunningTransaction) return;
    // 2.x: the same MeasurandEnumType filter and unit multiplier as every
    // other sample of the dialect (#714, #826); a name outside the enum is
    // never recorded (B05.FR.07 rejects it in SetVariables, but a persisted
    // or scenario-set list may still carry one).
    const ocpp2 = isOcpp2Version(this.host.chargePoint.ocppVersion);
    const allowed = ocpp2
      ? measurandEnumFor(this.host.chargePoint.ocppVersion)
      : null;
    const kept = allowed
      ? measurands.filter((m) => allowed.has(m))
      : measurands;
    if (kept.length === 0) return;
    const sampledValue = buildSampledValues(connector, kept, context, {
      unitMultiplier: ocpp2,
      intervalStream:
        context === "Sample.Clock" ? "txEnded-aligned" : "txEnded-sampled",
    });
    if (sampledValue.length === 0) return;
    const history = transaction.txEndedSamples ?? [];
    const next = [
      ...history,
      { timestamp: timestamp.toISOString(), sampledValue },
    ].slice(-TX_ENDED_SAMPLES_MAX);
    connector.patchTransaction({ txEndedSamples: next });
  }

  /**
   * The scheduler-tick sample of the history (`StopTxnSampledData`). 1.6
   * samples at every tick, the cadence of the MeterValues it accompanies
   * (1.6 §3.16.1). 2.x samples when `TxEndedInterval`
   * seconds have passed since the previous one (or the start), judged at the
   * tick, so the interval cannot be finer than the tick.
   */
  recordSampledTxEndedSample(connector: Connector): void {
    const transaction = connector.transaction;
    if (!transaction || !connector.hasRunningTransaction) return;
    const measurands = this.host.configuration().stopTxnSampledData();
    if (measurands.length === 0) return;
    const now = this.host.clock().now();
    if (isOcpp2Version(this.host.chargePoint.ocppVersion)) {
      const intervalMs = this.host.configuration().txEndedInterval() * 1000;
      if (intervalMs <= 0) return;
      const history = transaction.txEndedSamples ?? [];
      const last = [...history]
        .reverse()
        .find((e) => e.sampledValue[0]?.context === "Sample.Periodic");
      const lastMs = last
        ? Date.parse(last.timestamp)
        : transaction.startTime.getTime();
      if (now - lastMs < intervalMs) return;
    }
    this.host.chargePoint.recordTxEndedSample(
      connector,
      measurands,
      "Sample.Periodic",
      new Date(now),
    );
  }

  recordAlignedTxEndedSamples(measurands: string[], boundaryMs: number): void {
    if (measurands.length === 0) return;
    const timestamp = new Date(boundaryMs);
    this.host
      .connectors()
      .forEach((connector) =>
        this.host.chargePoint.recordTxEndedSample(
          connector,
          measurands,
          "Sample.Clock",
          timestamp,
        ),
      );
  }

  /**
   * #722, 1.6 errata 3.15 (Part 2 §4.7) and §3.16.1 / §9.1.19: while a
   * transaction runs and `MeterValueSampleInterval` > 0, a MeterValues.req
   * with the `MeterValuesSampledData` measurands goes out every interval,
   * whatever drives the register. The connector's configured meter strategy
   * (auto-meter curve, increment fallback) then only moves the register, so
   * there is one sample per tick, not two schedules. 1.x only (SOAP
   * included): on 2.x the existing sampling is unchanged.
   *
   * The interval is read when the sampler starts (the transaction's start,
   * or its restore after a restart) and again when a ChangeConfiguration of
   * `MeterValueSampleInterval` re-arms the running samplers (#839); at 0
   * none runs. Called again for the same running transaction (the
   * `transactionChange` that persists a `startCallError` or an id), it keeps
   * the timer and so the phase.
   */
  startPeriodicSampling(connector: Connector): void {
    if (isOcpp2Version(this.host.chargePoint.ocppVersion)) return;
    if (this.samplers.has(connector.id)) return;
    connector.setStationOwnsMeterSampling(true);
    const seconds = this.host.configuration().meterValueSampleInterval();
    if (seconds <= 0) return;
    const timer = this.host.clock().setInterval(() => {
      // A connector removed (or replaced under the same id) while its timer
      // ran is not sampled any more (#839).
      if (
        !connector.hasRunningTransaction ||
        this.host.connectors().get(connector.id) !== connector
      ) {
        this.stopPeriodicSampling(connector.id);
        return;
      }
      // A transaction whose StartTransaction.req was answered with a
      // CALLERROR (#527) is sampled too (errata 3.15, §4.7: every interval,
      // SHALL): the MeterValues.req carries the id its StartTransaction got,
      // or -1 until it has one (errata 3.18, §4.8; #565).
      // Offline too: §3.7 "When offline, the Charge Point MUST queue any
      // transaction-related messages", periodic MeterValues included. The
      // outbox queues it (a MeterValues of a transaction) and replays it in
      // order after the reconnect.
      this.host.chargePoint.sendScheduledMeterValue(connector.id);
    }, seconds * 1000);
    this.samplers.set(connector.id, timer);
  }

  /** #839: a new `MeterValueSampleInterval` starts the cadence over on every
   *  running transaction; 0 leaves them without a sampler. */
  rearmPeriodicSampling(): void {
    for (const connectorId of [...this.samplers.keys()]) {
      this.stopPeriodicSampling(connectorId);
    }
    for (const connector of this.host.connectors().values()) {
      if (connector.hasRunningTransaction)
        this.startPeriodicSampling(connector);
    }
  }

  stopPeriodicSampling(connectorId: number): void {
    const timer = this.samplers.get(connectorId);
    if (timer === undefined) return;
    this.host.clock().clearInterval(timer);
    this.samplers.delete(connectorId);
  }

  /**
   * One sample from the connector's meter-value scheduler (#347).
   *
   * With {@link txUpdatedMeterValues} on and an OCPP 2.x transaction
   * running, it rides TransactionEvent(Updated, MeterValuePeriodic) with
   * `MeterValuesSampledData` (2.0.1 `SampledDataCtrlr.TxUpdatedMeasurands`),
   * so the E13 transaction-message retries cover it. A sample with nothing
   * in it sends nothing, as MeterValues does. Otherwise — option off, no
   * transaction, or OCPP 1.x — it is the MeterValues of
   * {@link sendMeterValue}. Only the scheduler calls this: a MeterValues a
   * caller or a TriggerMessage asks for stays a MeterValues.
   */
  sendScheduledMeterValue(connectorId: number): void {
    const connector = this.host.chargePoint.getConnector(connectorId);
    if (connector) this.recordSampledTxEndedSample(connector);
    if (
      this.host.chargePoint.txUpdatedMeterValues &&
      connector &&
      this.sendSampleInTransactionEvent(connector, {
        triggerReason: "MeterValuePeriodic",
        context: "Sample.Periodic",
        skipWithoutMeterValue: true,
      })
    ) {
      return;
    }
    this.host.chargePoint.sendMeterValue(connectorId);
  }

  /**
   * The OCPP 2.x routing shared by the clock-aligned (#454) and scheduled
   * (#347) samples: with a transaction running on the connector, the sample
   * rides TransactionEvent(Updated) and this returns true. Otherwise it
   * sends nothing and returns false, leaving the caller to send its own
   * MeterValues.
   */
  sendSampleInTransactionEvent(
    connector: Connector,
    sample: Omit<TransactionUpdateOptions, "meterValues">,
  ): boolean {
    if (
      !isOcpp2Version(this.host.chargePoint.ocppVersion) ||
      !connector.hasRunningTransaction
    ) {
      return false;
    }
    this.host.outbox().sendTransactionUpdate(connector.id, {
      ...sample,
      meterValues: true,
    });
    return true;
  }
}
