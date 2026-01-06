enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export class Logger {
  private level: LogLevel;
  private logList: string[] = [];
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

  debug(message: string): void {
    this.log(message, LogLevel.DEBUG);
  }

  info(message: string): void {
    this.log(message, LogLevel.INFO);
  }

  warn(message: string): void {
    this.log(message, LogLevel.WARN);
  }

  error(message: string): void {
    this.log(message, LogLevel.ERROR);
  }

  log(message: string, level: LogLevel = LogLevel.DEBUG): void {
    if (level >= this.level) {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [${LogLevel[level]}] ${message}`;
      switch (level) {
        case LogLevel.DEBUG:
          console.debug(logMessage);
          break;
        case LogLevel.INFO:
          console.info(logMessage);
          break;
        case LogLevel.WARN:
          console.warn(logMessage);
          break;
        case LogLevel.ERROR:
          console.error(logMessage);
          break;
        default:
          console.log(logMessage);
          break;
      }
      this.logList.push(logMessage);
      if (this._loggingCallback) {
        this._loggingCallback(logMessage);
      }
    }
  }

  getLogs(): string[] {
    return this.logList;
  }

  clearLogs(): void {
    this.logList = [];
  }

  getLogString(): string {
    return this.logList.join("\n");
  }

  saveLogsToFile(filename: string): void {
    // This is a placeholder. In a browser environment, you might want to use
    // the File System Access API or offer a download. In Node.js, you'd use the fs module.
    console.log(`Saving logs to ${filename}`);
    // Implementation depends on your environment (browser vs Node.js)
  }
}
