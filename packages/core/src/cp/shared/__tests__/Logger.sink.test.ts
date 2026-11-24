import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger, LogLevel, setLoggerConsole } from "../Logger";

describe("Logger console sink and entry bound (#1126)", () => {
  afterEach(() => setLoggerConsole(console));

  it("writes console lines to the installed sink, per level", () => {
    const sink = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    };
    setLoggerConsole(sink);
    const logger = new Logger(LogLevel.DEBUG);
    logger.info("a");
    logger.error("b");
    expect(sink.info).toHaveBeenCalledTimes(1);
    expect(sink.error).toHaveBeenCalledTimes(1);
    expect(sink.warn).not.toHaveBeenCalled();
  });

  it("keeps every entry by default", () => {
    setLoggerConsole({
      debug() {},
      info() {},
      warn() {},
      error() {},
      log() {},
    });
    const logger = new Logger(LogLevel.INFO);
    for (let i = 0; i < 5; i++) logger.info(`m${i}`);
    expect(logger.getLogEntries()).toHaveLength(5);
  });

  it("setMaxEntries keeps the newest N and 0 keeps none", () => {
    setLoggerConsole({
      debug() {},
      info() {},
      warn() {},
      error() {},
      log() {},
    });
    const logger = new Logger(LogLevel.INFO);
    const seen: string[] = [];
    logger.loggingCallback = (e) => seen.push(e.message);
    logger.setMaxEntries(2);
    for (let i = 0; i < 5; i++) logger.info(`m${i}`);
    expect(logger.getLogEntries().map((e) => e.message)).toEqual(["m3", "m4"]);
    logger.setMaxEntries(0);
    expect(logger.getLogEntries()).toEqual([]);
    logger.info("later");
    expect(logger.getLogEntries()).toEqual([]);
    // Subscribers still see every entry.
    expect(seen).toHaveLength(6);
  });
});
