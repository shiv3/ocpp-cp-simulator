export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export enum LogType {
  WEBSOCKET = "WebSocket",
  OCPP = "OCPP",
  TRANSACTION = "Transaction",
  HEARTBEAT = "Heartbeat",
  METER_VALUE = "MeterValue",
  STATUS = "Status",
  CONFIGURATION = "Configuration",
  DIAGNOSTICS = "Diagnostics",
  SCENARIO = "Scenario",
  GENERAL = "General",
}

export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  type: LogType;
  message: string;
}

export interface LogFilter {
  level?: LogLevel;
  types?: LogType[];
  startTime?: Date;
  endTime?: Date;
}

import EventEmitter2 from "eventemitter2";

export class Logger {
  private level: LogLevel;
  private logList: LogEntry[] = [];
  private enabledTypes: Set<LogType> = new Set(Object.values(LogType));
  private emitter: EventEmitter2;

  // Keep for backward compatibility
  public _loggingCallback: ((entry: LogEntry) => void) | null = null;

  set loggingCallback(callback: ((entry: LogEntry) => void) | null) {
    // Remove old callback
    if (this._loggingCallback) {
      this.emitter.off("log", this._loggingCallback);
    }

    this._loggingCallback = callback;

    // Register new callback
    if (callback) {
      this.emitter.on("log", callback);
    }
  }

  constructor(level: LogLevel = LogLevel.DEBUG) {
    this.level = level;
    this.emitter = new EventEmitter2({
      wildcard: true,
      delimiter: ".",
      maxListeners: 50,
    });
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * Enable specific log types
   */
  enableTypes(...types: LogType[]): void {
    types.forEach((type) => this.enabledTypes.add(type));
  }

  /**
   * Disable specific log types
   */
  disableTypes(...types: LogType[]): void {
    types.forEach((type) => this.enabledTypes.delete(type));
  }

  /**
   * Enable only specific log types (disable all others)
   */
  setEnabledTypes(...types: LogType[]): void {
    this.enabledTypes.clear();
    types.forEach((type) => this.enabledTypes.add(type));
  }

  /**
   * Check if a log type is enabled
   */
  isTypeEnabled(type: LogType): boolean {
    return this.enabledTypes.has(type);
  }

  debug(message: string, type: LogType = LogType.GENERAL): void {
    this.log(message, LogLevel.DEBUG, type);
  }

  info(message: string, type: LogType = LogType.GENERAL): void {
    this.log(message, LogLevel.INFO, type);
  }

  warn(message: string, type: LogType = LogType.GENERAL): void {
    this.log(message, LogLevel.WARN, type);
  }

  error(message: string, type: LogType = LogType.GENERAL): void {
    this.log(message, LogLevel.ERROR, type);
  }

  log(
    message: string,
    level: LogLevel = LogLevel.DEBUG,
    type: LogType = LogType.GENERAL,
  ): void {
    // Check if log level and type are enabled
    if (level < this.level || !this.enabledTypes.has(type)) {
      return;
    }

    const timestamp = new Date();
    const logEntry: LogEntry = {
      timestamp,
      level,
      type,
      message,
    };

    const formattedMessage = this.formatLogEntry(logEntry);

    // Console output based on level
    switch (level) {
      case LogLevel.DEBUG:
        console.debug(formattedMessage);
        break;
      case LogLevel.INFO:
        console.info(formattedMessage);
        break;
      case LogLevel.WARN:
        console.warn(formattedMessage);
        break;
      case LogLevel.ERROR:
        console.error(formattedMessage);
        break;
      default:
        console.log(formattedMessage);
        break;
    }

    this.logList.push(logEntry);

    // Emit event with EventEmitter2
    // Hierarchical event name: log.{LogType}.{LogLevel}
    const levelName = LogLevel[level];

    // Detailed event: log.OCPP.INFO
    this.emitter.emit(`log.${type}.${levelName}`, logEntry);

    // Type-level event: log.OCPP
    this.emitter.emit(`log.${type}`, logEntry);

    // Level-level event: log.*.INFO
    this.emitter.emit(`log.*.${levelName}`, logEntry);

    // Generic event: log
    this.emitter.emit("log", logEntry);

    // Backward compatibility (this call is no longer needed, but just in case)
    if (
      this._loggingCallback &&
      !this.emitter.listeners("log").includes(this._loggingCallback)
    ) {
      this._loggingCallback(logEntry);
    }
  }

  /**
   * Format a log entry as a string
   */
  private formatLogEntry(entry: LogEntry): string {
    const timestamp = entry.timestamp.toISOString();
    const level = LogLevel[entry.level];
    const type = entry.type;
    return `[${timestamp}] [${level}] [${type}] ${entry.message}`;
  }

  /**
   * Get all log entries
   */
  getLogEntries(): LogEntry[] {
    return [...this.logList];
  }

  /**
   * Get filtered log entries
   */
  getFilteredLogs(filter: LogFilter): LogEntry[] {
    return this.logList.filter((entry) => {
      // Filter by level
      if (filter.level !== undefined && entry.level < filter.level) {
        return false;
      }

      // Filter by types
      if (filter.types && !filter.types.includes(entry.type)) {
        return false;
      }

      // Filter by time range
      if (filter.startTime && entry.timestamp < filter.startTime) {
        return false;
      }
      if (filter.endTime && entry.timestamp > filter.endTime) {
        return false;
      }

      return true;
    });
  }

  /**
   * Get logs as formatted strings
   * @deprecated Use getLogEntries() for structured data
   */
  getLogs(): string[] {
    return this.logList.map((entry) => this.formatLogEntry(entry));
  }

  /**
   * Get logs as formatted strings with filtering
   */
  getLogsAsStrings(filter?: LogFilter): string[] {
    const entries = filter ? this.getFilteredLogs(filter) : this.logList;
    return entries.map((entry) => this.formatLogEntry(entry));
  }

  clearLogs(): void {
    this.logList = [];
  }

  getLogString(filter?: LogFilter): string {
    return this.getLogsAsStrings(filter).join("\n");
  }

  /**
   * Get statistics about logs
   */
  getStats(): {
    total: number;
    byLevel: Record<string, number>;
    byType: Record<string, number>;
  } {
    const stats = {
      total: this.logList.length,
      byLevel: {} as Record<string, number>,
      byType: {} as Record<string, number>,
    };

    this.logList.forEach((entry) => {
      const levelName = LogLevel[entry.level];
      const typeName = entry.type;

      stats.byLevel[levelName] = (stats.byLevel[levelName] || 0) + 1;
      stats.byType[typeName] = (stats.byType[typeName] || 0) + 1;
    });

    return stats;
  }

  saveLogsToFile(filename: string): void {
    // This is a placeholder. In a browser environment, you might want to use
    // the File System Access API or offer a download. In Node.js, you'd use the fs module.
    console.log(`Saving logs to ${filename}`);
    // Implementation depends on your environment (browser vs Node.js)
  }

  /**
   * Subscribe to log events with wildcards support
   * Examples:
   * - on('log.*', listener) - all logs
   * - on('log.OCPP.*', listener) - all OCPP logs
   * - on('log.*.ERROR', listener) - all error logs
   * - on('log.TRANSACTION.INFO', listener) - transaction info logs only
   * @returns Unsubscribe function
   */
  on(event: string, listener: (entry: LogEntry) => void): () => void {
    this.emitter.on(event, listener);
    return () => {
      this.emitter.off(event, listener);
    };
  }

  /**
   * Subscribe to log events (one-time only)
   */
  once(event: string, listener: (entry: LogEntry) => void): () => void {
    this.emitter.once(event, listener);
    return () => {
      this.emitter.off(event, listener);
    };
  }

  /**
   * Remove a specific listener
   */
  off(event: string, listener: (entry: LogEntry) => void): void {
    this.emitter.off(event, listener);
  }

  /**
   * Listen to all log events
   * @param listener Callback that receives (event, entry)
   */
  onAny(
    listener: (event: string | string[], entry: LogEntry) => void,
  ): () => void {
    this.emitter.onAny(listener);
    return () => {
      this.emitter.offAny(listener);
    };
  }

  /**
   * Remove listener from all events
   */
  offAny(listener: (event: string | string[], entry: LogEntry) => void): void {
    this.emitter.offAny(listener);
  }

  /**
   * Wait for a specific log event (Promise-based)
   * @param event Event name (supports wildcards)
   * @param timeout Optional timeout in milliseconds
   */
  async waitFor(event: string, timeout?: number): Promise<LogEntry> {
    return new Promise((resolve, reject) => {
      const timer = timeout
        ? setTimeout(() => {
            this.emitter.off(event, handler);
            reject(new Error(`Timeout waiting for log event: ${event}`));
          }, timeout)
        : null;

      const handler = (entry: LogEntry) => {
        if (timer) clearTimeout(timer);
        resolve(entry);
      };

      this.emitter.once(event, handler);
    });
  }
}
