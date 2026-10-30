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
    method: "send_ocpp_call",
    valid: { action: "Heartbeat", payload: {} },
    field: "action",
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
    method: "get_15118_ev_certificate",
    valid: {
      iso15118SchemaVersion: "v",
      action: "Install",
      exiRequest: "AA==",
    },
    field: "iso15118SchemaVersion",
  },
  {
    method: "get_15118_ev_certificate",
    valid: {
      iso15118SchemaVersion: "v",
      action: "Install",
      exiRequest: "AA==",
    },
    field: "exiRequest",
  },
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
  {
    method: "cp.labels.set",
    valid: { cpId: "CP", labels: {} },
    field: "cpId",
  },
  { method: "logs.get", valid: { cpId: "CP" }, field: "cpId" },
  { method: "logs.clear", valid: { cpId: "CP" }, field: "cpId" },
  { method: "timeline.get", valid: { cpId: "CP" }, field: "cpId" },
  {
    method: "timeline.get",
    valid: { cpId: "CP", runId: "r" },
    field: "runId",
  },
  {
    method: "timeline.get",
    valid: { cpId: "CP", incidentId: "i" },
    field: "incidentId",
  },
  { method: "sessions.list", valid: { cpId: "CP" }, field: "cpId" },
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

// #452: the seed's identifiers are nested in `entries`, out of the table's
// reach.
describe("seed_auth_cache entries (#452)", () => {
  it.each(["idToken", "parentId"])("refuses an empty %s", (field) => {
    const params = METHODS.seed_auth_cache.params;
    const entry = { idToken: "T", status: "Accepted", parentId: "P" };
    expect(params.safeParse({ entries: [entry] }).success).toBe(true);
    expect(
      params.safeParse({ entries: [{ ...entry, [field]: "" }] }).success,
    ).toBe(false);
  });
});

// #537: the EMAIDs are nested in an array, out of the table's reach.
describe("get_15118_ev_certificate prioritizedEMAIDs (#537)", () => {
  it("refuses an empty EMAID", () => {
    const params = METHODS.get_15118_ev_certificate.params;
    const valid = {
      iso15118SchemaVersion: "v",
      action: "Install",
      exiRequest: "AA==",
    };
    expect(
      params.safeParse({ ...valid, prioritizedEMAIDs: ["E"] }).success,
    ).toBe(true);
    expect(
      params.safeParse({ ...valid, prioritizedEMAIDs: [""] }).success,
    ).toBe(false);
  });
});
