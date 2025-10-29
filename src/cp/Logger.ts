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

export class Logger {
  private level: LogLevel;
  private logList: LogEntry[] = [];
  private enabledTypes: Set<LogType> = new Set(Object.values(LogType));
  public _loggingCallback: ((message: string) => void) | null = null;

  set loggingCallback(callback: ((message: string) => void) | null) {
    this._loggingCallback = callback;
  }

  constructor(level: LogLevel = LogLevel.DEBUG) {
    this.level = level;
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

    if (this._loggingCallback) {
      this._loggingCallback(formattedMessage);
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
}
