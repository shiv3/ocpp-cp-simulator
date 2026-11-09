import { describe, expect, it } from "vitest";
import { BehaviorRegistry } from "../../../application/behavior/BehaviorRegistry";
import { ChargerEngine } from "../../../application/engine/ChargerEngine";
import { HeartbeatService } from "../../../application/services/HeartbeatService";
import { OperationalTimeline } from "../../../application/services/OperationalTimeline";
import { StateManager } from "../../../application/services/StateManager";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import { UploadFile } from "../../fileUpload";
import { LogRepository } from "../../persistence/LogRepository";
import { createChargePoint } from "../createChargePoint";

/**
 * #575: the composition root gives each charge point its own
 * `LogRepository` over the database it was given (a no-op one without a
 * database, the remote-mode browser), and the real `UploadFile`.
 */
describe("createChargePoint default deps (#575)", () => {
  function build(id: string) {
    return createChargePoint(
      id,
      DefaultBootNotification,
      1,
      "ws://localhost:9/ocpp",
      null,
      null,
    );
  }

  it("builds one LogRepository per charge point", () => {
    const a = build("cp-a");
    const b = build("cp-b");
    const sinkA = a["_logSink"];
    const sinkB = b["_logSink"];
    expect(sinkA).toBeInstanceOf(LogRepository);
    expect(sinkB).toBeInstanceOf(LogRepository);
    expect(sinkA).not.toBe(sinkB);
    a.dispose();
    b.dispose();
  });

  it("keeps the no-op log repository without a database", () => {
    const cp = build("cp-null-db");
    expect((cp["_logSink"] as LogRepository)["db"]).toBeNull();
    expect(() => {
      cp.logger.info("no database");
      cp.flushLogs();
    }).not.toThrow();
    cp.dispose();
  });

  it("uploads diagnostics with UploadFile", () => {
    const cp = build("cp-upload");
    expect(cp.fileUploader).toBe(UploadFile);
    cp.dispose();
  });
});

describe("createChargePoint default services (#575)", () => {
  it("builds the application services behind the domain getters", () => {
    const cp = createChargePoint(
      "cp-services",
      DefaultBootNotification,
      1,
      "ws://localhost:9/ocpp",
      null,
      null,
    );
    expect(cp.behaviors).toBeInstanceOf(BehaviorRegistry);
    expect(cp.engine).toBeInstanceOf(ChargerEngine);
    expect(cp.heartbeat).toBeInstanceOf(HeartbeatService);
    expect(cp.stateManager).toBeInstanceOf(StateManager);
    expect(cp.timeline).toBeInstanceOf(OperationalTimeline);
    cp.dispose();
  });
});
