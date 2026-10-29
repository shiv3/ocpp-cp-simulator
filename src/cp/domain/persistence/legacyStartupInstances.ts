/**
 * Instance ids older daemon builds generated with the clock in them (#338).
 *
 * Two shapes, both recognised exactly as the code that minted them wrote
 * them, and both anchored on a 13-or-more-digit epoch so a plausible
 * hand-picked id does not match:
 *
 * - `--scenario` / `--scenario-template-file` fanned out, through `0f6f951`:
 *   `<base>-c<connector>-<epoch ms>`;
 * - a built-in template instance, through v0.9.0:
 *   `<templateId>-<cpId>-c<connector>-<epoch ms>-<base36 suffix>`.
 *
 * The schema v18 migration records such a row as
 * `startup_source = 'legacy:<base>'`, where `<base>` is the file's or the
 * template's own id. The daemon's one startup prune removes it on the first
 * boot whose flags install its successor on the same connector — the stable
 * `<base>-c<connector>`, or `<base>` itself — which is when the builds that
 * minted it removed it too. A legacy row nothing replaces (a charge point's
 * seeded default, a template loaded over the control plane) stays.
 */
export const LEGACY_STARTUP_SOURCE_PREFIX = "legacy:";

/** The base id a legacy generated instance was minted from, or `null` when
 *  `scenarioId` is not one. */
export function legacyGeneratedBaseId(
  cpId: string,
  connectorId: number,
  scenarioId: string,
): string | null {
  const template = new RegExp(
    `^(.+)-${escapeRegExp(cpId)}-c${connectorId}-\\d{13,}-[0-9a-z]+$`,
  ).exec(scenarioId);
  if (template) return template[1]!;
  const file = new RegExp(`^(.+)-c${connectorId}-\\d{13,}$`).exec(scenarioId);
  if (file) return file[1]!;
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
