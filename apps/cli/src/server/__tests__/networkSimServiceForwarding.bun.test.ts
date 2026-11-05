import { afterEach, describe, expect, it } from "bun:test";
import type { ChargePointInitOptions } from "../../types";
import { CLIChargePointService } from "../../service";

function cpInit(cpId: string, connectors = 1): ChargePointInitOptions {
  return {
    cpId,
    wsUrl: "ws://example.test/ocpp",
    connectors,
    vendor: "TestVendor",
    model: "TestModel",
    ocppVersion: "OCPP-1.6J",
    basicAuth: null,
  };
}

const services: CLIChargePointService[] = [];

afterEach(() => {
  for (const svc of services) {
    svc.cleanup();
  }
  services.length = 0;
});

describe("CLIChargePointService NetworkSim forwarding", () => {
  it("setNetworkSimConfig forwards to ChargePoint", () => {
    const svc = new CLIChargePointService(cpInit("cp-1"), null);
    services.push(svc);

    // Create a resolved config
    const resolved = {
      enabled: true,
      seed: 123,
      rules: {
        latency: {
          type: "latency" as const,
          direction: "both" as const,
          delayMs: 100,
        },
      },
    };

    // Should not throw
    expect(() => {
      svc.setNetworkSimConfig(resolved);
    }).not.toThrow();
  });

  it("triggerNetworkSimDisconnect forwards to ChargePoint", () => {
    const svc = new CLIChargePointService(cpInit("cp-2"), null);
    services.push(svc);

    // Call the method - it should forward to ChargePoint
    const result = svc.triggerNetworkSimDisconnect("rule-1");

    // The result should be an object with ok and possibly error
    expect(result).toBeDefined();
    expect(typeof result.ok).toBe("boolean");
  });

  it("reset forwards to ChargePoint", () => {
    const svc = new CLIChargePointService(cpInit("cp-3"), null);
    services.push(svc);

    // Should not throw
    expect(() => {
      svc.reset();
    }).not.toThrow();
  });

  it("isSoapChargePoint returns correct value", () => {
    const wsSvc = new CLIChargePointService(cpInit("ws-cp"), null);
    services.push(wsSvc);

    // WebSocket CP should not be SOAP
    expect(wsSvc.isSoapChargePoint()).toBe(false);

    const soapSvc = new CLIChargePointService(
      {
        ...cpInit("soap-cp"),
        ocppVersion: "OCPP-1.5",
        soapCallbackUrl: "http://example.test/callback",
      },
      null,
    );
    services.push(soapSvc);

    // SOAP CP should be SOAP
    expect(soapSvc.isSoapChargePoint()).toBe(true);
  });

  it("cleanup with permanent=true succeeds", () => {
    const svc = new CLIChargePointService(cpInit("cp-4"), null);

    // Call cleanup with permanent=true
    expect(() => {
      svc.cleanup(true);
    }).not.toThrow();
  });

  it("cleanup with permanent=false succeeds", () => {
    const svc = new CLIChargePointService(cpInit("cp-5"), null);
    services.push(svc);

    // Call cleanup with permanent=false
    expect(() => {
      svc.cleanup(false);
    }).not.toThrow();
  });

  it("cleanup defaults to permanent=false", () => {
    const svc = new CLIChargePointService(cpInit("cp-6"), null);
    services.push(svc);

    // Call cleanup without parameter
    expect(() => {
      svc.cleanup();
    }).not.toThrow();
  });
});
