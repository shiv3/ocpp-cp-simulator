/**
 * specs/index.ts -- re-exports the ported spec groups. main.ts builds its
 * own registry (GROUPS/ALL_SPECS/SPECS_BY_TEMPLATE_ID) directly from these
 * group modules; this file exists as the single public entry point for
 * the specs/ directory.
 *
 * AUTHORIZE_SPECS (issue #181's TC_023 Authorize-outcome scenarios) is
 * deliberately NOT folded into main.ts's "all" group -- run-all --parallel
 * stays at its existing 44-scenario baseline; run the 3 authorize specs via
 * `run-all --group authorize` (or `run <template-id>`) as a separate sweep.
 */

export { CORE_SPECS } from "./core";
export { AUTHLIST_RESERVATION_SPECS } from "./authlist-reservation";
export { REMOTETRIGGER_SMARTCHARGING_SPECS } from "./remotetrigger-smartcharging";
export { FIRMWARE_SPECS } from "./firmware";
export { AUTHORIZE_SPECS } from "./authorize";
