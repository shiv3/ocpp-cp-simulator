/**
 * Display formatting for a connector's live readings, shared by the classic
 * connector UI and the web console card so they cannot drift (issue #368).
 */

/** A connector meter value, which is in Wh, as kWh with 2 decimals. */
export function formatEnergyKwh(wh: number): string {
  return `${(wh / 1000).toFixed(2)} kWh`;
}

/** A state of charge as a percentage with 1 decimal. */
export function formatSoc(soc: number): string {
  return `${soc.toFixed(1)}%`;
}
