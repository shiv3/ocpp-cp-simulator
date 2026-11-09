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
import { Logger, LogType } from "@ocpp-cp-simulator/core/cp/shared/Logger";
import { readRecords as readSdkRecords } from "@open-ocpp-trace/jsonl";
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

  /**
   * The simulator must keep tracing OCPP it knows to be invalid (#886): the
   * SDK writer validates the record envelope only, never `payload` or `raw`,
   * so a schema violation (#593) or a malformed fault-injection frame (#393)
   * that still parses as an OCPP-J array is written, with `raw` exactly as it
   * crossed the wire.
   */
  describe("invalid OCPP is still traced (#886)", () => {
    async function sdkRecords(): Promise<unknown[]> {
      const text = fs.readFileSync(filePath, "utf8");
      const out: unknown[] = [];
      for await (const result of readSdkRecords([text], { onError: "yield" })) {
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (result.ok) out.push(result.record);
      }
      return out;
    }

    it("writes an inbound CALL whose payload violates the schema, with meta.validation (#593)", async () => {
      const writer = new TraceWriter(filePath);
      const logger = new Logger();
      writer.attach({ cpId: "CP001", ocppVersion: "OCPP-1.6J", logger });

      const frame = '[2,"in-3","Reset",{"type":42,"unexpected":true}]';
      logger.info(`Received: ${frame}`, LogType.WEBSOCKET);
      logger.warn(
        `Inbound validation: ${JSON.stringify({
          messageId: "in-3",
          action: "Reset",
          mode: "warn",
          errorCode: "TypeConstraintViolation",
          description: "Inbound Reset: type must be string",
        })}`,
        LogType.WEBSOCKET,
      );
      await Promise.resolve();

      const records = await sdkRecords();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        messageType: "CALL",
        action: "Reset",
        payload: { type: 42, unexpected: true },
        raw: frame,
        meta: {
          validation: {
            mode: "warn",
            errorCode: "TypeConstraintViolation",
          },
        },
      });
    });

    it("writes malformed OCPP-J frames (#393) with a byte-identical raw", () => {
      const writer = new TraceWriter(filePath);
      const logger = new Logger();
      writer.attach({ cpId: "CP001", ocppVersion: "OCPP-1.6J", logger });

      // A CALL whose payload is a string plus an extra array element, and a
      // CALLERROR whose code is not a string and whose details are missing,
      // both with irregular spacing a re-serialization would lose.
      const call = '[2, "f-1","Heartbeat", "notAnObject",  "extra"]';
      const callError = '[4,"f-2", 123 ]';
      logger.info(`Sent: ${call}`, LogType.WEBSOCKET);
      logger.info(`Sent: ${callError}`, LogType.WEBSOCKET);

      const lines = fs
        .readFileSync(filePath, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { raw?: string });
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        messageType: "CALL",
        action: "Heartbeat",
        payload: "notAnObject",
      });
      expect(lines[0].raw).toBe(call);
      expect(lines[1]).toMatchObject({
        messageType: "CALLERROR",
        messageId: "f-2",
      });
      expect(lines[1].raw).toBe(callError);
    });

    it("writes JSONL the SDK reader accepts line by line", async () => {
      const writer = new TraceWriter(filePath);
      const logger = new Logger();
      writer.attach({ cpId: "CP001", ocppVersion: "OCPP-1.6J", logger });
      logger.info('Sent: [2, "f-3","Heartbeat", 7]', LogType.WEBSOCKET);
      logger.info('Received: [4,"f-3", null, 5]', LogType.WEBSOCKET);

      expect(await sdkRecords()).toHaveLength(2);
    });
  });
});
