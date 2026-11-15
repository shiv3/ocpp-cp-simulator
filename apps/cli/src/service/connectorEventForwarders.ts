import type { OCPPStatus } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import type { ForwarderHost } from "./forwarderHost";

export function attachConnectorEventForwarders(host: ForwarderHost): void {
  host.chargePoint.connectors.forEach((connector, connectorId) => {
    // Runtime persistence: every event that mutates a field in
    // ConnectorRuntimeSnapshot triggers a full snapshot upsert.
    // Snapshots are small (one row, ~10 columns) and writes are
    // throttled naturally by event frequency, so we don't batch.
    const persist = () => host.persistConnectorRuntime(connector, connectorId);
    host.connectorUnsubscribes.push(
      connector.events.on("statusChange", persist),
    );
    host.connectorUnsubscribes.push(
      connector.events.on("availabilityChange", persist),
    );
    host.connectorUnsubscribes.push(
      connector.events.on("transactionChange", persist),
    );
    host.connectorUnsubscribes.push(
      connector.events.on("transactionChange", ({ transaction }) => {
        // #314: `Connector.stopTransaction` nulls the field and *then* emits,
        // so by here `hasOpenTransaction` already answers false. The bus's
        // `transaction_stopped` fires several statements earlier, while the
        // transaction is still set — which is why a reload held behind it
        // cannot be released from there.
        if (transaction === null) {
          host.notifySessionSettled({ connectorId, scenarioId: null });
        }
      }),
    );
    host.connectorUnsubscribes.push(
      // The backstop, and the reason the contract holds rather than mostly
      // holding (#314). Every precise gate-opening point already announces a
      // settle; this one announces on *any* connector status transition, so a
      // hold cannot outlive the condition that took it. Three review rounds
      // went to paths where the gate read open and nothing re-read it — a
      // connector removed, a `StartTransaction` answered with a CALLERROR, a
      // `cp.update` that dropped the connector — and enumerating the
      // *condition* did not help, because what was missing each time was a
      // *trigger*.
      //
      // Not the `connector_status` bus-event drain an earlier round rejected,
      // and the difference matters: that one was proposed *instead of*
      // understanding where the gate actually opens, and it hid stranded
      // reloads by accident because it fired while the gate was still shut.
      // The precise triggers are still there and still fire first; this only
      // guarantees that a gate which is already open gets looked at again.
      // Re-reading is cheap — the drain walks the held entries and does
      // nothing when the gate is shut — and it runs on a later microtask, so
      // it can never execute inside the teardown that opened it.
      connector.events.on("statusChange", () => {
        host.notifySessionSettled({ connectorId, scenarioId: null });
      }),
    );
    host.connectorUnsubscribes.push(
      connector.events.on("transactionIdChange", persist),
    );
    // #846: the target-SoC auto-stop is the one station-side end that
    // completes an intent session of the traffic.
    host.connectorUnsubscribes.push(
      connector.events.on("autoStopRequested", () =>
        host.autoTraffic.get(connectorId)?.noteTargetReached(),
      ),
    );
    host.connectorUnsubscribes.push(
      connector.events.on("meterValueChange", persist),
    );
    host.connectorUnsubscribes.push(connector.events.on("socChange", persist));
    host.connectorUnsubscribes.push(
      connector.events.on("availabilityChange", ({ availability }) => {
        host.emit({
          event: "connector_availability",
          data: { connectorId, availability },
        });
      }),
    );
    // Manual meter changes and the auto-meter scheduler emit on the
    // connector's event bus rather than the charge-point's. Forward
    // those so remote subscribers see meter updates in real time.
    host.connectorUnsubscribes.push(
      connector.events.on("meterValueChange", ({ meterValue }) => {
        host.emit({
          event: "meter_value",
          data: { connectorId, meterValue },
        });
      }),
    );
    // When the CSMS confirms a StartTransaction, the connector's
    // transactionId switches from the initial placeholder (0) to the
    // assigned id. Re-emit transaction_started so remote subscribers see the
    // accepted id. (transaction_stopped comes from ChargePoint's
    // transactionStopped, emitted when the transaction ends.)
    //
    // #328: the assigned id is re-emitted WHATEVER it is, zero included.
    // OCPP 1.6 makes `transactionId` schema-valid for any integer, and the
    // setter this listens to is reached only from the CALLRESULT handlers —
    // the local placeholder never flows through it — so a `=== 0` guard here
    // did not skip a duplicate, it made a CSMS that assigns 0 invisible: a
    // subscriber could not tell "assigned 0" from "no confirmation yet".
    // Consumers already see two transaction_started per transaction on the
    // non-zero path (local start, then the assigned id); this is the same
    // sequence for one more value.
    host.connectorUnsubscribes.push(
      connector.events.on("transactionIdChange", ({ transactionId }) => {
        const tagId = connector.transaction?.tagId ?? "";
        host.emit({
          event: "transaction_started",
          data: { connectorId, transactionId, tagId },
        });
      }),
    );
    host.connectorUnsubscribes.push(
      connector.events.on("socChange", ({ soc }) => {
        host.emit({ event: "connector_soc", data: { connectorId, soc } });
      }),
    );
    host.connectorUnsubscribes.push(
      connector.events.on("modeChange", ({ mode }) => {
        host.emit({ event: "connector_mode", data: { connectorId, mode } });
      }),
    );
    host.connectorUnsubscribes.push(
      connector.events.on("autoResetToAvailableChange", ({ enabled }) => {
        host.emit({
          event: "connector_auto_reset",
          data: { connectorId, enabled },
        });
      }),
    );
    host.connectorUnsubscribes.push(
      connector.events.on("autoMeterValueChange", ({ config }) => {
        host.emit({
          event: "connector_auto_meter",
          data: { connectorId, config },
        });
      }),
    );
    host.connectorUnsubscribes.push(
      connector.events.on("evSettingsChange", ({ settings }) => {
        host.emit({
          event: "connector_ev_settings",
          data: { connectorId, settings },
        });
      }),
    );
    host.connectorUnsubscribes.push(
      connector.events.on("chargingProfileChange", ({ profile }) => {
        host.emit({
          event: "connector_charging_profile",
          data: { connectorId, profile },
        });
      }),
    );
    host.connectorUnsubscribes.push(
      connector.events.on("chargingProfilesChange", ({ profiles }) => {
        host.emit({
          event: "connector_charging_profiles",
          data: { connectorId, profiles },
        });
      }),
    );

    // statusChange-triggered scenarios: when this connector transitions,
    // scan loaded scenarios for matches and auto-run the first one.
    // Mirrors ScenarioManager.handleStatusChange used by the browser,
    // inlined here to avoid duplicating the (cp, executors) state the
    // service already owns. Also drives the manual-trigger +
    // StartNode.triggerOn === "status" case (as LocalScenarioRuntime does
    // in the browser's Local mode).
    host.connectorUnsubscribes.push(
      connector.events.on("statusChange", ({ status, previousStatus }) => {
        host.handleStatusChangeAutoTrigger(
          connectorId,
          previousStatus as OCPPStatus,
          status as OCPPStatus,
        );
        if ((status as OCPPStatus) !== previousStatus) {
          host.handleStatusAutoStart(connectorId, status as OCPPStatus);
        }
      }),
    );
  });
}
