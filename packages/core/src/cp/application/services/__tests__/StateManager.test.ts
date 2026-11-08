import { describe, expect, it } from "vitest";

import type { ChargePointEvents } from "../../../domain/charge-point/ChargePointEvents";
import { OCPPStatus } from "../../../domain/types/OcppTypes";
import { EventEmitter } from "../../../shared/EventEmitter";
import { Logger, LogType, type LogEntry } from "../../../shared/Logger";
import { StateManager } from "../StateManager";

function newStateManager(): {
  manager: StateManager;
  events: EventEmitter<ChargePointEvents>;
  logs: LogEntry[];
} {
  const logger = new Logger();
  const logs: LogEntry[] = [];
  logger.loggingCallback = (entry) => logs.push(entry);
  const events = new EventEmitter<ChargePointEvents>();
  const manager = new StateManager(logger, events, () => ({
    status: OCPPStatus.Available,
    error: "",
  }));
  return { manager, events, logs };
}

describe("StateManager", () => {
  // #374: the StateManager logged with `LogType.System`, which does not
  // exist (the member is `SYSTEM`); an entry with no type is not in the
  // Logger's enabled types, so it was silently dropped.
  it("logs a charge point status transition as a SYSTEM entry", () => {
    const { manager, logs } = newStateManager();

    manager.transitionChargePointStatus(OCPPStatus.Unavailable, {
      source: "test",
      timestamp: new Date(),
    });

    expect(logs).toEqual([
      expect.objectContaining({
        type: LogType.SYSTEM,
        message: expect.stringContaining("ChargePoint status"),
      }),
    ]);
  });

  // The retired connector state machine is gone: the manager records the
  // status changes the charger engine publishes, and nothing else.
  it("records the connector status changes the engine publishes", () => {
    const { manager, events } = newStateManager();

    events.emit("connectorStatusChange", {
      connectorId: 1,
      status: OCPPStatus.Preparing,
      previousStatus: OCPPStatus.Available,
    });

    expect(manager.getStateHistory()).toEqual([
      expect.objectContaining({
        entity: "connector",
        entityId: 1,
        fromState: OCPPStatus.Available,
        toState: OCPPStatus.Preparing,
        success: true,
      }),
    ]);
  });
});
