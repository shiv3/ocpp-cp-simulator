/**
 * specs/index.ts -- re-exports the ported spec groups. main.ts builds its
 * own registry (GROUPS/ALL_SPECS/SPECS_BY_TEMPLATE_ID) directly from
 * specs/core.ts and specs/authlist-reservation.ts (plus the not-yet-grouped
 * cert16-tc026 scenario it still owns); this file exists as the single
 * public entry point for the specs/ directory so future groups (Task 3:
 * remotetrigger-smartcharging, firmware) only need to add one export here.
 */

export { CORE_SPECS } from "./core";
export { AUTHLIST_RESERVATION_SPECS } from "./authlist-reservation";
