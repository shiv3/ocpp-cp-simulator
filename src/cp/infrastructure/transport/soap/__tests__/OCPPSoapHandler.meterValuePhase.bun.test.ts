import { describe, expect, it } from "bun:test";

import { OCPPSoapHandler } from "../OCPPSoapHandler";
import { Logger } from "../../../../shared/Logger";
import type { ChargePoint } from "../../../../domain/charge-point/ChargePoint";

/**
 * Regression for #301 finding 1 on OCPP 1.5 SOAP: unlike 1.6-J/1.6-S and
 * 2.0.1/2.1, OCPP 1.5's SampledValue has no `phase` attribute at all. A
 * 3-phase AC connector's per-phase L1/L2/L3 samples must therefore be
 * dropped rather than sent as indistinguishable duplicates of the
 * aggregate — only the aggregate (unphased) sample should reach the wire.
 */

const CSMS_URL = "http://csms.example/CentralSystemService";

/** The slice of `Connector` `buildSampledValues` reads. */
function threePhaseConnectorStub(): unknown {
  return {
    status: "Charging",
    soc: 50,
    meterValue: 1000,
    transaction: null,
    evSettings: {
      modelName: "Test EV",
      batteryCapacityKwh: 75,
      maxChargingPowerKw: 22,
      initialSoc: 20,
      targetSoc: 80,
      currentType: "AC",
      phases: 3,
      voltageV: 230,
    },
    currentScheduleLimitWatts: () => Infinity,
  };
}

function createMockChargePoint(connector: unknown): ChargePoint {
  return {
    id: "test-cp",
    getConnector: () => connector,
    notifyOutgoingCall: () => {},
    error: undefined,
    events: { emit: () => {} },
    configuration: {
      meterValuesSampledData: () => ["Current.Import"],
    },
  } as unknown as ChargePoint;
}

function createMockLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as Logger;
}

/** Captures the outgoing SOAP request body without a real HTTP round trip. */
function mockFetchCapturingBody(): {
  bodies: string[];
  restore: () => void;
} {
  const bodies: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    bodies.push(String(init?.body ?? ""));
    // A generic, near-empty Accepted-shaped response is enough — this test
    // only cares about what was sent, not how the response is parsed.
    return new Response(
      '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body/></soap:Envelope>',
      { headers: { "Content-Type": "text/xml" } },
    );
  }) as typeof fetch;
  return {
    bodies,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("OCPPSoapHandler.sendMeterValue on OCPP 1.5 (#301)", () => {
  it("drops per-phase L1/L2/L3 samples, keeping only the aggregate", async () => {
    const fetchMock = mockFetchCapturingBody();
    try {
      const mockChargePoint = createMockChargePoint(threePhaseConnectorStub());
      const handler = new OCPPSoapHandler(mockChargePoint, createMockLogger(), {
        centralSystemUrl: CSMS_URL,
      });
      handler.setBootStatus({ status: "Accepted" });

      handler.sendMeterValue(1, 1);
      // enqueueRequest chains onto a promise; let the microtask queue drain.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchMock.bodies.length).toBe(1);
      const body = fetchMock.bodies[0]!;
      // No phase attribute exists on OCPP 1.5's SampledValue at all, and no
      // L1/L2/L3 duplicate should have leaked through.
      expect(body).not.toContain("L1");
      expect(body).not.toContain("L2");
      expect(body).not.toContain("L3");
      // Exactly one Current.Import sample (the aggregate) must remain — not
      // four indistinguishable copies.
      const matches = body.match(/measurand="Current\.Import"/g) ?? [];
      expect(matches.length).toBe(1);
    } finally {
      fetchMock.restore();
    }
  });
});
