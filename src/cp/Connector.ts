import {OCPPStatus, OCPPAvailability} from './OcppTypes';
import {Transaction} from './Transaction';
import * as ocpp from "./OcppTypes.ts";

export class Connector {
  private _id: number;
  private _status: string;
  private _availability: OCPPAvailability;
  private _meterValue: number;
  private _transaction: Transaction | null;

  private _transactionIDChangeCallbacks: ((transactionId: number|null) => void) | null;
  private _statusChangeCallbacks: ((status: ocpp.OCPPStatus) => void) | null;

  constructor(id: number) {
    this._id = id;
    this._status = OCPPStatus.Available;
    this._availability = OCPPAvailability.Operative;
    this._meterValue = 0;
    this._transaction = null;

    this._transactionIDChangeCallbacks = null;
    this._statusChangeCallbacks = null;
  }

  get id(): number {
    return this._id;
  }

  set id(newId: number) {
    this._id = newId;
    this.triggerTransactionIDChangeCallback(newId);
  }

  get status(): string {
    return this._status;
  }

  set status(newStatus: ocpp.OCPPStatus) {
    this._status = newStatus;
    this.triggerStatusChangeCallback(newStatus);
  }

  get availability(): string {
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
  }

  get transaction(): Transaction | null {
    return this._transaction;
  }

  set transaction(transaction: Transaction | null) {
    this._transaction = transaction;
  }

  set transactionId(transactionId: number|null) {
    if (this._transaction) {
      this._transaction.id = transactionId;
      this.triggerTransactionIDChangeCallback(transactionId);
    }
  }

  public setTransactionIDChangeCallbacks(callback: (transactionId: number|null) => void) {
    this._transactionIDChangeCallbacks = callback;
  }

  public setStatusChangeCallbacks(callback: (status: ocpp.OCPPStatus) => void) {
    this._statusChangeCallbacks = callback;
  }

  public triggerTransactionIDChangeCallback(transactionId: number|null): void {
    if (this._transactionIDChangeCallbacks) {
      this._transactionIDChangeCallbacks(transactionId);
    }
  }

  public triggerStatusChangeCallback(status: ocpp.OCPPStatus): void {
    if (this._statusChangeCallbacks) {
      this._statusChangeCallbacks(status);
    }
  }
}
