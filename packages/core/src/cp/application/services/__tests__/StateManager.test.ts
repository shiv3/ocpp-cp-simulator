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
  const manager = new StateManager(
    logger,
    events,
    () => ({ status: OCPPStatus.Available, error: "" }),
    () => undefined,
  );
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

  // #374: robot3 hands the change callback the service, not a state, so
  // reading `.name` off it mapped every transition to Faulted.
  it("reports the connector status the machine actually moved to", () => {
    const { manager, events } = newStateManager();
    const changes: ChargePointEvents["connectorStatusChange"][] = [];
    events.on("connectorStatusChange", (change) => changes.push(change));
    manager.initializeConnector(1);

    const result = manager.prepareTransaction(1, "TAG-1");

    expect(result).toMatchObject({
      success: true,
      previousState: OCPPStatus.Available,
      newState: OCPPStatus.Preparing,
    });
    expect(changes).toEqual([
      {
        connectorId: 1,
        status: OCPPStatus.Preparing,
        previousStatus: OCPPStatus.Available,
      },
    ]);
  });
});
