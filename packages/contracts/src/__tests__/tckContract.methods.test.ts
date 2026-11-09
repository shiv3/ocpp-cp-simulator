import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { METHODS } from "../methods";

// The parameter shapes of the commands open-ocpp-tck sends (#346; the list is
// in docs/entities/cli.md, "TCK contract"). JSON Lines mode ignores keys it
// does not know, so a renamed parameter would not fail the TCK's calls, it
// would silently stop having an effect. This pins each command's parameter
// keys and which of them are optional, so a rename, a removal or an optional
// parameter turning required fails here. The rule (#346): required keys and
// existing keys must not change; a NEW key must be optional. Adding an
// OPTIONAL parameter is allowed: add it to the entry and docs/entities/cli.md
// (`idTokenType` of authorize / start_transaction came in with #672). Do not
// edit an entry to make a rename or a removal pass; add an alias and keep the
// old key (cli.md rules).

/** `[key, "required" | "optional"]` for every key of a command's params. */
function shape(command: keyof typeof METHODS): Array<[string, string]> {
  const params = METHODS[command].params as unknown as z.ZodObject;
  return Object.entries(params.shape)
    .map(([key, schema]): [string, string] => [
      key,
      (schema as z.ZodType).safeParse(undefined).success
        ? "optional"
        : "required",
    ])
    .sort(([a], [b]) => a.localeCompare(b));
}

const TCK_COMMANDS = {
  connect: [],
  status: [],
  heartbeat: [],
  authorize: [
    ["idTokenType", "optional"],
    ["tagId", "optional"],
  ],
  start_transaction: [
    ["chargingState", "optional"],
    ["connector", "required"],
    ["idTokenType", "optional"],
    ["tagId", "optional"],
    ["triggerReason", "optional"],
  ],
  stop_transaction: [
    ["connector", "required"],
    ["reason", "optional"],
    ["triggerReason", "optional"],
  ],
  send_meter_value: [
    ["connector", "required"],
    ["context", "optional"],
  ],
  transaction_event: [
    ["chargingState", "optional"],
    ["connector", "required"],
    ["context", "optional"],
    ["meterValues", "optional"],
    ["triggerReason", "required"],
  ],
  load_scenario_template: [
    ["connector", "required"],
    ["evSettings", "optional"],
    ["templateId", "required"],
  ],
  run_scenario_template: [
    ["connector", "required"],
    ["evSettings", "optional"],
    ["once", "optional"],
    ["strict", "optional"],
    ["templateId", "required"],
  ],
  get_scenario: [
    ["connector", "required"],
    ["scenarioId", "required"],
  ],
  remove_scenario: [
    ["connector", "required"],
    ["scenarioId", "required"],
  ],
  // `file` or `scenario`: one of the two is required (a refinement), the TCK
  // sends `scenario`.
  load_scenario: [
    ["connector", "required"],
    ["file", "optional"],
    ["scenario", "optional"],
  ],
  run_scenario: [
    ["awaitArmed", "optional"],
    ["connector", "required"],
    ["scenarioId", "required"],
    ["strict", "optional"],
  ],
} as const satisfies Record<string, ReadonlyArray<readonly [string, string]>>;

describe("TCK contract: parameter keys of the commands the TCK sends (#346)", () => {
  it.each(Object.entries(TCK_COMMANDS))("%s", (command, expected) => {
    expect(shape(command as keyof typeof METHODS)).toEqual(
      expected.map((e) => [...e]),
    );
  });

  it("accepts the TCK's own parameters, with its non-default values", () => {
    const ok = (command: keyof typeof METHODS, params: unknown): void => {
      const r = METHODS[command].params.safeParse(params);
      expect(r.success, JSON.stringify(r)).toBe(true);
    };
    ok("send_meter_value", { connector: 1, context: "Sample.Clock" });
    ok("stop_transaction", { connector: 1, reason: "EVDisconnected" });
    ok("start_transaction", {
      connector: 1,
      tagId: "T",
      triggerReason: "CablePluggedIn",
      chargingState: "EVConnected",
    });
    ok("run_scenario_template", {
      connector: 1,
      templateId: "cert16-tc001-cold-boot",
      once: true,
    });
  });
});
