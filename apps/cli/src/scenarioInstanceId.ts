/**
 * The id the daemon gives its per-connector copy of a scenario: a startup
 * flag's instance of a file (`--scenario`, `--scenario-template-file`) and
 * every instance of a built-in template (`loadScenarioTemplate`).
 *
 * **Stable across restarts, deliberately.** These ids used to carry
 * `Date.now()`, which meant a daemon could not recognise its own previous
 * output: with `--state-db`, a restart restored the previous boot's generated
 * instance and then loaded a *second* one under a fresh id, so the operator's
 * single configured scenario became two loaded graphs — the stale one
 * unwatched and able to auto-start alongside the new one (#314).
 *
 * Derived from what is the same across restarts for the same configuration —
 * the file's or template's own id and the connector — so the restored
 * instance and the newly prepared one are the *same key*: `loadScenario`
 * replaces rather than duplicates. A copy left by a configuration no longer
 * in force (another connector, another file id) is a different key; the
 * startup prune removes it through the row's recorded provenance (#338).
 *
 * The cost is a deterministic namespace: a scenario an operator authored under
 * exactly `<id>-c<connector>` on the same charge point is overwritten by the
 * next load of that file or template instead of coexisting with it.
 */
export function scenarioInstanceId(
  baseId: string,
  connectorId: number,
): string {
  return `${baseId}-c${connectorId}`;
}
