// GetReport `componentCriteria` (B08.FR.05, FR.07-FR.10, FR.13, #701),
// evaluated on the report data the Device Model registry yields.
import type { ReportDataType } from "@ocpp-cp-simulator/ocpp/types/v201/notify-report";

export type ComponentCriterion = "Active" | "Available" | "Enabled" | "Problem";

/** The component of a report row: name, EVSE and connector. */
function componentKey(rd: ReportDataType): string {
  const { name, evse } = rd.component;
  return `${name}/${evse?.id ?? ""}/${evse?.connectorId ?? ""}`;
}

/**
 * The rows of the components that satisfy at least one criterion (B08.FR.13
 * ORs them). `Active`, `Available` and `Enabled` hold for a component that
 * has no variable of that name (B08.FR.07-09) or whose variable is `true`;
 * `Problem` holds only for a component whose `Problem` variable is `true`
 * (B08.FR.10). All rows of a satisfying component are kept; narrowing to
 * `componentVariable` is a separate, ANDed step.
 */
export function filterByComponentCriteria(
  reportData: readonly ReportDataType[],
  criteria: readonly ComponentCriterion[],
): ReportDataType[] {
  const flags = new Map<string, Map<string, boolean[]>>();
  for (const rd of reportData) {
    const key = componentKey(rd);
    const byName = flags.get(key) ?? new Map<string, boolean[]>();
    const values = byName.get(rd.variable.name) ?? [];
    values.push(rd.variableAttribute[0]?.value === "true");
    byName.set(rd.variable.name, values);
    flags.set(key, byName);
  }
  const holds = (key: string, criterion: ComponentCriterion): boolean => {
    const values = flags.get(key)?.get(criterion);
    if (criterion === "Problem") return values?.some(Boolean) === true;
    return values === undefined || values.some(Boolean);
  };
  return reportData.filter((rd) => {
    const key = componentKey(rd);
    return criteria.some((c) => holds(key, c));
  });
}
