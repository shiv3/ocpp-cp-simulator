import {
  isThresholdMonitorType,
  isValidMonitorSeverity,
  MAX_MONITOR_SEVERITY,
  parseSupportedMonitorType,
  sameMonitorTarget,
  type MonitorComponent,
  type MonitoredValueType,
  type MonitorVariable,
  type VariableMonitor,
} from "./VariableMonitor";

/**
 * A SetMonitoringData element once its component/variable has been resolved
 * against the device model (N04.FR.03 / FR.04 are the caller's job).
 */
export interface MonitorDraft {
  /** CSMS-supplied id: replace that monitor (N04.FR.12). */
  readonly id?: number;
  /** Raw monitor type; anything unsupported is refused (N04.FR.05). */
  readonly type: string;
  readonly severity: number;
  readonly value: number;
  readonly transaction?: boolean;
  readonly component: MonitorComponent;
  readonly variable: MonitorVariable;
  readonly valueKey: string;
  readonly valueType: MonitoredValueType;
}

export type InstallRejectionReason =
  /** N04.FR.13 */
  | "UnknownMonitorId"
  /** N04.FR.16 */
  | "TargetMismatch"
  /** N04.FR.18 */
  | "HardWiredMonitor"
  /** N04.FR.06 */
  | "ValueOutOfRange"
  /** N04.FR.14 */
  | "NegativeDelta"
  /** Severity outside 0-9 (the schemas only set a minimum). */
  | "SeverityOutOfRange";

export type InstallOutcome =
  | {
      readonly status: "Accepted";
      readonly monitor: VariableMonitor;
      /** The monitor this one replaced (same id), for N07.FR.11. */
      readonly replaced?: VariableMonitor;
    }
  | { readonly status: "Duplicate"; readonly existing: VariableMonitor }
  | { readonly status: "UnsupportedMonitorType" }
  | { readonly status: "Rejected"; readonly reason: InstallRejectionReason };

export type ClearOutcome = "Accepted" | "NotFound" | "Rejected";

export type MonitoringStoreEvent =
  | {
      readonly kind: "installed";
      readonly monitor: VariableMonitor;
      readonly replaced?: VariableMonitor;
    }
  | { readonly kind: "cleared"; readonly monitor: VariableMonitor }
  | { readonly kind: "levelChanged"; readonly level: number };

export type MonitoringStoreListener = (event: MonitoringStoreEvent) => void;

/**
 * In-memory catalog of installed variable monitors plus the monitoring
 * level set by SetMonitoringLevel (N04–N06). Ids are allocated in
 * increasing order and never reused while the store lives.
 */
export class MonitoringStore {
  private readonly monitors = new Map<number, VariableMonitor>();
  private readonly listeners = new Set<MonitoringStoreListener>();
  private nextId = 1;
  private level = MAX_MONITOR_SEVERITY;

  install(draft: MonitorDraft): InstallOutcome {
    const previous =
      draft.id === undefined ? undefined : this.monitors.get(draft.id);
    if (draft.id !== undefined) {
      if (!previous) return rejected("UnknownMonitorId");
      if (!sameMonitorTarget(previous, draft))
        return rejected("TargetMismatch");
      if (previous.origin === "HardWiredMonitor") {
        return rejected("HardWiredMonitor");
      }
    }

    const type = parseSupportedMonitorType(draft.type);
    if (type === null) return { status: "UnsupportedMonitorType" };
    if (isThresholdMonitorType(type)) {
      if (!draft.valueType.numeric) return { status: "UnsupportedMonitorType" };
      const { min, max } = draft.valueType;
      if (
        (min !== undefined && draft.value < min) ||
        (max !== undefined && draft.value > max)
      ) {
        return rejected("ValueOutOfRange");
      }
    } else if (draft.value < 0) {
      return rejected("NegativeDelta");
    }
    if (!isValidMonitorSeverity(draft.severity)) {
      return rejected("SeverityOutOfRange");
    }

    const duplicate = [...this.monitors.values()].find(
      (m) =>
        m.id !== draft.id &&
        m.type === type &&
        m.severity === draft.severity &&
        sameMonitorTarget(m, draft),
    );
    if (duplicate) return { status: "Duplicate", existing: duplicate };

    const monitor: VariableMonitor = {
      id: previous?.id ?? this.nextId++,
      type,
      severity: draft.severity,
      value: draft.value,
      transaction: draft.transaction ?? false,
      component: copyComponent(draft.component),
      variable: copyVariable(draft.variable),
      valueKey: draft.valueKey,
      // N04.FR.15: replacing a preconfigured monitor makes it custom.
      origin: "CustomMonitor",
    };
    this.monitors.set(monitor.id, monitor);
    this.emit(
      previous
        ? { kind: "installed", monitor, replaced: previous }
        : { kind: "installed", monitor },
    );
    return previous
      ? { status: "Accepted", monitor, replaced: previous }
      : { status: "Accepted", monitor };
  }

  /** N06.FR.01–FR.03. */
  clear(id: number): ClearOutcome {
    const monitor = this.monitors.get(id);
    if (!monitor) return "NotFound";
    if (monitor.origin === "HardWiredMonitor") return "Rejected";
    this.monitors.delete(id);
    this.emit({ kind: "cleared", monitor });
    return "Accepted";
  }

  /**
   * N03 SetMonitoringBase. No preconfigured or hardwired monitor is
   * modelled, so activating them is a no-op: `All` keeps the custom
   * monitors (N03.FR.03), `FactoryDefault` and `HardWiredOnly` delete
   * them (N03.FR.04, FR.05). Each deletion is reported as `cleared`.
   */
  applyMonitoringBase(base: string): "Accepted" | "NotSupported" {
    if (!MONITORING_BASES.has(base)) return "NotSupported"; // N03.FR.02
    if (base !== "All") {
      for (const monitor of this.list()) {
        if (monitor.origin !== "HardWiredMonitor") this.clear(monitor.id);
      }
    }
    return "Accepted"; // N03.FR.01
  }

  /**
   * Put back monitors read from persistence (N07.FR.13), without telling
   * listeners. New ids resume after the highest restored one (N04.FR.19).
   */
  restore(monitors: readonly VariableMonitor[]): void {
    for (const monitor of monitors) {
      this.monitors.set(monitor.id, monitor);
      this.nextId = Math.max(this.nextId, monitor.id + 1);
    }
  }

  get(id: number): VariableMonitor | undefined {
    return this.monitors.get(id);
  }

  /** Every installed monitor, by increasing id. */
  list(): VariableMonitor[] {
    return [...this.monitors.values()].sort((a, b) => a.id - b.id);
  }

  /** Monitors watching the given configuration key, by increasing id. */
  byValueKey(valueKey: string): VariableMonitor[] {
    return this.list().filter((m) => m.valueKey === valueKey);
  }

  /**
   * Highest severity number reported by NotifyEvent (N05.FR.03). The spec
   * gives no default; 9 reports every monitor until the CSMS narrows it.
   */
  get monitoringLevel(): number {
    return this.level;
  }

  /** N05.FR.01 / FR.02: `false` (level unchanged) outside 0-9. */
  setMonitoringLevel(level: number): boolean {
    if (!isValidMonitorSeverity(level)) return false;
    this.level = level;
    this.emit({ kind: "levelChanged", level });
    return true;
  }

  onChange(listener: MonitoringStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: MonitoringStoreEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** `MonitoringBaseEnumType`, the same in 2.0.1 and 2.1. */
const MONITORING_BASES: ReadonlySet<string> = new Set([
  "All",
  "FactoryDefault",
  "HardWiredOnly",
]);

function rejected(reason: InstallRejectionReason): InstallOutcome {
  return { status: "Rejected", reason };
}

function copyComponent(c: MonitorComponent): MonitorComponent {
  return {
    name: c.name,
    ...(c.instance !== undefined && { instance: c.instance }),
    ...(c.evse !== undefined && {
      evse: {
        id: c.evse.id,
        ...(c.evse.connectorId !== undefined && {
          connectorId: c.evse.connectorId,
        }),
      },
    }),
  };
}

function copyVariable(v: MonitorVariable): MonitorVariable {
  return {
    name: v.name,
    ...(v.instance !== undefined && { instance: v.instance }),
  };
}
