import { OCPPStatus } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import { redactSensitiveValue } from "@ocpp-cp-simulator/core/cp/shared/redaction";
import type { ForwarderHost } from "./forwarderHost";
import { attachConnectorEventForwarders } from "./connectorEventForwarders";

export function attachEventForwarders(host: ForwarderHost): void {
  // A firmware update with `bumpVersion` installed a new version: the
  // init a `cp.update` falls back to follows it, whether or not anything
  // persists it (`onFirmwareVersionChange`).
  host.unsubscribes.push(
    host.chargePoint.events.on(
      "firmwareVersionChanged",
      ({ firmwareVersion }) => {
        host.init = {
          ...host.init,
          bootNotification: {
            ...(host.init.bootNotification ?? {}),
            firmwareVersion,
          },
        };
      },
    ),
  );
  // #603: a StartTransaction.conf that is not Accepted turns a start the
  // runner counted as accepted (the request went out) into a refusal;
  // once per session, and only for the answer to the start.
  host.unsubscribes.push(
    host.chargePoint.events.on(
      "startTransactionNotAccepted",
      ({ connectorId, midSession }) => {
        // 2.x: an Updated that carries the idToken can be refused after
        // the start was accepted; that is not a start refusal.
        if (!midSession) {
          host.autoTraffic.get(connectorId)?.noteStartConfRefused();
        }
      },
    ),
  );
  host.unsubscribes.push(
    host.chargePoint.timeline.onRecord((entry) =>
      host.emit({ event: "timeline_entry", data: entry }),
    ),
  );
  host.unsubscribes.push(
    host.chargePoint.events.on("statusChange", ({ status }) => {
      host.emit({ event: "status_change", data: { status } });
      // "Auto-start on connect", the daemon side of the browser's
      // LocalScenarioRuntime (same rules, matchAutoStart): when the CP
      // reaches Available (post-BootNotification.Accepted) fire any loaded
      // manual-trigger scenarios whose Start node opts into
      // `triggerOn: "connect"`. In Remote mode the browser runs no
      // scenarios, so this is the only place that does it.
      if ((status as OCPPStatus) === OCPPStatus.Available) {
        host.handleConnectAutoStart();
        // Connector statusChange events fired during BootNotification
        // handling race ahead of the CP-level Available transition, so
        // `handleStatusAutoStart` returns early via the
        // `chargePoint.status !== Available` gate and any
        // `triggerOn: "status"` scenario targeting the connector's
        // current state never starts. Re-evaluate every connector here
        // now that the gate is open. Dedup via lastAutoStartedScenarioKey
        // keeps repeats of this branch from re-firing what's already up.
        for (const connector of host.chargePoint.connectors.values()) {
          host.handleStatusAutoStart(
            connector.id,
            connector.status as OCPPStatus,
          );
        }
      }
    }),
  );

  host.unsubscribes.push(
    host.chargePoint.events.on("error", ({ error }) => {
      host.emit({ event: "error", data: { error } });
    }),
  );

  host.unsubscribes.push(
    host.chargePoint.events.on("connected", () => {
      host.emit({ event: "connected", data: {} });
    }),
  );

  host.unsubscribes.push(
    host.chargePoint.events.on("bootNotificationResult", (result) => {
      host.emit({ event: "boot_notification", data: { ...result } });
    }),
  );

  host.unsubscribes.push(
    host.chargePoint.events.on("disconnected", ({ code, reason }) => {
      host.emit({ event: "disconnected", data: { code, reason } });
      // ChargePoint.teardownAfterClose (which has already run by the time
      // this fires) clears every connector's lastAutoStartedScenarioKey so a
      // `triggerOn: "connect"` scenario re-arms on the next connect. Getting
      // that into the DB normally rides on the connector statusChange that
      // teardown's Unavailable cascade emits — but the cascade deliberately
      // SKIPS a connector mid-transaction, so precisely the connectors that
      // were charging when the socket dropped never persisted the clear, and
      // a restart rehydrated the stale arm. Snapshot every connector here
      // instead of relying on which ones happened to emit.
      for (const [connectorId, connector] of host.chargePoint.connectors) {
        host.persistConnectorRuntime(connector, connectorId);
      }
    }),
  );

  host.unsubscribes.push(
    host.chargePoint.heartbeat.events.on(
      "stateChange",
      ({ intervalSeconds, lastSentAt }) => {
        host.emit({
          event: "heartbeat",
          data: {
            intervalSeconds,
            lastSentAt: lastSentAt ? lastSentAt.toISOString() : null,
          },
        });
      },
    ),
  );

  host.unsubscribes.push(
    host.chargePoint.events.on(
      "connectorStatusChange",
      ({ connectorId, status, previousStatus }) => {
        host.emit({
          event: "connector_status",
          data: { connectorId, status, previousStatus },
        });
      },
    ),
    host.chargePoint.events.on("statusNotificationSuppressed", (data) => {
      host.emit({ event: "status_notification_suppressed", data });
    }),
  );

  host.unsubscribes.push(
    host.chargePoint.events.on(
      "transactionStarted",
      ({ connectorId, transactionId, tagId }) => {
        host.emit({
          event: "transaction_started",
          data: { connectorId, transactionId, tagId },
        });
      },
    ),
  );

  host.unsubscribes.push(
    host.chargePoint.events.on(
      "transactionStopped",
      ({ connectorId, transactionId }) => {
        host.emit({
          event: "transaction_stopped",
          data: { connectorId, transactionId },
        });
      },
    ),
  );

  host.unsubscribes.push(
    host.chargePoint.events.on(
      "connectorMeterValueChange",
      ({ connectorId, meterValue }) => {
        host.emit({
          event: "meter_value",
          data: { connectorId, meterValue },
        });
      },
    ),
  );

  host.unsubscribes.push(
    host.chargePoint.events.on("incomingCallReceived", (call) => {
      host.emit({
        event: "csms_call_received",
        // JSON Lines writes events verbatim, so the redaction the
        // Socket.IO wire applies is not enough on its own.
        data: { ...call, payload: redactSensitiveValue(call.payload) },
      });
    }),
    host.chargePoint.events.on("incomingCallCompleted", (completion) => {
      host.emit({ event: "csms_call_completed", data: completion });
    }),
  );

  host.unsubscribes.push(
    host.chargePoint.events.on("log", ({ level, type, message }) => {
      host.emit({
        event: "log",
        data: { level, type, message },
      });
    }),
  );

  attachConnectorEventForwarders(host);
  host.attachStateHistoryForwarder();

  host.unsubscribes.push(
    host.chargePoint.events.on("connectorRemoved", ({ connectorId }) => {
      host.emit({ event: "connector_removed", data: { connectorId } });
      // #314: whatever a `--watch` reload was waiting on here is gone with
      // the connector — `removeConnector` disposes it without ever emitting
      // `transactionChange(null)`, so a held definition would wait for a
      // notification that can no longer be sent. Announcing the settle is
      // what lets the reload path see the connector has gone and say so.
      host.notifySessionSettled({ connectorId, scenarioId: null });
    }),
  );
}
