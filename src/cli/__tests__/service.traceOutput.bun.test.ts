import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CLIChargePointService } from "../service";
import { setGlobalTraceWriter, TraceWriter } from "../trace/TraceWriter";
import { LogType, type Logger } from "../../cp/shared/Logger";

function readRecords(filePath: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/** There is no public accessor for the charge point's Logger; existing
 *  service tests (e.g. service.scenarioResume.bun.test.ts) reach into
 *  service internals the same way via a cast. */
function loggerOf(svc: CLIChargePointService): Logger {
  return (svc as unknown as { _chargePoint: { logger: Logger } })._chargePoint
    .logger;
}

describe("--trace-output: CLIChargePointService wiring (#188)", () => {
  let dir: string;

  afterEach(() => {
    setGlobalTraceWriter(null);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("streams wire messages from a real service to the trace file, and stops after cleanup()", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-output-"));
    const filePath = path.join(dir, "trace.jsonl");
    setGlobalTraceWriter(new TraceWriter(filePath));

    const svc = new CLIChargePointService(
      {
        cpId: "test-cp",
        wsUrl: "ws://127.0.0.1:65534/never",
        connectors: 1,
        vendor: "v",
        model: "m",
      },
      null,
    );

    const logger = loggerOf(svc);
    logger.info(
      'Sent: [2,"m-1","BootNotification",{"chargePointVendor":"V"}]',
      LogType.WEBSOCKET,
    );
    logger.info('Received: [3,"m-1",{"status":"Accepted"}]', LogType.WEBSOCKET);

    const records = readRecords(filePath);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      schemaVersion: "1.1",
      chargePointId: "test-cp",
      messageType: "CALL",
      action: "BootNotification",
    });
    expect(records[1]).toMatchObject({
      schemaVersion: "1.1",
      chargePointId: "test-cp",
      messageType: "CALLRESULT",
      action: "BootNotification",
    });

    svc.cleanup();
    logger.info('Sent: [2,"m-2","Heartbeat",{}]', LogType.WEBSOCKET);

    // cleanup() released the subscription: no new row appended.
    expect(readRecords(filePath)).toHaveLength(2);
  });
});
