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
        targets.some((t) => matches(m, t))),
  );
}

function matches(m: VariableMonitor, t: MonitorTargetSelector): boolean {
  const c = t.component;
  if (c.name !== m.component.name) return false;
  if (c.instance !== undefined && c.instance !== m.component.instance) {
    return false;
  }
  if (c.evse !== undefined) {
    if (c.evse.id !== m.component.evse?.id) return false;
    if (
      c.evse.connectorId !== undefined &&
      c.evse.connectorId !== m.component.evse?.connectorId
    ) {
      return false;
    }
  }
  const v = t.variable;
  if (v === undefined) return true;
  if (v.name !== m.variable.name) return false;
  return v.instance === undefined || v.instance === m.variable.instance;
}
