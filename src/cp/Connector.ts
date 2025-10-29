import { OCPPStatus, OCPPAvailability } from "./OcppTypes";
import { Transaction } from "./Transaction";
import * as ocpp from "./OcppTypes.ts";
import { EventEmitter } from "./EventEmitter";
import {
  AutoMeterValueConfig,
  defaultAutoMeterValueConfig,
  getMeterValueAtTime,
} from "./types/MeterValueCurve";
import { ScenarioMode } from "./types/ScenarioTypes";

export interface ConnectorEvents {
  statusChange: { status: OCPPStatus; previousStatus: OCPPStatus };
  transactionIdChange: { transactionId: number | null };
  meterValueChange: { meterValue: number };
  availabilityChange: { availability: OCPPAvailability };
  autoMeterValueChange: { config: AutoMeterValueConfig };
  modeChange: { mode: ScenarioMode };
}

export class Connector {
  private _id: number;
  private _status: string;
  private _availability: OCPPAvailability;
  private _meterValue: number;
  private _transaction: Transaction | null;

  // Auto MeterValue properties
  private _autoMeterValueConfig: AutoMeterValueConfig;
  private _autoMeterValueTimer: NodeJS.Timeout | null = null;
  private _autoMeterValueStartTime: number | null = null;
  private _onMeterValueSend: ((connectorId: number) => void) | null = null;

  // Scenario mode
  private _mode: ScenarioMode = "manual";

  // EventEmitter for type-safe events
  private _events: EventEmitter<ConnectorEvents> = new EventEmitter();

  constructor(id: number) {
    this._id = id;
    this._status = OCPPStatus.Unavailable;
    this._availability = "Operative";
    this._meterValue = 0;
    this._transaction = null;
    this._autoMeterValueConfig = { ...defaultAutoMeterValueConfig };
  }

  /**
   * Get the event emitter for this connector
   */
  get events(): EventEmitter<ConnectorEvents> {
    return this._events;
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

  /**
   * Set connector status
   * @deprecated Prefer using ChargePoint.stateManager.transitionConnectorStatus() for better state management
   */
  set status(newStatus: ocpp.OCPPStatus) {
    const previousStatus = this._status as OCPPStatus;
    this._status = newStatus;

    // Emit event through EventEmitter
    this._events.emit("statusChange", {
      status: newStatus,
      previousStatus,
    });
  }

  get availability(): OCPPAvailability {
    return this._availability;
  }

  /**
   * Set connector availability
   * @deprecated Prefer using ChargePoint.stateManager for better state management
   */
  set availability(newAvailability: OCPPAvailability) {
    this._availability = newAvailability;

    // Emit event through EventEmitter
    this._events.emit("availabilityChange", {
      availability: newAvailability,
    });
  }

  get meterValue(): number {
    return this._meterValue;
  }

  set meterValue(value: number) {
    this._meterValue = value;

    // Emit event through EventEmitter
    this._events.emit("meterValueChange", {
      meterValue: value,
    });
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

      // Emit event through EventEmitter
      this._events.emit("transactionIdChange", {
        transactionId,
      });
    }
  }

  /**
   * Get the current mode (manual or scenario)
   */
  get mode(): ScenarioMode {
    return this._mode;
  }

  /**
   * Set the connector mode (manual or scenario)
   */
  set mode(newMode: ScenarioMode) {
    this._mode = newMode;

    // Emit event through EventEmitter
    this._events.emit("modeChange", {
      mode: newMode,
    });
  }

  /**
   * Get the auto MeterValue configuration
   */
  get autoMeterValueConfig(): AutoMeterValueConfig {
    return this._autoMeterValueConfig;
  }

  /**
   * Set the auto MeterValue configuration
   */
  set autoMeterValueConfig(config: AutoMeterValueConfig) {
    this._autoMeterValueConfig = config;

    // Emit event
    this._events.emit("autoMeterValueChange", { config });

    // If enabled, restart the auto MeterValue
    if (config.enabled && this._transaction) {
      this.stopAutoMeterValue();
      this.startAutoMeterValue();
    } else if (!config.enabled) {
      this.stopAutoMeterValue();
    }
  }

  /**
   * Set callback for MeterValue send
   */
  public setOnMeterValueSend(
    callback: (connectorId: number) => void
  ): void {
    this._onMeterValueSend = callback;
  }

  /**
   * Start automatic MeterValue sending
   */
  public startAutoMeterValue(): void {
    if (!this._autoMeterValueConfig.enabled) return;
    if (!this._transaction) return;

    // Stop any existing timer
    this.stopAutoMeterValue();

    // Record start time
    this._autoMeterValueStartTime = Date.now();

    // Calculate interval
    const intervalMs = this._autoMeterValueConfig.autoCalculateInterval
      ? this.calculateAutoInterval()
      : this._autoMeterValueConfig.intervalSeconds * 1000;

    // Start timer
    this._autoMeterValueTimer = setInterval(() => {
      this.sendAutoMeterValue();
    }, intervalMs);

    console.log(
      `Started auto MeterValue for connector ${this._id} with interval ${intervalMs}ms`
    );
  }

  /**
   * Stop automatic MeterValue sending
   */
  public stopAutoMeterValue(): void {
    if (this._autoMeterValueTimer) {
      clearInterval(this._autoMeterValueTimer);
      this._autoMeterValueTimer = null;
    }
    this._autoMeterValueStartTime = null;
  }

  /**
   * Send MeterValue based on current curve position
   */
  private sendAutoMeterValue(): void {
    if (!this._autoMeterValueStartTime || !this._transaction) return;

    const elapsedMs = Date.now() - this._autoMeterValueStartTime;
    const elapsedMinutes = elapsedMs / 1000 / 60;

    const newValue = getMeterValueAtTime(
      elapsedMinutes,
      this._autoMeterValueConfig
    );

    // Update meter value
    this.meterValue = Math.round(newValue * 1000); // Convert kWh to Wh

    // Call the send callback if set
    if (this._onMeterValueSend) {
      this._onMeterValueSend(this._id);
    }
  }

  /**
   * Calculate automatic interval based on curve duration
   */
  private calculateAutoInterval(): number {
    const points = this._autoMeterValueConfig.curvePoints;
    if (points.length < 2) return 10000; // Default 10 seconds

    const sortedPoints = [...points].sort((a, b) => a.time - b.time);
    const durationMinutes =
      sortedPoints[sortedPoints.length - 1].time - sortedPoints[0].time;

    // Send approximately every 1% of duration, min 5 seconds, max 60 seconds
    const intervalSeconds = Math.max(
      5,
      Math.min(60, (durationMinutes * 60) / 100)
    );

    return intervalSeconds * 1000;
  }

  /**
   * Clean up all event listeners
   */
  public cleanup(): void {
    this.stopAutoMeterValue();
    this._events.removeAllListeners();
  }
}
