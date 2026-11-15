import type { SimClock } from "../../shared/clock";
import type { EventEmitter } from "../../shared/EventEmitter";
import type { Connector } from "../connector/Connector";
import { reportedActivePowerW } from "../connector/MeterValueBuilder";
import { DEVICE_MODEL } from "../device-model/DeviceModelRegistry";
import type { MonitoredReading } from "../monitoring/evaluateMonitor";
import { MonitorEvaluation } from "../monitoring/MonitorEvaluation";
import {
  MONITORING_BASES,
  type MonitoringStore,
} from "../monitoring/MonitoringStore";
import {
  MONITORING_CTRLR_KEYS,
  MONITORING_REQUEST_MAX_BYTES,
  MONITORING_REQUEST_MAX_ITEMS,
} from "../monitoring/monitoringCtrlrKeys";
import {
  MAX_MONITOR_SEVERITY,
  MIN_MONITOR_SEVERITY,
  type VariableMonitor,
} from "../monitoring/VariableMonitor";
import type { ChargePointRepositories } from "../persistence/ChargePointRepositories";
import type { StationTopology } from "../topology/StationTopology";
import type { Outbox } from "../transport/Outbox";
import { OCPP_2_1 } from "../types/OcppVersion";
import type { ChargePointStatus } from "../types/OcppTypes";
import type { ChargePointEvents } from "./ChargePointEvents";
import type { ConfigurationStore } from "./ConfigurationStore";
import type { DeviceModelTargets } from "./DeviceModelTargets";
import { renderConfigValue } from "./renderConfigValue";
import {
  evseValueKey,
  RUNTIME_VALUE_KEYS,
  toV2ConnectorStatus,
  V2_CONNECTOR_STATUSES,
} from "./runtimeValueKeys";

/** What the device model publisher needs from its charge point. Every
 *  member is read through a function: the fields behind them are assigned
 *  after the publisher is constructed. */
export interface DeviceModelPublisherHost {
  readonly clock: () => SimClock;
  readonly configuration: () => ConfigurationStore;
  readonly connectors: () => Map<number, Connector>;
  readonly deviceModelTargets: () => DeviceModelTargets;
  readonly events: () => EventEmitter<ChargePointEvents>;
  readonly monitoring: () => MonitoringStore;
  readonly ocppVersion: () => string;
  readonly outbox: () => Outbox;
  readonly repositories: () => ChargePointRepositories;
  readonly status: () => ChargePointStatus;
  readonly topology: () => StationTopology;
  readonly evseIdOf: (connectorId: number) => number;
}

/**
 * The OCPP 2.x device model side of one charge point: variable monitors
 * (#457, #538), their evaluation into NotifyEvent, and the read-only runtime
 * keys the device model publishes. Owns the evaluation; the charge point
 * calls `wireVariableMonitoring()` from its constructor.
 */
export class DeviceModelPublisher {
  /** Their evaluation into NotifyEvent; OCPP 2.x only (N07, #457). */
  evaluation: MonitorEvaluation | undefined;

  constructor(private readonly host: DeviceModelPublisherHost) {}

  /**
   * OCPP 2.x variable monitoring (#457): restore the persisted monitors
   * (N07.FR.13), keep the table in step with the store, and evaluate the
   * monitors whenever SetVariables or a scenario `configSet` node changes
   * the value they watch (N07). Events go out after the answer that caused
   * them, and only while the boot is Accepted (B02.FR.02): reporting starts
   * off and `applyBootAccepted` turns it on.
   */
  wireVariableMonitoring(): void {
    const repository = this.host.repositories().variableMonitors;
    const persisted = repository.load();
    const storedBase = repository.loadActiveBase();
    // #538: the hardwired monitors, the persisted ones, and on a station
    // that never stored its catalog state, the preconfigured ones. The
    // station's own monitors are stored too, so they keep their triggered
    // flag (N07.FR.14) and a later start knows which were deleted.
    const { dropped, added } = this.host.monitoring().initialize(
      persisted.map((p) => p.monitor),
      storedBase,
    );
    // A hardwired row the catalog no longer has was ignored: drop it, so a
    // later monitor under its id does not inherit its triggered flag.
    for (const monitor of dropped) repository.delete(monitor.id);
    for (const monitor of added) repository.save(monitor);
    if (storedBase === undefined) {
      repository.saveActiveBase(this.host.monitoring().activeMonitoringBase);
    }
    this.publishMonitoringCtrlr();
    this.publishDeviceModelConstants();
    this.publishRuntimeValues();
    // Registered before the evaluation's own listener, so a new row exists
    // when its triggered flag is first written.
    this.host.monitoring().onChange((event) => {
      if (event.kind === "installed") repository.save(event.monitor);
      else if (event.kind === "cleared") repository.delete(event.monitor.id);
      else if (event.kind === "levelChanged") {
        this.publishActiveMonitoringLevel();
      } else {
        repository.saveActiveBase(event.base);
        this.publishActiveMonitoringBase();
      }
    });
    const evaluation = new MonitorEvaluation(
      {
        store: this.host.monitoring(),
        read: (key) => this.readMonitoredValue(key),
        // Sent after the answer to the message that caused them. A
        // disposal in between (cp.delete, the instance a cp.update
        // replaces) drops them: queued now, they would be a row for a
        // charge point that is gone (#538).
        emit: (events) =>
          queueMicrotask(() => {
            if (!evaluation.disposed)
              this.host.outbox().sendNotifyEvent(events);
          }),
        // N07.FR.04, N08.FR.03: queued at once, in production order with
        // the TransactionEvents queued offline (#538).
        queue: (events) => this.host.outbox().queueNotifyEvent(events),
        offlineQueuingSeverity: () =>
          this.host.configuration().offlineQueuingSeverity(),
        transactionActive: () =>
          [...this.host.connectors().values()].some(
            (c) => c.hasRunningTransaction,
          ),
        transactionIdOf: (monitor) => this.monitoredTransactionId(monitor),
        onTriggeredChange: (id, triggered) =>
          repository.setTriggered(id, triggered),
        // The reports a previous run queued keep their eventIds (#538).
        lastQueuedEventId: () =>
          this.host.outbox().highestQueuedNotifyEventId(),
        clock: this.host.clock(),
      },
      new Map(persisted.map((p) => [p.monitor.id, p.triggered])),
    );
    // Not connected yet: offline until the first Boot Accepted (#538).
    evaluation.setOffline();
    this.evaluation = evaluation;
    this.host.configuration().onChange((key) => evaluation.valueChanged(key));
    this.host
      .deviceModelTargets()
      .onChange((key) => evaluation.valueChanged(key));
  }

  /**
   * The registry's constants (#604), such as `ClockCtrlr.TimeSource`, as
   * read-only runtime keys, so reads, reports and monitors see them.
   */
  private publishDeviceModelConstants(): void {
    for (const def of DEVICE_MODEL.variables) {
      if (def.constant !== true) continue;
      if (typeof def.default === "string") {
        this.host.configuration().defineRuntimeKey(def.valueKey, def.default);
      } else if (typeof def.default === "number") {
        this.host
          .configuration()
          .defineRuntimeIntegerKey(
            def.valueKey,
            def.default,
            def.min === undefined ? undefined : { min: def.min },
          );
      }
    }
  }

  /**
   * The read-only MonitoringCtrlr variables of the 2.x device model (#538),
   * as runtime configuration keys: the request limits it advertises for
   * Set/ClearVariableMonitoring, and the monitoring level in force.
   */
  private publishMonitoringCtrlr(): void {
    const keys = MONITORING_CTRLR_KEYS;
    for (const items of [
      keys.itemsPerSetVariableMonitoring,
      keys.itemsPerClearVariableMonitoring,
    ]) {
      this.host
        .configuration()
        .defineRuntimeIntegerKey(items, MONITORING_REQUEST_MAX_ITEMS);
    }
    for (const bytes of [
      keys.bytesPerSetVariableMonitoring,
      keys.bytesPerClearVariableMonitoring,
    ]) {
      this.host
        .configuration()
        .defineRuntimeIntegerKey(bytes, MONITORING_REQUEST_MAX_BYTES);
    }
    this.publishActiveMonitoringLevel();
    this.publishActiveMonitoringBase();
  }

  /**
   * The runtime values of the 2.x device model (#538), as read-only runtime
   * keys refreshed on every connector event that can move them (status,
   * meter tick, SoC, EV settings, charging profiles, transaction). A key is
   * redefined only when its value changes, so a monitor is evaluated on
   * change only, never once per meter tick.
   */
  private publishRuntimeValues(): void {
    for (const connector of this.host.connectors().values()) {
      const publish = () => this.publishConnectorValues(connector);
      publish();
      // 2.1: EVSE.Power has a Target, for TargetDelta monitors (N07.FR.22).
      if (this.host.ocppVersion() === OCPP_2_1) {
        this.host
          .deviceModelTargets()
          .declare(
            evseValueKey(
              RUNTIME_VALUE_KEYS.evsePower,
              this.host.evseIdOf(connector.id),
            ),
          );
      }
      connector.events.on("statusChange", publish);
      connector.events.on("meterValueChange", publish);
      connector.events.on("socChange", publish);
      connector.events.on("evSettingsChange", publish);
      connector.events.on("transactionChange", publish);
      connector.events.on("chargingProfilesChange", publish);
      connector.events.on("scheduleLimitChange", publish);
    }
    this.publishStationAvailability();
    this.host
      .events()
      .on("statusChange", () => this.publishStationAvailability());
    this.host
      .events()
      .on("connectorRemoved", ({ connectorId }) =>
        this.withdrawConnectorValues(connectorId),
      );
  }

  /** `EVSE.Power`, `EVSE.AvailabilityState` and
   *  `Connector.AvailabilityState` of the connector's EVSE (`topology`).
   *  On a 1:1 station the EVSE and its one connector share the value; an EVSE
   *  state of its own (G03 Note 1) comes with multi-connector EVSEs (#628). */
  private publishConnectorValues(connector: Connector): void {
    const keys = RUNTIME_VALUE_KEYS;
    const evseId = this.host.evseIdOf(connector.id);
    this.publishRuntimeInteger(
      evseValueKey(keys.evsePower, evseId),
      reportedActivePowerW(connector),
    );
    const state = toV2ConnectorStatus(connector.status);
    for (const prefix of [keys.evseState, keys.connectorState]) {
      this.publishRuntimeString(evseValueKey(prefix, evseId), state);
    }
  }

  /**
   * A removed connector's EVSE leaves the device model (#538): its runtime
   * keys and its `EVSE.Power` target go. A monitor on them stays installed
   * and reads no value, so it reports nothing, periodic ticks included.
   */
  private withdrawConnectorValues(connectorId: number): void {
    const keys = RUNTIME_VALUE_KEYS;
    const evseId = this.host.evseIdOf(connectorId);
    for (const prefix of [
      keys.evsePower,
      keys.evseState,
      keys.connectorState,
    ]) {
      this.host.configuration().removeRuntimeKey(evseValueKey(prefix, evseId));
    }
    this.host
      .deviceModelTargets()
      .undeclare(evseValueKey(keys.evsePower, evseId));
  }

  /** `ChargingStation.AvailabilityState`: the station-level status. */
  private publishStationAvailability(): void {
    this.publishRuntimeString(
      RUNTIME_VALUE_KEYS.chargingStationAvailabilityState,
      toV2ConnectorStatus(this.host.status()),
    );
  }

  private publishRuntimeInteger(key: string, value: number): void {
    if (this.host.configuration().get(key)?.value === value) return;
    this.host.configuration().defineRuntimeIntegerKey(key, value);
  }

  private publishRuntimeString(key: string, value: string): void {
    if (this.host.configuration().get(key)?.value === value) return;
    this.host
      .configuration()
      .defineRuntimeKey(key, value, V2_CONNECTOR_STATUSES);
  }

  /** `ActiveMonitoringBase` follows SetMonitoringBase. */
  private publishActiveMonitoringBase(): void {
    this.host
      .configuration()
      .defineRuntimeKey(
        MONITORING_CTRLR_KEYS.activeMonitoringBase,
        this.host.monitoring().activeMonitoringBase,
        MONITORING_BASES,
      );
  }

  /** `ActiveMonitoringLevel` follows SetMonitoringLevel (0-9). */
  private publishActiveMonitoringLevel(): void {
    this.host
      .configuration()
      .defineRuntimeIntegerKey(
        MONITORING_CTRLR_KEYS.activeMonitoringLevel,
        this.host.monitoring().monitoringLevel,
        { min: MIN_MONITOR_SEVERITY, max: MAX_MONITOR_SEVERITY },
      );
  }

  /**
   * The 2.x transactionId a monitor's event is linked to (#538): the
   * transaction running on a connector of the monitor's EVSE (`topology`), or,
   * for a station-level monitor reporting only during a transaction, the
   * transaction when exactly one runs. Otherwise none.
   */
  private monitoredTransactionId(monitor: VariableMonitor): string | undefined {
    const running = (c: Connector | undefined) =>
      c?.hasRunningTransaction ? c.transaction?.cpTransactionId : undefined;
    const evse = monitor.component.evse;
    if (evse !== undefined) {
      for (const id of this.host.topology().connectorsOf(evse.id)) {
        const txId = running(this.host.connectors().get(id));
        if (txId !== undefined) return txId;
      }
      return undefined;
    }
    if (!monitor.transaction) return undefined;
    const active = [...this.host.connectors().values()].filter(
      (c) => c.hasRunningTransaction,
    );
    return active.length === 1 ? running(active[0]) : undefined;
  }

  /** A configuration value as a monitor sees it: GetVariables' rendering
   *  (empty when write-only, N07.FR.10) and its number, if it is one. */
  private readMonitoredValue(key: string): MonitoredReading | undefined {
    const entry = this.host.configuration().get(key);
    if (entry === undefined) return undefined;
    const text = renderConfigValue(entry);
    const target = this.host.deviceModelTargets().get(key);
    return typeof entry.value === "number"
      ? { numeric: entry.value, text, ...(target !== undefined && { target }) }
      : { text };
  }
}
