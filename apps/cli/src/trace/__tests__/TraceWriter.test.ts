import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { Logger, LogType } from "@ocpp-cp-sim/core/cp/shared/Logger";
import { TraceWriter } from "../TraceWriter";

function readRecords(filePath: string): unknown[] {
  const content = fs.readFileSync(filePath, "utf8");
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe("TraceWriter", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-"));
    filePath = path.join(dir, "trace.jsonl");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes a Sent CALL and Received CALLRESULT as two back-filled JSONL rows", () => {
    const writer = new TraceWriter(filePath);
    const logger = new Logger();
    logger.setCpId("CP001");
    writer.attach({ cpId: "CP001", ocppVersion: "OCPP-1.6J", logger });

    logger.info(
      'Sent: [2,"m-1","BootNotification",{"chargePointVendor":"V"}]',
      LogType.WEBSOCKET,
    );
    logger.info('Received: [3,"m-1",{"status":"Accepted"}]', LogType.WEBSOCKET);

    const records = readRecords(filePath);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      messageType: "CALL",
      action: "BootNotification",
      chargePointId: "CP001",
      ocppVersion: "1.6",
      transport: "json",
      raw: '[2,"m-1","BootNotification",{"chargePointVendor":"V"}]',
    });
    // The CALLRESULT's action is back-filled from the correlated CALL.
    expect(records[1]).toMatchObject({
      messageType: "CALLRESULT",
      action: "BootNotification",
      chargePointId: "CP001",
      ocppVersion: "1.6",
      transport: "json",
      raw: '[3,"m-1",{"status":"Accepted"}]',
    });
  });

  it("does not write a row for a non-wire log line", () => {
    const writer = new TraceWriter(filePath);
    const logger = new Logger();
    writer.attach({ cpId: "CP001", logger });

    logger.info("Some diagnostic chatter", LogType.GENERAL);
    logger.info("Boot notification accepted", LogType.OCPP);

    expect(readRecords(filePath)).toHaveLength(0);
  });

  it("stops writing once the attach subscription is released", () => {
    const writer = new TraceWriter(filePath);
    const logger = new Logger();
    const detach = writer.attach({ cpId: "CP001", logger });

    logger.info('Sent: [2,"m-1","Heartbeat",{}]', LogType.WEBSOCKET);
    expect(readRecords(filePath)).toHaveLength(1);

    detach();
    logger.info('Sent: [2,"m-2","Heartbeat",{}]', LogType.WEBSOCKET);

    expect(readRecords(filePath)).toHaveLength(1);
  });

  it("creates the file eagerly at construction, even before any record is written", () => {
    new TraceWriter(filePath);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf8")).toBe("");
  });

  it("throws at construction when the path is unwritable", () => {
    const badPath = path.join(dir, "no-such-parent-dir", "trace.jsonl");
    expect(() => new TraceWriter(badPath)).toThrow();
  });

  describe("write failures after construction", () => {
    let warnSpy: MockInstance;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("does not throw and warns when appendFileSync fails on a later write", () => {
      const writer = new TraceWriter(filePath);
      const logger = new Logger();
      logger.setCpId("CP001");
      writer.attach({ cpId: "CP001", ocppVersion: "OCPP-1.6J", logger });

      // Replace the trace file with a directory at the same path, so a
      // later fs.appendFileSync throws EISDIR — simulating a runtime I/O
      // failure (disk full, file replaced, permission revoked) after the
      // writer was constructed successfully.
      fs.rmSync(filePath, { force: true });
      fs.mkdirSync(filePath);

      expect(() => {
        logger.info('Sent: [2,"m-1","Heartbeat",{}]', LogType.WEBSOCKET);
      }).not.toThrow();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("[TraceWriter]");
      expect(warnSpy.mock.calls[0][0]).toContain(filePath);
    });
  });

  it("attaches an inbound validation violation to the CALL record's meta (#593)", async () => {
    const writer = new TraceWriter(filePath);
    const logger = new Logger();
    writer.attach({ cpId: "CP001", ocppVersion: "OCPP-1.6J", logger });

    logger.info(
      'Received: [2,"in-1","Reset",{"type":"Warm"}]',
      LogType.WEBSOCKET,
    );
    logger.warn(
      `Inbound validation: ${JSON.stringify({
        messageId: "in-1",
        action: "Reset",
        mode: "warn",
        errorCode: "PropertyConstraintViolation",
        description:
          "Inbound Reset: type must be equal to one of the allowed values",
      })}`,
      LogType.WEBSOCKET,
    );
    logger.info('Sent: [3,"in-1",{"status":"Accepted"}]', LogType.WEBSOCKET);
    await Promise.resolve();

    const records = readRecords(filePath);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      messageType: "CALL",
      messageId: "in-1",
      direction: "csms-to-cp",
      meta: {
        validation: {
          mode: "warn",
          errorCode: "PropertyConstraintViolation",
        },
      },
    });
    expect(records[1]).toMatchObject({ messageType: "CALLRESULT" });
    expect((records[1] as { meta?: unknown }).meta).toBeUndefined();
  });

  it("writes an inbound CALL with no violation unchanged, in order", async () => {
    const writer = new TraceWriter(filePath);
    const logger = new Logger();
    writer.attach({ cpId: "CP001", ocppVersion: "OCPP-1.6J", logger });
    logger.info(
      'Received: [2,"in-2","Reset",{"type":"Soft"}]',
      LogType.WEBSOCKET,
    );
    logger.info('Sent: [3,"in-2",{"status":"Accepted"}]', LogType.WEBSOCKET);
    await Promise.resolve();
    const records = readRecords(filePath) as Array<{
      messageType: string;
      meta?: unknown;
    }>;
    expect(records.map((r) => r.messageType)).toEqual(["CALL", "CALLRESULT"]);
    expect(records[0].meta).toBeUndefined();
  });
});
