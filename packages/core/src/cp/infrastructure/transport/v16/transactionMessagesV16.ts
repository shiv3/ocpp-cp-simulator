// The OCPP 1.6 transaction messages of OCPPMessageHandler (#877):
// StartTransaction.req and StopTransaction.req with their signed and
// StopTxnSampledData readings (#315, #607), and MeterValues.req.
import type {
  MeterValuesRequestV16,
  StartTransactionRequestV16,
  StopTransactionRequestV16,
} from "@ocpp-cp-simulator/ocpp/index";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { Transaction } from "../../../domain/connector/Transaction";
import {
  buildSampledValues,
  toOcppJ16Wire,
  type MeterSampleOverrides,
  type ReadingContext,
} from "../../../domain/connector/MeterValueBuilder";
import {
  signReading,
  toOcpp16SampledValue,
} from "../../../domain/connector/SignedMeterData";
import type { OperatingPoint } from "../../../domain/connector/OperatingPoint";
import type { TransactionLifecycleEvent } from "../../../domain/transport/TransactionLifecycleEvent";
import { clockOf } from "../../../shared/clock";
import type { SimClock } from "../../../shared/clock";
import type { Logger } from "../../../shared/Logger";
import { LogType } from "../../../shared/Logger";
import { OCPPAction } from "../../../domain/types/OcppTypes";
import { patchTransaction } from "../handlers/patchTransaction";
import type { SerialCallQueueV16 } from "./serialCallQueueV16";

/** What the transaction messages need from the 1.6 handler. */
export interface TransactionMessagesV16Context {
  /** The charge point object itself, typed narrowly: `signReading` and
   *  `clockOf` read it. */
  readonly chargePoint: Pick<
    ChargePoint,
    "clock" | "configuration" | "getConnector" | "mainMeter" | "signedMeterFor"
  >;
  readonly logger: Logger;
  readonly delivery: Pick<
    SerialCallQueueV16,
    "sendRequest" | "wireTransactionId"
  >;
  readonly generateMessageId: () => string;
}

export class TransactionMessagesV16 {
  private readonly _chargePoint: TransactionMessagesV16Context["chargePoint"];
  private readonly _logger: Logger;
  private readonly _delivery: TransactionMessagesV16Context["delivery"];
  private readonly _generateMessageId: () => string;

  constructor(context: TransactionMessagesV16Context) {
    this._chargePoint = context.chargePoint;
    this._logger = context.logger;
    this._delivery = context.delivery;
    this._generateMessageId = context.generateMessageId;
  }

  private sendStartTransaction(
    transaction: Transaction,
    connectorId: number,
  ): void {
    const messageId = this.generateMessageId();
    const payload: StartTransactionRequestV16 = {
      connectorId: connectorId,
      idTag: transaction.tagId,
      meterStart: transaction.meterStart,
      timestamp: transaction.startTime.toISOString(),
      // §4.8 MUST: include reservationId when this transaction ends a
      // reservation. Domain layer populates this on the Transaction.
      ...(transaction.reservationId !== undefined
        ? { reservationId: transaction.reservationId }
        : {}),
    };
    // #315: 1.6 StartTransaction has no field for it, so the signed begin
    // reading waits on the transaction for StopTransaction.transactionData.
    const signedBegin = signReading(
      this._chargePoint,
      connectorId,
      transaction.tagId,
      {
        reason: "B",
        energyWh: transaction.meterStart,
        at: transaction.startTime,
      },
    );
    if (signedBegin) {
      patchTransaction(this._chargePoint, connectorId, transaction, {
        signedBeginOcmf: signedBegin.ocmf,
      });
    }
    // #607: the Transaction.Begin sample of StopTxnSampledData waits on the
    // transaction like the signed one; StopTransaction is the only message
    // that can carry it (1.6 §3.16.1).
    const connector = this._chargePoint.getConnector(connectorId);
    const beginMeasurands =
      this._chargePoint.configuration.stopTxnSampledData();
    if (connector && beginMeasurands.length > 0) {
      const sampledValue = buildSampledValues(
        connector,
        beginMeasurands,
        "Transaction.Begin",
        { intervalStream: "txEnded-sampled" },
      );
      if (sampledValue.length > 0) {
        patchTransaction(this._chargePoint, connectorId, transaction, {
          txEndedSamples: [
            ...(transaction.txEndedSamples ?? []),
            { timestamp: transaction.startTime.toISOString(), sampledValue },
          ],
        });
      }
    }
    this._delivery.sendRequest(
      OCPPAction.StartTransaction,
      messageId,
      payload,
      connectorId,
    );
  }

  private sendStopTransaction(
    transaction: Transaction,
    connectorId: number,
    endPoint?: OperatingPoint,
  ): void {
    const messageId = this.generateMessageId();
    // §4.10: reason MAY be omitted when "Local" (the default), but SHOULD
    // be set to a correct value otherwise. The domain layer assigns
    // transaction.stopReason in non-default stop paths (Remote / Reset /
    // EVDisconnected / UnlockCommand / DeAuthorized / …).
    const reason = transaction.stopReason;
    const transactionData = this.signedTransactionData(
      transaction,
      connectorId,
      endPoint,
    );
    const payload: StopTransactionRequestV16 = {
      transactionId: this._delivery.wireTransactionId(transaction),
      idTag: transaction.tagId,
      meterStop: transaction.meterStop!,
      timestamp: transaction.stopTime!.toISOString(),
      ...(reason && reason !== "Local" ? { reason } : {}),
      ...(transactionData ? { transactionData } : {}),
    };
    this._delivery.sendRequest(
      OCPPAction.StopTransaction,
      messageId,
      payload,
      connectorId,
      undefined,
      undefined,
      false,
      {
        connectorId: transaction.connectorId,
        idTag: transaction.tagId,
        startedAt: transaction.startTime.toISOString(),
      },
    );
  }

  /**
   * #315: StopTransaction.transactionData carrying the signed begin reading
   * (signed when the transaction started) and a freshly signed end reading,
   * each as a `format: "SignedData"` sample. A stored begin reading is sent
   * even if signing was turned off since; `undefined` when there is neither.
   */
  private signedTransactionData(
    transaction: Transaction,
    connectorId: number,
    endPoint?: OperatingPoint,
  ): StopTransactionRequestV16["transactionData"] {
    if (transaction.meterStop === null || transaction.stopTime === null)
      return undefined;
    const end = signReading(this._chargePoint, connectorId, transaction.tagId, {
      reason: "E",
      energyWh: transaction.meterStop,
      at: transaction.stopTime,
    });
    // #607: the history (begin sample, periodic and clock-aligned ones) and
    // the Transaction.End sample of StopTxnSampledData, formatted from the
    // point captured at the stop instant (1.6 §3.16.1, §3.16.2).
    // The same wire spelling as MeterValues (#846): a Temperature sample
    // says `Celcius` here too (1.6 errata 2025-04 §2.1).
    const history = (transaction.txEndedSamples ?? []).map((entry) => ({
      ...entry,
      sampledValue: toOcppJ16Wire(entry.sampledValue),
    }));
    const endMeasurands = this._chargePoint.configuration.stopTxnSampledData();
    const connector = this._chargePoint.getConnector(connectorId);
    const endSample =
      connector && endMeasurands.length > 0
        ? toOcppJ16Wire(
            buildSampledValues(
              connector,
              endMeasurands,
              "Transaction.End",
              { intervalStream: "txEnded-sampled" },
              endPoint,
            ),
          )
        : [];
    if (
      !end &&
      !transaction.signedBeginOcmf &&
      history.length === 0 &&
      endSample.length === 0
    )
      return undefined;
    const data = [
      ...(transaction.signedBeginOcmf
        ? [
            {
              timestamp: transaction.startTime.toISOString(),
              sampledValue: [
                toOcpp16SampledValue(
                  transaction.signedBeginOcmf,
                  "Transaction.Begin",
                ),
              ],
            },
          ]
        : []),
      ...history,
      ...(endSample.length > 0
        ? [
            {
              timestamp: transaction.stopTime.toISOString(),
              sampledValue: endSample,
            },
          ]
        : []),
      ...(end
        ? [
            {
              timestamp: transaction.stopTime.toISOString(),
              sampledValue: [toOcpp16SampledValue(end.ocmf, "Transaction.End")],
            },
          ]
        : []),
    ];
    // Same strict-unit-union cast as sendMeterValue below.
    return data as unknown as StopTransactionRequestV16["transactionData"];
  }

  public sendTransactionEvent(event: TransactionLifecycleEvent): void {
    if (event.phase === "started")
      this.sendStartTransaction(event.transaction, event.connectorId);
    else
      this.sendStopTransaction(
        event.transaction,
        event.connectorId,
        event.endPoint,
      );
  }

  /**
   * §4.7 MeterValues.req. The measurand list is driven by the
   * `MeterValuesSampledData` Configuration key (defaults to
   * `Energy.Active.Import.Register`). Synthesized values are produced by
   * `MeterValueBuilder` so CSMS sees Voltage / Current / Power / SoC etc.
   * alongside the energy register.
   */
  public sendMeterValue(
    transactionId: number | undefined,
    connectorId: number,
    context: ReadingContext = "Sample.Periodic",
    overrides: MeterSampleOverrides = {},
  ): void {
    const messageId = this.generateMessageId();
    // Connector 0 is the station main meter, when the station has one (#617).
    const mainMeter =
      connectorId === 0 ? this._chargePoint.mainMeter : undefined;
    const connector = mainMeter
      ? undefined
      : this._chargePoint.getConnector(connectorId);
    if (!connector && !mainMeter) {
      this._logger.warn(
        `sendMeterValue: connector ${connectorId} not found`,
        LogType.METER_VALUE,
      );
      return;
    }

    const measurands =
      overrides.measurands ??
      this._chargePoint.configuration.meterValuesSampledData();
    const sampledValue = toOcppJ16Wire(
      mainMeter
        ? mainMeter.sampledValues(measurands, context)
        : buildSampledValues(connector!, measurands, context),
    );
    if (mainMeter && sampledValue.length === 0) return;
    // The sender is the tick owner: announce a schedule crossing after the
    // read, so this sample describes the state before the status flip (#327).
    connector?.announceScheduleCrossingNow();
    const timestamp = overrides.timestamp ?? new Date(this.clock.now());
    // #315: during a transaction, also send the energy register signed.
    // Clock-aligned samples are not signed (no aligned/fiscal records yet).
    const transaction = connector?.transaction;
    if (
      connector &&
      context !== "Sample.Clock" &&
      transactionId !== undefined &&
      transaction &&
      !transaction.stopTime
    ) {
      const signed = signReading(
        this._chargePoint,
        connectorId,
        transaction.tagId,
        {
          reason: "C",
          energyWh: connector.meterValue,
          at: timestamp,
        },
      );
      if (signed) sampledValue.push(toOcpp16SampledValue(signed.ocmf, context));
    }

    const payload: MeterValuesRequestV16 = {
      transactionId:
        transactionId !== undefined && transaction?.id === transactionId
          ? this._delivery.wireTransactionId(transaction)
          : transactionId,
      connectorId,
      meterValue: [
        {
          timestamp: timestamp.toISOString(),
          // The builder produces a structurally-compatible SampledValue
          // shape, but its `unit` is a plain `string` whereas ts-ocpp's
          // generated type is a strict union. Cast at this boundary
          // rather than mirror the entire enum.
          sampledValue:
            sampledValue as unknown as MeterValuesRequestV16["meterValue"][0]["sampledValue"],
        },
      ],
    };
    this._delivery.sendRequest(
      OCPPAction.MeterValues,
      messageId,
      payload,
      undefined,
      undefined,
      undefined,
      false,
      transactionId !== undefined && transaction
        ? {
            connectorId: transaction.connectorId,
            idTag: transaction.tagId,
            startedAt: transaction.startTime.toISOString(),
          }
        : undefined,
    );
  }

  /** The charge point's clock (the platform clock for a stand-in without one). */
  private get clock(): SimClock {
    return clockOf(this._chargePoint);
  }

  private generateMessageId(): string {
    return this._generateMessageId();
  }
}
