import { describe, expect, it } from "vitest";

import { EXPLICIT_METHODS, METHODS } from "../methods";
import { isRpcMethod } from "../index";

// The authoritative jsonMode command ids (the `case "..."` labels in
// src/cli/jsonMode.ts), kept HARD-CODED here on purpose (Step 3c): a runtime
// parse of the switch would be fragile. `set_soc_meter_sync` is included
// because Task 3 adds it to jsonMode. `get_composite_schedule` is intentionally
// ABSENT — it is a CSMS-originated INBOUND OCPP request, not an outbound
// simulator command.
const JSONMODE_COMMAND_IDS = [
  "connect",
  "disconnect",
  "status",
  "start_transaction",
  "stop_transaction",
  "set_meter_value",
  "send_meter_value",
  "heartbeat",
  "diagnostics_status_notification",
  "firmware_status_notification",
  "security_event_notification",
  "sign_certificate",
  "start_heartbeat",
  "stop_heartbeat",
  "authorize",
  "update_connector_status",
  "list_scenario_templates",
  "load_scenario_template",
  "load_scenario",
  "list_scenarios",
  "run_scenario",
  "scenario_status",
  "get_scenario",
  "stop_scenario",
  "step_scenario",
  "stop_all_scenarios",
  "remove_scenario",
  "run_scenario_file",
  "run_scenario_template",
  "set_ev_settings",
  "get_ev_settings",
  "set_auto_meter_config",
  "get_auto_meter_config",
  "set_auto_reset_to_available",
  "set_mode",
  "set_soc",
  "set_soc_meter_sync",
  "get_charging_profiles",
  "remove_connector",
  "get_state_history",
] as const;

describe("method table coverage (Step 3c)", () => {
  it("covers every jsonMode command id", () => {
    for (const id of JSONMODE_COMMAND_IDS) {
      expect(
        METHODS[id as keyof typeof METHODS],
        `missing method ${id}`,
      ).toBeDefined();
    }
  });

  it("includes all explicit non-jsonMode ops", () => {
    for (const id of EXPLICIT_METHODS) {
      expect(METHODS[id]).toBeDefined();
    }
    expect(EXPLICIT_METHODS).toHaveLength(11);
  });

  it("contains exactly the jsonMode ids + the explicit ops (no drift)", () => {
    const keys = Object.keys(METHODS).sort();
    const expected = [...JSONMODE_COMMAND_IDS, ...EXPLICIT_METHODS].sort();
    expect(keys).toEqual(expected);
  });

  it("excludes get_composite_schedule (inbound-only, not a command)", () => {
    expect(
      (METHODS as Record<string, unknown>).get_composite_schedule,
    ).toBeUndefined();
    expect(isRpcMethod("get_composite_schedule")).toBe(false);
  });

  it("includes set_soc_meter_sync (Comp-1)", () => {
    expect(METHODS.set_soc_meter_sync).toBeDefined();
    expect(isRpcMethod("set_soc_meter_sync")).toBe(true);
  });
});

describe("connector-0 per-command rule (PB3)", () => {
  it("update_connector_status accepts connector 0", () => {
    expect(
      METHODS.update_connector_status.params.safeParse({
        connector: 0,
        status: "Available",
      }).success,
    ).toBe(true);
  });

  it("update_connector_status preserves status notification option params", () => {
    const parsed = METHODS.update_connector_status.params.safeParse({
      connector: 1,
      status: "Faulted",
      errorCode: "EVCommunicationError",
      info: "pilot lost",
      vendorErrorCode: "E-42",
      vendorId: "Vendor",
      timestamp: "2026-01-02T03:04:05.000Z",
      suppressChargingStateTransactionEvent: true,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({
      connector: 1,
      status: "Faulted",
      errorCode: "EVCommunicationError",
      info: "pilot lost",
      vendorErrorCode: "E-42",
      vendorId: "Vendor",
      timestamp: "2026-01-02T03:04:05.000Z",
      suppressChargingStateTransactionEvent: true,
    });
  });

  it("other connector commands reject connector 0", () => {
    expect(
      METHODS.start_transaction.params.safeParse({ connector: 0, tagId: "T" })
        .success,
    ).toBe(false);
    expect(
      METHODS.set_meter_value.params.safeParse({ connector: 0, value: 1 })
        .success,
    ).toBe(false);
    expect(
      METHODS.run_scenario.params.safeParse({ connector: 0, scenarioId: "s" })
        .success,
    ).toBe(false);
  });

  it("connector commands accept connector >= 1", () => {
    expect(
      METHODS.start_transaction.params.safeParse({ connector: 1, tagId: "T" })
        .success,
    ).toBe(true);
  });
});

describe("DoS limits (Sec-4)", () => {
  it("rejects an oversized string param", () => {
    expect(
      METHODS.start_transaction.params.safeParse({
        connector: 1,
        tagId: "a".repeat(70_000),
      }).success,
    ).toBe(false);
  });

  it("cp.list result caps the array at 1000", () => {
    const item = {
      wsUrl: "ws://h",
      connectors: 1,
      vendor: "v",
      model: "m",
      basicAuth: null,
      bootNotification: null,
      cpId: "c",
      status: "Available",
    };
    expect(
      METHODS["cp.list"].result.safeParse(new Array(1000).fill(item)).success,
    ).toBe(true);
    expect(
      METHODS["cp.list"].result.safeParse(new Array(1001).fill(item)).success,
    ).toBe(false);
  });
});
