import {OCPPStatus, OCPPAvailability} from "./OcppTypes";
import {Transaction} from "./Transaction";
import * as ocpp from "./OcppTypes.ts";

export class Connector {
  private _id: number;
  private _status: string;
  private _availability: OCPPAvailability;
  private _meterValue: number;
  private _transaction: Transaction | null;

  private _transactionIDChangeCallbacks:
    | ((transactionId: number | null) => void)[]
  private _statusChangeCallbacks: ((status: ocpp.OCPPStatus) => void)[];
  private _meterValueChangeCallbacks: ((meterValue: number) => void)[];

  constructor(id: number) {
    this._id = id;
    this._status = OCPPStatus.Available;
    this._availability = "Operative";
    this._meterValue = 0;
    this._transaction = null;

    this._transactionIDChangeCallbacks = [];
    this._statusChangeCallbacks = [];
    this._meterValueChangeCallbacks = [];
  }

  get id(): number {
    return this._id;
  }

  set id(newId: number) {
    this._id = newId;
  }

  get status(): string {
    return this._status;
  }

  set status(newStatus: ocpp.OCPPStatus) {
    this._status = newStatus;
    this._statusChangeCallbacks && this._statusChangeCallbacks.forEach((callback) => {
      callback(newStatus);
    })
  }

  get availability(): OCPPAvailability {
    return this._availability;
  }

  set availability(newAvailability: OCPPAvailability) {
    this._availability = newAvailability;
  }

  get meterValue(): number {
    return this._meterValue;
  }

  set meterValue(value: number) {
    this._meterValue = value;
    this._meterValueChangeCallbacks && this._meterValueChangeCallbacks.forEach((callback) => {
      callback(value);
    })
  }

  get transaction(): Transaction | null {
    return this._transaction;
  }

  set transaction(transaction: Transaction | null) {
    this._transaction = transaction;
  }

  set transactionId(transactionId: number | null) {
    if (this._transaction) {
      this._transaction.id = transactionId;
      this._transactionIDChangeCallbacks && this._transactionIDChangeCallbacks.forEach((callback) => {
        callback(transactionId);
      })

    }
  }


  public setTransactionIDChangeCallbacks(
    callback: (transactionId: number | null) => void
  ) {
    this._transactionIDChangeCallbacks.push(callback);
  }

  public setStatusChangeCallbacks(callback: (status: ocpp.OCPPStatus) => void) {
    this._statusChangeCallbacks.push(callback);
  }

  public setMeterValueChangeCallbacks(callback: (meterValue: number) => void) {
    this._meterValueChangeCallbacks.push(callback);
  }

}
