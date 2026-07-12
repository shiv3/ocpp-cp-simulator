/**
 * spec-types.ts -- the shape a scenario spec (port of specs/<id>.spec.sh)
 * takes in the TypeScript runner. Task 1 wires two specs directly in
 * main.ts against this shape; Task 2 grows a specs/ directory of these.
 */

import type { AssertRecorder } from "./assert";
import type { Frame } from "./ocpp";
import type { SimProcess } from "./sim";
import type { SteveOps, SteveTx } from "./steve";

export interface DriveContext {
  cpId: string;
  connector: number;
  sim: SimProcess;
  /** Whichever SteveOps driver main.ts selected for this run
   *  (STEVE_DRIVER=api|ui, default api) -- see steve.ts's SteveOps for
   *  the (deliberately narrow) method surface specs may rely on. */
  steve: SteveOps;
  /** Whichever SteveTx driver main.ts selected for this run
   *  (STEVE_DRIVER=api|ui, default api, same flag as `steve` above) --
   *  see steve.ts's SteveTx for the transaction/reservation-assertion
   *  method surface specs may rely on (issue #184 Task 3). */
  db: SteveTx;
}

export interface AssertContext<D> {
  cpId: string;
  connector: number;
  /** Every parsed OCPP-J frame from the run, uniqueId-correlatable via
   *  ocpp.ts's findCall/findResponseFor. */
  frames: readonly Frame[];
  /** Every raw stdout line from the run (structured JSON events + plain
   *  Logger lines), for checks that aren't about a specific OCPP frame
   *  (scenario lifecycle events, boot-gate-suppression absence, ...). */
  lines: readonly string[];
  rec: AssertRecorder;
  db: SteveTx;
  /** Whatever `drive()` returned (e.g. a DB baseline captured before
   *  triggering a CSMS op), threaded through for a later negative check. */
  driveState: D;
}

export interface ScenarioSpec<D = void> {
  templateId: string;
  description?: string;
  /** Connector to run the scenario template on. Default 1. */
  connector?: number;
  /** Seconds to wait after `connect` before running the scenario template
   *  (past BootNotification.conf) -- mirrors lib.sh's SPEC_BOOT_WAIT. */
  bootWaitSecs?: number;
  /** Seconds to hold the sim open after triggering the scenario, for the
   *  scenario + any drive() traffic to finish -- mirrors SPEC_HOLD_SECS. */
  holdSecs?: number;
  /** Runs concurrently with the sim's scenario execution, for scenarios
   *  that need CSMS-side operator action (steve_op equivalent). Its
   *  return value is threaded into assert() as `driveState`. Omitted
   *  entirely for CP-only scenarios that just need to be watched. */
  drive?: (ctx: DriveContext) => Promise<D>;
  /** Runs once against the full captured frame/line list + driveState. */
  assert: (ctx: AssertContext<D>) => Promise<void> | void;
}
