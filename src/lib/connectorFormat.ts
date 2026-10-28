/**
 * Display formatting for a connector's live readings, shared by the classic
 * connector UI and the web console card so they cannot drift (issue #368).
 */

/** A connector meter value, which is in Wh, as kWh with 2 decimals. */
export function formatEnergyKwh(wh: number): string {
  return `${(wh / 1000).toFixed(2)} kWh`;
}

/** A charging session's length: "12 m 40 s" under an hour, "2 h 41 m"
 *  above. */
export function formatSessionDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h} h ${m} m` : `${m} m ${String(s).padStart(2, "0")} s`;
}

/** A state of charge as a percentage with 1 decimal. */
export function formatSoc(soc: number): string {
  return `${soc.toFixed(1)}%`;
}
