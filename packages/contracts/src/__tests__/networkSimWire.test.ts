import { describe, expect, it } from "vitest";
import {
  cpListItemSchema,
  registryCpToWire,
  statusToWire,
  statusWireSchema,
} from "../events";

// Task 22: the networkSim summary { enabled, manualRuleIds } | null must ride
// BOTH wire shapes — StatusWire (per-CP status push) and CpListItem (the
// dashboard list cache that the badge reads).

const SUMMARY = { enabled: true, manualRuleIds: ["manual-a", "manual-b"] };

const baseConfig = {
  wsUrl: "ws://localhost/ocpp",
  connectors: 1,
  vendor: "V",
  model: "M",
  basicAuth: null,
  bootNotification: null,
};

describe("network-sim summary on the wire", () => {
  it("statusToWire carries the networkSim summary and it validates", () => {
    const wire = statusToWire({
      id: "CP-1",
      status: "Available",
      error: "",
      connectors: [],
      networkSim: SUMMARY,
    });
    expect(wire.networkSim).toEqual(SUMMARY);
    expect(() => statusWireSchema.parse(wire)).not.toThrow();
  });

  it("statusToWire tolerates a null summary (SOAP / no config)", () => {
    const wire = statusToWire({
      id: "CP-soap",
      status: "Available",
      error: "",
      connectors: [],
      networkSim: null,
    });
    expect(wire.networkSim).toBeNull();
    expect(() => statusWireSchema.parse(wire)).not.toThrow();
  });

  it("registryCpToWire carries the networkSim summary into the CpListItem", () => {
    const item = registryCpToWire({
      id: "CP-1",
      status: "Available",
      config: baseConfig,
      networkSim: SUMMARY,
    });
    expect(item.networkSim).toEqual(SUMMARY);
    expect(() => cpListItemSchema.parse(item)).not.toThrow();
  });

  it("registryCpToWire tolerates an absent summary", () => {
    const item = registryCpToWire({
      id: "CP-2",
      status: "Available",
      config: baseConfig,
    });
    expect(item.networkSim ?? null).toBeNull();
    expect(() => cpListItemSchema.parse(item)).not.toThrow();
  });

  it("cpListItemSchema rejects a malformed summary", () => {
    expect(() =>
      cpListItemSchema.parse({
        cpId: "CP-1",
        status: "Available",
        ...baseConfig,
        networkSim: { enabled: "yes", manualRuleIds: [] },
      }),
    ).toThrow();
  });
});
