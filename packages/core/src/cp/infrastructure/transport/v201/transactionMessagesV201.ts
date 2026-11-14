import type {
  AuthorizeRequestV201,
  MeterValuesRequestV201,
  TransactionEventRequestV201,
  TransactionEventResponseV201,
} from "@ocpp-cp-simulator/ocpp/index";
import type { Logger } from "../../../shared/Logger";
import { LogType } from "../../../shared/Logger";
import {
  DEFAULT_ID_TOKEN_TYPE,
  ID_TOKEN_TYPE_VALUES_V21_ONLY,
  endedStoppedReason,
  endedTriggerReason,
  type IdTokenTypeName,
  type Transaction,
  type TransactionChargingState,
  type TransactionUpdateOptions,
} from "../../../domain/connector/Transaction";
import {
  buildSampledValues,
  unitOfMeasurandV2x,
  type MeterSampleOverrides,
  type ReadingContext,
  type SampledValue,
} from "../../../domain/connector/MeterValueBuilder";
import {
  signReading,
  toOcpp2SignedMeterValue,
  type OcmfReading,
} from "../../../domain/connector/SignedMeterData";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { clockOf } from "../../../shared/clock";
import type { SimClock } from "../../../shared/clock";
import type { Rng } from "../../../shared/rng";
import type { OperatingPoint } from "../../../domain/connector/OperatingPoint";
import type { TransactionLifecycleEvent } from "../../../domain/transport/TransactionLifecycleEvent";
import { OCPP_2_1 } from "../../../domain/types/OcppVersion";
import { patchTransaction } from "../handlers/patchTransaction";
import { v201MeterEvseId, v201TransactionEvse } from "./topologyWireV201";
import { recordIdTokenInfo } from "./authorizationCacheV201";
import { measurandEnumFor } from "./measurandEnum";
import type { V201Action, V201RequestPayload } from "./inboundRegistryV201";

type V201MeterValuesSampledValue =
  MeterValuesRequestV201["meterValue"][number]["sampledValue"][number];

/** What the transaction and MeterValues messages need from the handler. */
export interface TransactionMessagesContext {
  readonly chargePoint: Pick<
    ChargePoint,
    | "clock"
    | "configuration"
    | "connectors"
    | "getConnector"
    | "holdEnergyOnInvalidId"
    | "mainMeter"
    | "notifyStartTransactionNotAccepted"
    | "ocppVersion"
    | "recordAuthorizationResult"
    | "recordTxEndedSample"
    | "signedMeterFor"
    | "stopTransaction"
  >;
  readonly logger: Logger;
  rng(name: string): Rng;
  generateMessageId(): string;
  send(
    action: V201Action,
    messageId: string,
    payload: V201RequestPayload,
  ): void;
  /** Start the E13 delivery of a TransactionEvent (#490). */
  sendTransactionEventCall(
    connectorId: number,
    payload: TransactionEventRequestV201,
  ): void;
}

/**
 * The 2.x transaction messages (TransactionEvent Started / Updated / Ended),
 * their sampled values and signed energy, MeterValues, and what a
 * TransactionEventResponse's idTokenInfo does to the transaction (#877).
 */
export class TransactionMessagesV201 {
  private readonly _chargePoint: TransactionMessagesContext["chargePoint"];
  private readonly _logger: Logger;

  constructor(private readonly ctx: TransactionMessagesContext) {
    this._chargePoint = ctx.chargePoint;
    this._logger = ctx.logger;
  }

  /** The charge point's clock (the platform clock for a stand-in without one). */
  private get clock(): SimClock {
    return clockOf(this._chargePoint);
  }

  private rng(name: string): Rng {
    return this.ctx.rng(name);
  }

  private generateMessageId(): string {
    return this.ctx.generateMessageId();
  }

  private send(
    action: V201Action,
    messageId: string,
    payload: V201RequestPayload,
  ): void {
    this.ctx.send(action, messageId, payload);
  }

  private sendTransactionEventCall(
    connectorId: number,
    payload: TransactionEventRequestV201,
  ): void {
    this.ctx.sendTransactionEventCall(connectorId, payload);
  }

  /**
   * #447: the 2.x twin of 1.6's non-Accepted StartTransaction.conf (#181).
   * TransactionEvent.conf carries the CSMS's verdict on the event's idToken
   * in `idTokenInfo`. When it is not Accepted and the transaction is still
   * running, `TxCtrlr/StopTxOnInvalidId` (default true) ends it as
   * Deauthorized / DeAuthorized; false keeps it open but stops the energy
   * delivery (SuspendedEVSE, after `MaxEnergyOnInvalidId` Wh when set;
   * E05.FR.02/03). Either way the rejection is reported like the 1.6 one.
   */
  public applyTransactionEventResult(
    request: TransactionEventRequestV201,
    response: TransactionEventResponseV201,
  ): void {
    recordIdTokenInfo(this._chargePoint, request.idToken, response.idTokenInfo);
    const status = response.idTokenInfo?.status;
    if (status === undefined || status === "Accepted") return;
    if (request.eventType === "Ended") return;
    const transactionId = request.transactionInfo.transactionId;
    const connector = [...this._chargePoint.connectors.values()].find(
      (c) =>
        c.transaction?.cpTransactionId === transactionId &&
        c.transaction.stopTime === null,
    );
    if (!connector) return;
    const stopOnInvalid =
      this._chargePoint.configuration.stopTransactionOnInvalidId();
    this._logger.warn(
      `[v2.0.1] TransactionEvent idTokenInfo ${status} for transaction ${transactionId}; StopTxOnInvalidId=${stopOnInvalid}`,
      LogType.TRANSACTION,
    );
    this.patchTx(connector.id, connector.transaction!, {
      authorizationStatus: status,
      authorizationRejectedMidSession: request.eventType !== "Started",
    });
    if (stopOnInvalid) {
      this._chargePoint.stopTransaction(connector, "DeAuthorized", {
        triggerReason: "Deauthorized",
        stoppedReason: "DeAuthorized",
      });
    } else {
      // E05.FR.02/03, C15.FR.06: the transaction stays, the energy stops.
      this._chargePoint.holdEnergyOnInvalidId(connector);
    }
    this._chargePoint.notifyStartTransactionNotAccepted(
      connector.id,
      status,
      stopOnInvalid,
      request.eventType !== "Started",
    );
  }

  /**
   * The `IdToken` of the wire: `NoAuthorization` carries an empty `idToken`
   * ("IdToken field SHALL be left empty", IdTokenEnumType); a 2.1-only type
   * on a 2.0.1 station, where the schema would refuse it, falls back to the
   * default type with a warning (#599).
   */
  public wireIdToken(
    tagId: string,
    type: IdTokenTypeName = DEFAULT_ID_TOKEN_TYPE,
  ): AuthorizeRequestV201["idToken"] {
    let effective = type;
    if (
      this._chargePoint.ocppVersion !== OCPP_2_1 &&
      (ID_TOKEN_TYPE_VALUES_V21_ONLY as readonly string[]).includes(type)
    ) {
      this._logger.warn(
        `[v2.0.1] IdToken type ${type} exists on OCPP 2.1 only; sending ${DEFAULT_ID_TOKEN_TYPE}`,
        LogType.OCPP,
      );
      effective = DEFAULT_ID_TOKEN_TYPE;
    }
    return {
      idToken: effective === "NoAuthorization" ? "" : tagId,
      // The generated 2.0.1 type lists IdTokenEnumType only; on 2.1 the field
      // is a free string.
      type: effective as AuthorizeRequestV201["idToken"]["type"],
    };
  }

  private patchTx(
    connectorId: number,
    transaction: Transaction,
    fields: Partial<Record<keyof Transaction, unknown>>,
  ): void {
    patchTransaction(this._chargePoint, connectorId, transaction, fields);
  }

  private sendStartTransaction(
    transaction: Transaction,
    connectorId: number,
  ): void {
    if (!transaction.cpTransactionId) {
      this.patchTx(connectorId, transaction, {
        cpTransactionId: this.rng("transaction-id").uuid(),
      });
    }
    const transactionId = transaction.cpTransactionId as string;
    const seqNo = transaction.cpNextSeqNo ?? 0;
    this.patchTx(connectorId, transaction, { cpNextSeqNo: seqNo + 1 });
    // #335: a driven start may name the state the transaction opens in
    // (e.g. `EVConnected` for a cable-first session); `Charging` is the
    // historical default and stays so for every existing caller.
    const chargingState = transaction.startChargingState ?? "Charging";
    this.patchTx(connectorId, transaction, {
      cpLastTransactionEventChargingState: chargingState,
    });
    // E06.FR.11 / SampledDataCtrlr.TxEndedInterval: the Ended event carries the
    // values taken at the start as well as at the end, so the start reading of
    // TxEndedMeasurands joins the history (the 1.6 Transaction.Begin entry).
    const startConnector = this._chargePoint.getConnector(connectorId);
    const historyMeasurands =
      this._chargePoint.configuration.stopTxnSampledData();
    if (startConnector && historyMeasurands.length > 0) {
      this._chargePoint.recordTxEndedSample(
        startConnector,
        historyMeasurands,
        "Transaction.Begin",
        transaction.startTime,
      );
    }
    const payload: TransactionEventRequestV201 = {
      eventType: "Started",
      timestamp: transaction.startTime.toISOString(),
      triggerReason: transaction.startTriggerReason ?? "Authorized",
      seqNo,
      transactionInfo: {
        transactionId,
        chargingState,
        ...(transaction.remoteStartId !== undefined
          ? { remoteStartId: transaction.remoteStartId }
          : {}),
      },
      ...(transaction.reservationId !== undefined
        ? { reservationId: transaction.reservationId }
        : {}),
      // #697: a transaction the cable started has no idToken yet.
      ...(transaction.awaitingAuthorization
        ? {}
        : {
            idToken: this.wireIdToken(
              transaction.tagId,
              transaction.idTokenType,
            ),
          }),
      evse: v201TransactionEvse(connectorId),
      meterValue: [
        {
          timestamp: transaction.startTime.toISOString(),
          sampledValue: this.withSignedEnergy(
            [
              {
                value: transaction.meterStart / 1000,
                measurand: "Energy.Active.Import.Register",
                // #347: the boundary says which one it is, signed or not.
                context: "Transaction.Begin",
                unitOfMeasure: { unit: "kWh" },
              },
              // #607: SampledDataCtrlr.TxStartedMeasurands, beside the register.
              ...this.txBoundarySamples(
                connectorId,
                this._chargePoint.configuration.txStartedMeasurands(),
                "Transaction.Begin",
              ),
            ],
            connectorId,
            transaction.tagId,
            {
              reason: "B",
              energyWh: transaction.meterStart,
              at: transaction.startTime,
            },
            "Transaction.Begin",
          ),
        },
      ],
    };
    this.sendTransactionEventCall(connectorId, payload);
  }

  public sendChargingStateChanged(
    connectorId: number,
    chargingState: TransactionChargingState,
  ): void {
    const connector = this._chargePoint.getConnector(connectorId);
    const transaction = connector?.transaction;
    if (!transaction || transaction.stopTime !== null) return;

    const lastChargingState =
      transaction.cpLastTransactionEventChargingState ?? "Charging";
    if (lastChargingState === chargingState) {
      this.patchTx(connectorId, transaction, {
        cpLastTransactionEventChargingState: lastChargingState,
      });
      return;
    }

    if (!transaction.cpTransactionId) {
      this.patchTx(connectorId, transaction, {
        cpTransactionId: this.rng("transaction-id").uuid(),
      });
    }
    const seqNo = transaction.cpNextSeqNo ?? 0;
    this.patchTx(connectorId, transaction, {
      cpNextSeqNo: seqNo + 1,
      cpLastTransactionEventChargingState: chargingState,
    });
    connector.markTransactionChanged();
    const payload: TransactionEventRequestV201 = {
      eventType: "Updated",
      timestamp: new Date(this.clock.now()).toISOString(),
      triggerReason: "ChargingStateChanged",
      seqNo,
      transactionInfo: {
        transactionId: transaction.cpTransactionId as string,
        chargingState,
      },
      ...(transaction.reservationId !== undefined
        ? { reservationId: transaction.reservationId }
        : {}),
      evse: v201TransactionEvse(connectorId),
    };
    this.sendTransactionEventCall(connectorId, payload);
  }

  /**
   * #607: the configured measurands of a transaction boundary, formatted by
   * the one builder. `point` is the operating point captured at the stop
   * instant (Transaction.End); the register is left out because the caller
   * sends it, in kWh, beside these.
   */
  private txBoundarySamples(
    connectorId: number,
    measurands: string[],
    context: "Transaction.Begin" | "Transaction.End",
    point?: OperatingPoint,
  ): V201MeterValuesSampledValue[] {
    const connector = this._chargePoint.getConnector(connectorId);
    if (!connector || measurands.length === 0) return [];
    // #714: the same MeasurandEnumType filter as every other 2.x sample.
    return this.toV201SampledValues(
      this.buildSamples(
        connector,
        measurands,
        context,
        undefined,
        point,
        // The Begin / End readings of the history are one Interval stream.
        "txEnded-sampled",
      ).filter(
        (sv) =>
          !(
            sv.measurand === "Energy.Active.Import.Register" &&
            sv.phase === undefined
          ),
      ),
    );
  }

  private sendStopTransaction(
    transaction: Transaction,
    connectorId: number,
    endPoint?: OperatingPoint,
  ): void {
    const transactionId =
      transaction.cpTransactionId ?? this.rng("transaction-id").uuid();
    const timestamp = (
      transaction.stopTime ?? new Date(this.clock.now())
    ).toISOString();
    const seqNo = transaction.cpNextSeqNo ?? 0;
    this.patchTx(connectorId, transaction, { cpNextSeqNo: seqNo + 1 });
    const payload: TransactionEventRequestV201 = {
      eventType: "Ended",
      timestamp,
      triggerReason: endedTriggerReason(transaction),
      seqNo,
      transactionInfo: {
        transactionId,
        // #335: an explicitly named 2.0.1 reason is sent verbatim; only an
        // unnamed one is derived from the 1.6-shaped `stopReason`.
        stoppedReason: endedStoppedReason(transaction),
      },
      ...(transaction.reservationId !== undefined
        ? { reservationId: transaction.reservationId }
        : {}),
      ...(transaction.tagId
        ? {
            idToken: this.wireIdToken(
              transaction.tagId,
              transaction.idTokenType,
            ),
          }
        : {}),
      evse: v201TransactionEvse(connectorId),
      meterValue:
        transaction.meterStop !== null
          ? ([
              // #607: the history, then the end reading.
              ...(transaction.txEndedSamples ?? []).map((entry) => ({
                timestamp: entry.timestamp,
                sampledValue: this.toV201SampledValues(entry.sampledValue) as [
                  V201MeterValuesSampledValue,
                  ...V201MeterValuesSampledValue[],
                ],
              })),
              {
                timestamp,
                sampledValue: this.withSignedEnergy(
                  [
                    {
                      value: transaction.meterStop / 1000,
                      measurand: "Energy.Active.Import.Register",
                      context: "Transaction.End",
                      unitOfMeasure: { unit: "kWh" },
                    },
                    ...this.txBoundarySamples(
                      connectorId,
                      this._chargePoint.configuration.stopTxnSampledData(),
                      "Transaction.End",
                      endPoint,
                    ),
                  ],
                  connectorId,
                  transaction.tagId,
                  {
                    reason: "E",
                    energyWh: transaction.meterStop,
                    at: transaction.stopTime ?? new Date(timestamp),
                  },
                  "Transaction.End",
                ),
              },
            ] as unknown as TransactionEventRequestV201["meterValue"])
          : undefined,
    };
    this.sendTransactionEventCall(connectorId, payload);
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
   * A driven TransactionEvent(Updated) (#335): the caller names the
   * `triggerReason` and optionally the `chargingState`; `meterValues: true`
   * attaches the connector's current sampled values, which is how 2.0.1
   * carries in-transaction metering (`MeterValuePeriodic` / `MeterValueClock`).
   * Shares the per-transaction seqNo with the status-driven events, and a
   * named `chargingState` becomes the value those events de-duplicate
   * against, so a later StatusNotification to the same state stays silent.
   */
  public sendTransactionUpdate(
    connectorId: number,
    options: TransactionUpdateOptions,
  ): void {
    const connector = this._chargePoint.getConnector(connectorId);
    const transaction = connector?.transaction;
    if (!connector || !transaction || transaction.stopTime !== null) {
      this._logger.warn(
        `[v2.0.1] transaction_event (${options.triggerReason}): no active transaction on connector ${connectorId}`,
        LogType.TRANSACTION,
      );
      return;
    }
    if (!transaction.cpTransactionId) {
      this.patchTx(connectorId, transaction, {
        cpTransactionId: this.rng("transaction-id").uuid(),
      });
    }
    const timestamp = (
      options.timestamp ?? new Date(this.clock.now())
    ).toISOString();

    let meterValue: TransactionEventRequestV201["meterValue"];
    if (options.meterValues) {
      const measurands =
        options.measurands ??
        this._chargePoint.configuration.meterValuesSampledData();
      const context = options.context ?? "Sample.Periodic";
      const built = this.buildSamples(connector, measurands, context);
      // The sender is the tick owner: announce a schedule crossing after the
      // read, so this sample describes the state before the status flip (#327).
      connector.announceScheduleCrossingNow();
      const sampledValue = this.withSignedEnergy(
        this.toV201SampledValues(built),
        connectorId,
        transaction.tagId,
        {
          reason: "C",
          energyWh: connector.meterValue,
          at: new Date(timestamp),
        },
        context,
      );
      if (sampledValue.length > 0) {
        meterValue = [
          {
            timestamp,
            sampledValue: sampledValue as [
              V201MeterValuesSampledValue,
              ...V201MeterValuesSampledValue[],
            ],
          },
        ];
      } else if (options.skipWithoutMeterValue) {
        // #347: before the seqNo is taken, so a skipped sample leaves no gap.
        this._logger.debug(
          `[v2.0.1] transaction_event: no sampled values for connector ${connectorId}; nothing sent`,
          LogType.METER_VALUE,
        );
        return;
      } else {
        this._logger.debug(
          `[v2.0.1] transaction_event: no sampled values for connector ${connectorId}; sending without meterValue`,
          LogType.METER_VALUE,
        );
      }
    }

    const seqNo = transaction.cpNextSeqNo ?? 0;
    this.patchTx(connectorId, transaction, {
      cpNextSeqNo: seqNo + 1,
      ...(options.chargingState
        ? { cpLastTransactionEventChargingState: options.chargingState }
        : {}),
    });
    connector.markTransactionChanged();

    const payload: TransactionEventRequestV201 = {
      eventType: "Updated",
      timestamp,
      triggerReason: options.triggerReason,
      seqNo,
      transactionInfo: {
        transactionId: transaction.cpTransactionId as string,
        ...(options.chargingState
          ? { chargingState: options.chargingState }
          : {}),
        ...(options.remoteStartId !== undefined
          ? { remoteStartId: options.remoteStartId }
          : {}),
      },
      ...(transaction.reservationId !== undefined
        ? { reservationId: transaction.reservationId }
        : {}),
      ...(options.idToken
        ? {
            idToken: this.wireIdToken(
              options.idToken.tagId,
              options.idToken.type,
            ),
          }
        : {}),
      evse: v201TransactionEvse(connectorId),
      ...(meterValue ? { meterValue } : {}),
    };
    this.sendTransactionEventCall(connectorId, payload);
  }

  /**
   * #315: while `SampledDataSignReadings` is on, sign `reading` and attach it
   * as `signedMeterValue` to the energy register sample (adding one, with
   * `context`, if the measurand list has none). Unchanged when signing is off.
   */
  private withSignedEnergy(
    sampledValue: V201MeterValuesSampledValue[],
    connectorId: number,
    idTag: string,
    reading: OcmfReading,
    context?: ReadingContext,
  ): [V201MeterValuesSampledValue, ...V201MeterValuesSampledValue[]] {
    const list = sampledValue as [
      V201MeterValuesSampledValue,
      ...V201MeterValuesSampledValue[],
    ];
    // Clock-aligned samples are not signed (no aligned/fiscal records yet).
    if (context === "Sample.Clock") return list;
    const signed = signReading(this._chargePoint, connectorId, idTag, reading);
    if (!signed) return list;
    const withContext = context
      ? { context: context as V201MeterValuesSampledValue["context"] }
      : {};
    const signedMeterValue = toOcpp2SignedMeterValue(signed);
    const energy = list.findIndex(
      (sv) =>
        (sv.measurand ?? "Energy.Active.Import.Register") ===
          "Energy.Active.Import.Register" && !sv.phase,
    );
    if (energy >= 0) {
      return list.map((sv, i) =>
        i === energy ? { ...sv, ...withContext, signedMeterValue } : sv,
      ) as typeof list;
    }
    return [
      ...list,
      {
        value: reading.energyWh / 1000,
        measurand: "Energy.Active.Import.Register",
        unitOfMeasure: { unit: "kWh" },
        ...withContext,
        signedMeterValue,
      },
    ];
  }

  /**
   * The builder's samples for `measurands`, minus those outside the station's
   * `MeasurandEnumType` (#714): `Temperature` and `RPM` are 1.6 measurands, and
   * a list loaded from a persisted configuration or set by a scenario may still
   * name them. A schema-invalid sample is never put on the wire.
   */
  private buildSamples(
    connector: Parameters<typeof buildSampledValues>[0] | undefined,
    measurands: string[],
    context: ReadingContext,
    mainMeter?: NonNullable<ChargePoint["mainMeter"]>,
    point?: OperatingPoint,
    intervalStream?: string,
  ): SampledValue[] {
    const allowed = measurandEnumFor(this._chargePoint.ocppVersion);
    const kept = measurands.filter((m) => allowed.has(m));
    if (kept.length < measurands.length) {
      this._logger.warn(
        `[v2.0.1] Not sending measurands outside MeasurandEnumType: ${measurands
          .filter((m) => !allowed.has(m))
          .join(", ")}`,
        LogType.METER_VALUE,
      );
    }
    // 2.x carries the unit multiplier (SampledValueType.unitOfMeasure).
    const options = {
      unitMultiplier: true,
      ...(intervalStream === undefined ? {} : { intervalStream }),
    };
    return mainMeter
      ? mainMeter.sampledValues(kept, context, options)
      : buildSampledValues(connector!, kept, context, options, point);
  }

  /** 1.6-shaped builder output → 2.0.1 SampledValueType. `context` is
   *  carried through since #335; it used to be computed and dropped. */
  private toV201SampledValues(
    sampledValues: SampledValue[],
  ): V201MeterValuesSampledValue[] {
    return sampledValues.map((sv) => {
      // #713: the unit of the measurand (Part 2 Appendices ch. 2) when the
      // builder left it out; "Wh" is the default a CSMS assumes without one.
      const unit =
        sv.unit ??
        (sv.measurand ? unitOfMeasurandV2x(sv.measurand) : undefined);
      return {
        value: Number(sv.value),
        measurand: sv.measurand as V201MeterValuesSampledValue["measurand"],
        unitOfMeasure:
          unit || sv.multiplier !== undefined
            ? {
                ...(unit ? { unit } : {}),
                ...(sv.multiplier !== undefined
                  ? { multiplier: sv.multiplier }
                  : {}),
              }
            : undefined,
        ...(sv.context
          ? { context: sv.context as V201MeterValuesSampledValue["context"] }
          : {}),
        // 2.0.1/2.1 SampledValueType carries `phase` (§2.36 / §2.44) — pass the
        // builder's L1/L2/L3 tag through rather than letting a CSMS receive
        // four indistinguishable samples per measurand (#301).
        ...(sv.phase
          ? { phase: sv.phase as V201MeterValuesSampledValue["phase"] }
          : {}),
        // `location` was computed and dropped before the overrides of #616 (and
        // the main meter's Inlet, #617) could set it.
        ...(sv.location
          ? {
              location: sv.location as V201MeterValuesSampledValue["location"],
            }
          : {}),
      };
    });
  }

  public sendMeterValue(
    _transactionId: number | undefined,
    connectorId: number,
    context: ReadingContext = "Sample.Periodic",
    overrides: MeterSampleOverrides = {},
  ): void {
    const messageId = this.generateMessageId();
    // EVSE 0 is the station main meter, when the station has one (#617).
    const mainMeter =
      connectorId === 0 ? this._chargePoint.mainMeter : undefined;
    const connector = mainMeter
      ? undefined
      : this._chargePoint.getConnector(connectorId);
    if (!connector && !mainMeter) {
      this._logger.warn(
        `[v2.0.1] sendMeterValue: connector ${connectorId} not found`,
        LogType.METER_VALUE,
      );
      return;
    }

    const measurands =
      overrides.measurands ??
      this._chargePoint.configuration.meterValuesSampledData();
    const sampledValues = this.buildSamples(
      connector,
      measurands,
      context,
      mainMeter,
    );
    // The sender is the tick owner: announce a schedule crossing after the
    // read, so this sample describes the state before the status flip (#327).
    connector?.announceScheduleCrossingNow();
    const timestamp = overrides.timestamp ?? new Date(this.clock.now());
    let sampledValue = this.toV201SampledValues(sampledValues) as [
      V201MeterValuesSampledValue,
      ...V201MeterValuesSampledValue[],
    ];
    // #315: during a transaction, sign the energy register too. Done before
    // the empty check, so an empty measurand list still sends the signed one.
    const transaction = connector?.transaction;
    if (transaction && !transaction.stopTime) {
      sampledValue = this.withSignedEnergy(
        sampledValue,
        connectorId,
        transaction.tagId,
        { reason: "C", energyWh: connector.meterValue, at: timestamp },
        context,
      );
    }
    if (sampledValue.length === 0) {
      this._logger.debug(
        `[v2.0.1] sendMeterValue: no sampled values for connector ${connectorId}`,
        LogType.METER_VALUE,
      );
      return;
    }

    const payload: MeterValuesRequestV201 = {
      evseId: v201MeterEvseId(connectorId),
      meterValue: [
        {
          timestamp: timestamp.toISOString(),
          sampledValue,
        },
      ],
    };
    this.send("MeterValues", messageId, payload);
  }
}
