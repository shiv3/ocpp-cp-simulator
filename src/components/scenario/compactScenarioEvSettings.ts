import type { EVSettings } from "../../cp/domain/connector/EVSettings";

/**
 * A scenario's EV settings as saved: empty fields (`undefined`, `null`, `""`)
 * are dropped, since an absent field inherits the connector's value, and a
 * scenario with none left saves no `evSettings` at all rather than `{}`.
 */
export function compactScenarioEvSettings(
  settings: Partial<EVSettings>,
): Partial<EVSettings> | undefined {
  const compact = Object.fromEntries(
    Object.entries(settings).filter(
      ([, v]) => v !== undefined && v !== null && v !== "",
    ),
  ) as Partial<EVSettings>;
  return Object.keys(compact).length > 0 ? compact : undefined;
}
