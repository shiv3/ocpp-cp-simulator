import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type { Database } from "@ocpp-cp-simulator/core/cp/domain/persistence/Database";
import type { ChargePointEvent } from "@ocpp-cp-simulator/client/interfaces/ChargePointService";
import { ChargingSessionRecorder } from "@ocpp-cp-simulator/core/cp/application/services/ChargingSessionRecorder";
import type { ChargingSessionRepository } from "@ocpp-cp-simulator/core/cp/domain/persistence/ChargingSessionRepository";
import type { LogEntry } from "@ocpp-cp-simulator/core/cp/shared/Logger";
import type {
  LogLevel,
  LogType,
} from "@ocpp-cp-simulator/core/cp/shared/Logger";

/** What the forwarders need from LocalChargePointService. */
export interface LocalEventForwardersHost {
  readonly database: Database | null;
  readonly chargingSessions: ChargingSessionRepository;
  emit(id: string, event: ChargePointEvent): void;
}

/**
 * Subscribes to a ChargePoint's (and its connectors') events and re-emits
 * them as ChargePointEvents. Returns the unsubscribe functions.
 */
export function attachLocalEventForwarders(
  host: LocalEventForwardersHost,
  chargePoint: ChargePoint,
): Array<() => void> {
  const unsubscribes: Array<() => void> = [];

  unsubscribes.push(
    chargePoint.timeline.onRecord((entry) => {
      host.emit(chargePoint.id, { type: "timeline-entry", entry });
    }),
  );

  // #447: a browser reload restores no transaction, so the reconcile marks
  // what the previous page left running interrupted.
  const sessionRecorder = new ChargingSessionRecorder(
    chargePoint,
    host.chargingSessions,
  );
  sessionRecorder.onChange((session) => {
    host.emit(chargePoint.id, { type: "charging-session", session });
  });
  sessionRecorder.reconcile();
  unsubscribes.push(() => sessionRecorder.dispose());

  unsubscribes.push(
    chargePoint.events.on("statusChange", ({ status }) => {
      host.emit(chargePoint.id, { type: "status", status });
    }),
  );

  unsubscribes.push(
    chargePoint.events.on("error", ({ error }) => {
      host.emit(chargePoint.id, { type: "error", error });
    }),
  );

  unsubscribes.push(
    chargePoint.events.on(
      "connectorStatusChange",
      ({ connectorId, status, previousStatus }) => {
        host.emit(chargePoint.id, {
          type: "connector-status",
          connectorId,
          status,
          previousStatus,
        });
      },
    ),
  );

  unsubscribes.push(
    chargePoint.events.on(
      "connectorAvailabilityChange",
      ({ connectorId, availability }) => {
        host.emit(chargePoint.id, {
          type: "connector-availability",
          connectorId,
          availability,
        });
      },
    ),
  );

  unsubscribes.push(
    chargePoint.events.on(
      "connectorTransactionChange",
      ({ connectorId, transactionId }) => {
        host.emit(chargePoint.id, {
          type: "connector-transaction",
          connectorId,
          transactionId,
        });
      },
    ),
  );

  unsubscribes.push(
    chargePoint.events.on(
      "connectorMeterValueChange",
      ({ connectorId, meterValue }) => {
        host.emit(chargePoint.id, {
          type: "connector-meter",
          connectorId,
          meterValue,
        });
      },
    ),
  );

  chargePoint.connectors.forEach((connector) => {
    // The ChargePoint never emits connectorMeterValueChange itself —
    // only Connector.meterValueChange fires when set_meter_value /
    // auto-meter scheduler run, so subscribe per-connector here.
    unsubscribes.push(
      connector.events.on("meterValueChange", ({ meterValue }) => {
        host.emit(chargePoint.id, {
          type: "connector-meter",
          connectorId: connector.id,
          meterValue,
        });
      }),
    );
    unsubscribes.push(
      connector.events.on("autoMeterValueChange", ({ config }) => {
        host.emit(chargePoint.id, {
          type: "connector-auto-meter",
          connectorId: connector.id,
          config,
        });
      }),
    );

    unsubscribes.push(
      connector.events.on("modeChange", ({ mode }) => {
        host.emit(chargePoint.id, {
          type: "connector-mode",
          connectorId: connector.id,
          mode,
        });
      }),
    );

    unsubscribes.push(
      connector.events.on("autoResetToAvailableChange", ({ enabled }) => {
        host.emit(chargePoint.id, {
          type: "connector-auto-reset-to-available",
          connectorId: connector.id,
          enabled,
        });
      }),
    );

    unsubscribes.push(
      connector.events.on("socChange", ({ soc }) => {
        host.emit(chargePoint.id, {
          type: "connector-soc",
          connectorId: connector.id,
          soc,
        });
      }),
    );

    unsubscribes.push(
      connector.events.on("evSettingsChange", ({ settings }) => {
        host.emit(chargePoint.id, {
          type: "connector-ev-settings",
          connectorId: connector.id,
          settings,
        });
      }),
    );

    unsubscribes.push(
      connector.events.on("chargingProfileChange", ({ profile }) => {
        host.emit(chargePoint.id, {
          type: "connector-charging-profile",
          connectorId: connector.id,
          profile,
        });
      }),
    );

    unsubscribes.push(
      connector.events.on("chargingProfilesChange", ({ profiles }) => {
        // Persist via the SQLite repo so the next CP build picks them up.
        if (host.database) {
          host.database.run(
            "DELETE FROM charging_profiles WHERE cp_id = ? AND connector_id = ?",
            [chargePoint.id, connector.id],
          );
          for (const profile of profiles) {
            host.database.run(
              "INSERT INTO charging_profiles " +
                "(cp_id, connector_id, charging_profile_id, stack_level, purpose, profile) " +
                "VALUES (?, ?, ?, ?, ?, ?)",
              [
                chargePoint.id,
                connector.id,
                profile.chargingProfileId,
                profile.stackLevel,
                profile.chargingProfilePurpose,
                JSON.stringify(profile),
              ],
            );
          }
        }
        host.emit(chargePoint.id, {
          type: "connector-charging-profiles",
          connectorId: connector.id,
          profiles,
        });
      }),
    );

    connector.setOnMeterValueSend((id) => {
      chargePoint.sendScheduledMeterValue(id);
    });
  });

  unsubscribes.push(
    chargePoint.events.on("connectorRemoved", ({ connectorId }) => {
      host.emit(chargePoint.id, { type: "connector-removed", connectorId });
    }),
  );

  unsubscribes.push(
    chargePoint.events.on("connected", () => {
      host.emit(chargePoint.id, { type: "connected" });
    }),
  );

  unsubscribes.push(
    chargePoint.events.on("disconnected", ({ code, reason }) => {
      host.emit(chargePoint.id, { type: "disconnected", code, reason });
    }),
  );

  unsubscribes.push(
    chargePoint.heartbeat.events.on(
      "stateChange",
      ({ intervalSeconds, lastSentAt }) => {
        host.emit(chargePoint.id, {
          type: "heartbeat",
          intervalSeconds,
          lastSentAt: lastSentAt ? lastSentAt.toISOString() : null,
        });
      },
    ),
  );

  unsubscribes.push(
    chargePoint.events.on("log", (entry) => {
      const logEntry: LogEntry = {
        timestamp: entry.timestamp,
        level: entry.level as LogLevel,
        type: entry.type as LogType,
        message: entry.message,
      };
      host.emit(chargePoint.id, { type: "log", entry: logEntry });
    }),
  );

  return unsubscribes;
}
