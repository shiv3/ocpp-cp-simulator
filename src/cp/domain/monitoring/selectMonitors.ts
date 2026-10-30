import type {
  MonitorComponent,
  MonitorVariable,
  SupportedMonitorType,
  VariableMonitor,
} from "./VariableMonitor";

/** A GetMonitoringReport componentVariable; a missing field matches all. */
export interface MonitorTargetSelector {
  readonly component: MonitorComponent;
  readonly variable?: MonitorVariable;
}

export interface MonitorSelection {
  /** Keep only these types (from monitoringCriteria); absent = all. */
  readonly types?: ReadonlySet<SupportedMonitorType>;
  /** Keep only monitors matching one selector; absent or empty = all. */
  readonly targets?: readonly MonitorTargetSelector[];
}

/**
 * GetMonitoringReport selection (N02.FR.05, FR.06, FR.08, FR.11): both
 * filters apply when present. Within a selector, a missing variable,
 * instance, evse or connectorId is a wildcard (N02.FR.16–FR.21).
 */
export function selectMonitors(
  monitors: readonly VariableMonitor[],
  selection: MonitorSelection,
): VariableMonitor[] {
  const { types, targets } = selection;
  return monitors.filter(
    (m) =>
      (types === undefined || types.has(m.type)) &&
      (targets === undefined ||
        targets.length === 0 ||
        targets.some((t) => matchesComponentVariable(m, t))),
  );
}

/**
 * Whether a component/variable pair falls under a componentVariable
 * selector: the component name must match, and a missing variable,
 * instance, evse or connectorId is a wildcard. The same rule selects
 * monitors (N02.FR.16–FR.21) and GetReport variables (B08.FR.20–FR.25).
 */
export function matchesComponentVariable(
  target: {
    readonly component: MonitorComponent;
    readonly variable: MonitorVariable;
  },
  selector: MonitorTargetSelector,
): boolean {
  const c = selector.component;
  if (c.name !== target.component.name) return false;
  if (c.instance !== undefined && c.instance !== target.component.instance) {
    return false;
  }
  if (c.evse !== undefined) {
    if (c.evse.id !== target.component.evse?.id) return false;
    if (
      c.evse.connectorId !== undefined &&
      c.evse.connectorId !== target.component.evse?.connectorId
    ) {
      return false;
    }
  }
  const v = selector.variable;
  if (v === undefined) return true;
  if (v.name !== target.variable.name) return false;
  return v.instance === undefined || v.instance === target.variable.instance;
}
