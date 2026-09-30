import { describe, expect, it } from "vitest";

import { METHODS } from "../methods";
import type { RpcMethod } from "../index";

// #383: before the daemon handlers read the schema-parsed params, they
// re-narrowed them with `requireString` / `optionalString`, which also refused
// an empty string. That invariant lives in the schemas now. Every field below
// was read through one of those helpers; a new field that names an id, a tag,
// a path or a vendor belongs in this table too.
const NON_EMPTY_FIELDS: ReadonlyArray<{
  method: RpcMethod;
  valid: Record<string, unknown>;
  field: string;
}> = [
  {
    method: "start_transaction",
    valid: { connector: 1, tagId: "T" },
    field: "tagId",
  },
  { method: "authorize", valid: { tagId: "T" }, field: "tagId" },
  {
    method: "data_transfer",
    valid: { vendorId: "acme", messageId: "m" },
    field: "vendorId",
  },
  {
    method: "data_transfer",
    valid: { vendorId: "acme", messageId: "m" },
    field: "messageId",
  },
  {
    method: "security_event_notification",
    valid: { type: "t", techInfo: "i" },
    field: "type",
  },
  {
    method: "security_event_notification",
    valid: { type: "t", techInfo: "i" },
    field: "techInfo",
  },
  { method: "sign_certificate", valid: { csr: "c" }, field: "csr" },
  {
    method: "load_scenario_template",
    valid: { connector: 1, templateId: "t" },
    field: "templateId",
  },
  {
    method: "run_scenario_template",
    valid: { connector: 1, templateId: "t" },
    field: "templateId",
  },
  {
    method: "run_scenario_file",
    valid: { connector: 1, file: "f.json" },
    field: "file",
  },
  {
    method: "run_scenario",
    valid: { connector: 1, scenarioId: "s" },
    field: "scenarioId",
  },
  {
    method: "scenario_status",
    valid: { connector: 1, scenarioId: "s" },
    field: "scenarioId",
  },
  {
    method: "scenario_report",
    valid: { connector: 1, scenarioId: "s", runId: "r" },
    field: "scenarioId",
  },
  {
    method: "scenario_report",
    valid: { connector: 1, scenarioId: "s", runId: "r" },
    field: "runId",
  },
  {
    method: "get_scenario",
    valid: { connector: 1, scenarioId: "s" },
    field: "scenarioId",
  },
  {
    method: "stop_scenario",
    valid: { connector: 1, scenarioId: "s" },
    field: "scenarioId",
  },
  {
    method: "scenario_reset",
    valid: { connector: 1, scenarioId: "s" },
    field: "scenarioId",
  },
  {
    method: "step_scenario",
    valid: { connector: 1, scenarioId: "s" },
    field: "scenarioId",
  },
  {
    method: "extend_scenario_wait",
    valid: { connector: 1, scenarioId: "s", seconds: 30 },
    field: "scenarioId",
  },
  {
    method: "retry_scenario_wait",
    valid: { connector: 1, scenarioId: "s" },
    field: "scenarioId",
  },
  {
    method: "continue_scenario_wait",
    valid: { connector: 1, scenarioId: "s" },
    field: "scenarioId",
  },
  {
    method: "remove_scenario",
    valid: { connector: 1, scenarioId: "s" },
    field: "scenarioId",
  },
  {
    method: "update_connector_status",
    valid: { connector: 1, status: "Available" },
    field: "status",
  },
  {
    method: "set_mode",
    valid: { connector: 1, mode: "manual" },
    field: "mode",
  },
  {
    method: "cp.create",
    valid: { cpId: "CP", wsUrl: "ws://h" },
    field: "cpId",
  },
  {
    method: "cp.update",
    valid: { cpId: "CP", wsUrl: "ws://h" },
    field: "cpId",
  },
  { method: "cp.delete", valid: { cpId: "CP" }, field: "cpId" },
  { method: "logs.get", valid: { cpId: "CP" }, field: "cpId" },
  { method: "logs.clear", valid: { cpId: "CP" }, field: "cpId" },
  { method: "blueprint.delete", valid: { id: "b" }, field: "id" },
];

describe("params that must not be empty strings (#383)", () => {
  it.each(NON_EMPTY_FIELDS)(
    "$method refuses an empty $field",
    ({ method, valid, field }) => {
      const params = METHODS[method].params;
      expect(params.safeParse(valid).success).toBe(true);
      expect(params.safeParse({ ...valid, [field]: "" }).success).toBe(false);
    },
  );
});
