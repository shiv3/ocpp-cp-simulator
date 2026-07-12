/**
 * specs/index.ts -- re-exports the ported spec groups. main.ts builds its
 * own registry (GROUPS/ALL_SPECS/SPECS_BY_TEMPLATE_ID) directly from these
 * four group modules; this file exists as the single public entry point for
 * the specs/ directory.
 */

export { CORE_SPECS } from "./core";
export { AUTHLIST_RESERVATION_SPECS } from "./authlist-reservation";
export { REMOTETRIGGER_SMARTCHARGING_SPECS } from "./remotetrigger-smartcharging";
export { FIRMWARE_SPECS } from "./firmware";
