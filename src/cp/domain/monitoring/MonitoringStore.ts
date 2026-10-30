import {
  isValidMonitorSeverity,
  MAX_MONITOR_SEVERITY,
  isTargetDeltaMonitorType,
  MIN_PERIODIC_INTERVAL_SECONDS,
  monitorBehaviour,
  parseSupportedMonitorType,
  sameMonitorTarget,
  type SupportedMonitorType,
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
  | "SeverityOutOfRange"
  /** Periodic interval under one second (a simulator limit, #538). */
  | "IntervalTooShort"
  /** Negative TargetDelta / TargetDeltaRelative value (#538). */
  | "NegativeTargetDelta";

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
  | { readonly kind: "levelChanged"; readonly level: number }
  | { readonly kind: "baseChanged"; readonly base: MonitoringBase };

export type MonitoringStoreListener = (event: MonitoringStoreEvent) => void;

/** `MonitoringBaseEnumType`, the same in 2.0.1 and 2.1. */
export const MONITORING_BASES = [
  "All",
  "FactoryDefault",
  "HardWiredOnly",
] as const;

export type MonitoringBase = (typeof MONITORING_BASES)[number];

export function parseMonitoringBase(raw: string): MonitoringBase | null {
  return (MONITORING_BASES as readonly string[]).includes(raw)
    ? (raw as MonitoringBase)
    : null;
}

/**
 * In-memory catalog of installed variable monitors plus the monitoring
 * level set by SetMonitoringLevel (N04–N06) and the monitoring base set by
 * SetMonitoringBase (N03). Custom ids are allocated in increasing order,
 * skip the ids of the station's own monitors, and are never reused while
 * the store lives.
 *
 * `catalog` holds the station's hardwired and preconfigured monitors
 * (#538); they are only in the store once {@link initialize} has run.
 */
export class MonitoringStore {
  private readonly monitors = new Map<number, VariableMonitor>();
  private readonly listeners = new Set<MonitoringStoreListener>();
  private readonly catalogIds: ReadonlySet<number>;
  private nextId = 1;
  private level = MAX_MONITOR_SEVERITY;
  private base: MonitoringBase = "All";

  constructor(private readonly catalog: readonly VariableMonitor[] = []) {
    this.catalogIds = new Set(catalog.map((m) => m.id));
  }

  /**
   * Start-up (silent, like {@link restore}): the persisted monitors, the
   * hardwired monitors of the catalog (always theirs, whatever was
   * persisted), and the persisted monitoring base. `activeBase` undefined
   * means the station never stored its catalog state (a first start, or a
   * database from before #538): the preconfigured monitors are activated
   * as under `All`, a persisted monitor with the same id winning.
   */
  initialize(
    persisted: readonly VariableMonitor[],
    activeBase: MonitoringBase | undefined,
  ): void {
    if (activeBase === undefined) {
      for (const monitor of this.preconfigured()) {
        this.monitors.set(monitor.id, monitor);
      }
    }
    this.restore(persisted);
    for (const monitor of this.catalog) {
      if (monitor.origin === "HardWiredMonitor") {
        this.monitors.set(monitor.id, monitor);
      }
    }
    this.base = activeBase ?? "All";
  }

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
    const refusal = checkValue(type, draft);
    if (refusal !== undefined) return refusal;
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
      id: previous?.id ?? this.allocateId(),
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
    this.remove(monitor);
    return "Accepted";
  }

  private remove(monitor: VariableMonitor): void {
    this.monitors.delete(monitor.id);
    this.emit({ kind: "cleared", monitor });
  }

  /** The next free custom id: never a catalog id, even one not active. */
  private allocateId(): number {
    while (this.catalogIds.has(this.nextId) || this.monitors.has(this.nextId)) {
      this.nextId++;
    }
    return this.nextId++;
  }

  private preconfigured(): VariableMonitor[] {
    return this.catalog.filter((m) => m.origin === "PreconfiguredMonitor");
  }

  /**
   * N03 SetMonitoringBase. `All` activates the preconfigured monitors that
   * are not there and keeps every custom monitor, replaced preconfigured
   * ones included (N03.FR.03); `FactoryDefault` deletes every custom
   * monitor, then does the same (N03.FR.04); `HardWiredOnly` deletes the
   * custom and the preconfigured monitors (N03.FR.05). The hardwired
   * monitors stay. Each deletion is reported as `cleared`, each activation
   * as `installed`, then the new base as `baseChanged`.
   */
  applyMonitoringBase(raw: string): "Accepted" | "NotSupported" {
    const base = parseMonitoringBase(raw);
    if (base === null) return "NotSupported"; // N03.FR.02
    for (const monitor of this.list()) {
      const deleted =
        base === "HardWiredOnly"
          ? monitor.origin !== "HardWiredMonitor"
          : base === "FactoryDefault" && monitor.origin === "CustomMonitor";
      if (deleted) this.remove(monitor);
    }
    if (base !== "HardWiredOnly") {
      for (const monitor of this.preconfigured()) {
        if (this.monitors.has(monitor.id)) continue;
        this.monitors.set(monitor.id, monitor);
        this.emit({ kind: "installed", monitor });
      }
    }
    this.base = base;
    this.emit({ kind: "baseChanged", base });
    return "Accepted"; // N03.FR.01
  }

  /** The base last set by SetMonitoringBase; `All` until then. */
  get activeMonitoringBase(): MonitoringBase {
    return this.base;
  }

  /**
   * Put back monitors read from persistence (N07.FR.13), without telling
   * listeners. New ids resume after the highest restored custom id
   * (N04.FR.19); the catalog's ids do not count.
   */
  restore(monitors: readonly VariableMonitor[]): void {
    for (const monitor of monitors) {
      this.monitors.set(monitor.id, monitor);
      if (!this.catalogIds.has(monitor.id)) {
        this.nextId = Math.max(this.nextId, monitor.id + 1);
      }
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

/** N04.FR.05, FR.06, FR.14: the monitor value against its type. */
function checkValue(
  type: SupportedMonitorType,
  draft: MonitorDraft,
): InstallOutcome | undefined {
  switch (monitorBehaviour(type)) {
    case "alert": {
      if (!draft.valueType.numeric) return { status: "UnsupportedMonitorType" };
      if (isTargetDeltaMonitorType(type)) {
        // 2.1 N07.FR.22, FR.23 compare with the Target attribute.
        if (!draft.valueType.hasTarget) {
          return { status: "UnsupportedMonitorType" };
        }
        return draft.value < 0 ? rejected("NegativeTargetDelta") : undefined;
      }
      const { min, max } = draft.valueType;
      if (
        (min !== undefined && draft.value < min) ||
        (max !== undefined && draft.value > max)
      ) {
        return rejected("ValueOutOfRange");
      }
      return undefined;
    }
    case "delta":
      return draft.value < 0 ? rejected("NegativeDelta") : undefined;
    case "periodic":
      // Any variable can be reported periodically (N08); the interval is
      // in seconds.
      return draft.value < MIN_PERIODIC_INTERVAL_SECONDS
        ? rejected("IntervalTooShort")
        : undefined;
  }
}

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
