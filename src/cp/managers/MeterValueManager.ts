import { Logger } from "../Logger";

/**
 * Configuration for automatic meter value updates
 */
export interface AutoMeterValueConfig {
  intervalSeconds: number;
  incrementValue: number;
}

/**
 * Manages automatic meter value updates for connectors
 */
export class MeterValueManager {
  private _logger: Logger;
  private _autoMeterValueIntervals: Map<number, number> = new Map();
  private _getMeterValueCallback:
    | ((connectorId: number) => number)
    | null = null;
  private _setMeterValueCallback:
    | ((connectorId: number, value: number) => void)
    | null = null;
  private _sendMeterValueCallback:
    | ((connectorId: number) => void)
    | null = null;

  constructor(logger: Logger) {
    this._logger = logger;
  }

  /**
   * Set callback to get current meter value for a connector
   */
  setGetMeterValueCallback(callback: (connectorId: number) => number): void {
    this._getMeterValueCallback = callback;
  }

  /**
   * Set callback to update meter value for a connector
   */
  setSetMeterValueCallback(
    callback: (connectorId: number, value: number) => void,
  ): void {
    this._setMeterValueCallback = callback;
  }

  /**
   * Set callback to send meter value to central system
   */
  setSendMeterValueCallback(callback: (connectorId: number) => void): void {
    this._sendMeterValueCallback = callback;
  }

  /**
   * Start automatic meter value updates for a connector
   */
  startAutoMeterValue(
    connectorId: number,
    config: AutoMeterValueConfig,
  ): void {
    // Stop existing interval if any
    this.stopAutoMeterValue(connectorId);

    if (!this._getMeterValueCallback || !this._setMeterValueCallback || !this._sendMeterValueCallback) {
      this._logger.error(
        "Meter value callbacks not set. Cannot start auto meter value.",
      );
      return;
    }

    this._logger.info(
      `Starting auto meter value for connector ${connectorId}: interval=${config.intervalSeconds}s, increment=${config.incrementValue}`,
    );

    const intervalId = setInterval(() => {
      const currentValue = this._getMeterValueCallback!(connectorId);
      const newValue = currentValue + config.incrementValue;
      this._setMeterValueCallback!(connectorId, newValue);
      this._sendMeterValueCallback!(connectorId);
    }, config.intervalSeconds * 1000);

    this._autoMeterValueIntervals.set(connectorId, intervalId);
  }

  /**
   * Stop automatic meter value updates for a connector
   */
  stopAutoMeterValue(connectorId: number): void {
    const intervalId = this._autoMeterValueIntervals.get(connectorId);
    if (intervalId) {
      this._logger.info(
        `Stopping auto meter value for connector ${connectorId}`,
      );
      clearInterval(intervalId);
      this._autoMeterValueIntervals.delete(connectorId);
    }
  }

  /**
   * Stop all automatic meter value updates
   */
  stopAll(): void {
    this._logger.info("Stopping all auto meter value intervals");
    this._autoMeterValueIntervals.forEach((intervalId) => {
      clearInterval(intervalId);
    });
    this._autoMeterValueIntervals.clear();
  }

  /**
   * Check if auto meter value is active for a connector
   */
  isActive(connectorId: number): boolean {
    return this._autoMeterValueIntervals.has(connectorId);
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.stopAll();
    this._getMeterValueCallback = null;
    this._setMeterValueCallback = null;
    this._sendMeterValueCallback = null;
  }
}
