import { z } from "zod";
import { STR_64K } from "../limits";
import {
  CONN_POS,
  EMPTY,
  NON_EMPTY_STR,
  ANY,
  OBJ,
  scenarioWaitExtensionSecondsSchema,
  LOADABLE_SCENARIO_OBJ,
} from "../schemas/common";

export const SCENARIO_METHODS = {
  // -- scenarios --
  list_scenario_templates: { params: EMPTY, result: ANY },
  load_scenario_template: {
    params: z.object({
      connector: CONN_POS,
      templateId: NON_EMPTY_STR,
      evSettings: OBJ().optional(),
    }),
    result: ANY,
  },
  load_scenario: {
    params: z
      .object({
        connector: CONN_POS,
        file: STR_64K.optional(),
        scenario: LOADABLE_SCENARIO_OBJ().optional(),
      })
      // #383: refused here rather than by the handler, which answered `internal`.
      .refine((v) => v.file !== undefined || v.scenario !== undefined, {
        message: "load_scenario needs a file or a scenario",
      }),
    result: ANY,
  },
  list_scenarios: { params: z.object({ connector: CONN_POS }), result: ANY },
  run_scenario: {
    params: z.object({
      connector: CONN_POS,
      scenarioId: NON_EMPTY_STR,
      strict: z.boolean().optional(),
      // Opt-in: block the RPC response until the run has either parked on
      // its first expectation (armed — e.g. a RemoteStartTransaction
      // trigger) or ended without ever parking, instead of returning the
      // instant the run is kicked off. Closes the run_scenario /
      // CSMS-command race for a caller that fires the CSMS-initiated call
      // right after run_scenario returns and needs to know the scenario is
      // actually listening first — see CLIChargePointService.waitForScenarioArmed.
      awaitArmed: z.boolean().optional(),
    }),
    result: ANY,
  },
  run_scenario_file: {
    params: z.object({
      connector: CONN_POS,
      file: NON_EMPTY_STR,
      strict: z.boolean().optional(),
    }),
    result: ANY,
  },
  run_scenario_template: {
    params: z.object({
      connector: CONN_POS,
      templateId: NON_EMPTY_STR,
      evSettings: OBJ().optional(),
      strict: z.boolean().optional(),
      // #352: run once — the instance is loaded disabled, so it does not
      // re-arm on the next reconnect. Default: re-arms on every connect.
      once: z.boolean().optional(),
      // Schema 1.13: overrides the template's own maxDurationSeconds.
      maxDurationSeconds: z.number().min(0).max(86_400).optional(),
    }),
    result: ANY,
  },
  scenario_status: {
    params: z.object({ connector: CONN_POS, scenarioId: NON_EMPTY_STR }),
    result: ANY,
  },
  // #179 Phase 3: the machine-readable per-run certification report
  // (verdict + assertion results + correlated transcript + state snapshots).
  // runId omitted → latest run for the scenario. `format` is single-valued
  // for now (JUnit is a later phase); kept as an enum so adding it is trivial.
  scenario_report: {
    params: z.object({
      connector: CONN_POS,
      scenarioId: NON_EMPTY_STR,
      runId: NON_EMPTY_STR.optional(),
      format: z.enum(["json"]).optional(),
    }),
    result: ANY,
  },
  get_scenario: {
    params: z.object({ connector: CONN_POS, scenarioId: NON_EMPTY_STR }),
    result: ANY,
  },
  stop_scenario: {
    params: z.object({ connector: CONN_POS, scenarioId: NON_EMPTY_STR }),
    result: ANY,
  },
  scenario_reset: {
    params: z.object({ connector: CONN_POS, scenarioId: NON_EMPTY_STR }),
    result: ANY,
  },
  step_scenario: {
    params: z.object({
      connector: CONN_POS,
      scenarioId: NON_EMPTY_STR,
      force: z.boolean().optional(),
    }),
    result: ANY,
  },
  // #240: controls on the wait a running scenario is parked on.
  extend_scenario_wait: {
    params: z.object({
      connector: CONN_POS,
      scenarioId: NON_EMPTY_STR,
      seconds: scenarioWaitExtensionSecondsSchema,
    }),
    result: ANY,
  },
  retry_scenario_wait: {
    params: z.object({ connector: CONN_POS, scenarioId: NON_EMPTY_STR }),
    result: ANY,
  },
  continue_scenario_wait: {
    params: z.object({ connector: CONN_POS, scenarioId: NON_EMPTY_STR }),
    result: ANY,
  },
  stop_all_scenarios: {
    params: z.object({ connector: CONN_POS }),
    result: ANY,
  },
  remove_scenario: {
    params: z.object({ connector: CONN_POS, scenarioId: NON_EMPTY_STR }),
    result: ANY,
  },
} satisfies Record<string, { params: z.ZodTypeAny; result: z.ZodTypeAny }>;
