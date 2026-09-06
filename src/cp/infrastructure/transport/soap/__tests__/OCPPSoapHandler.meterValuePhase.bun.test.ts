import { describe, expect, it } from "bun:test";

import { OCPPSoapHandler } from "../OCPPSoapHandler";
import { Logger } from "../../../../shared/Logger";
import type { ChargePoint } from "../../../../domain/charge-point/ChargePoint";

/**
 * Regressions for #301 on OCPP 1.5 SOAP. Both cover the same rule: OCPP 1.5's
 * SampledValue cannot express something the builder produced, so the sample is
 * dropped rather than emitted as a value a CSMS cannot tell apart from another
 * one in the same MeterValue.
 *
 * 1. Unlike 1.6-J/1.6-S and 2.0.1/2.1, OCPP 1.5's SampledValue has no `phase`
 *    attribute at all, so a 3-phase AC connector's L1/L2/L3 samples are
 *    dropped and only the aggregate (unphased) sample reaches the wire.
 * 2. OCPP 1.5 has no `Power.Offered` / `Current.Offered` measurand. They used
 *    to be aliased onto `Power.Active.Import` / `Current.Import`, which was
 *    harmless only while offered and accepted power were the same number.
 *    Under a charging curve they differ, so the alias would have put two
 *    identically labelled samples with contradictory values into one message.
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
    // Three phases in use: no profile restricts them (#301).
    activePhaseCount: () => 3,
    // One resolve, one instant (#301).
    scheduleConstraints: () => ({ watts: Infinity, activePhases: 3 }),
  };
}

function createMockChargePoint(
  connector: unknown,
  measurands: string[] = ["Current.Import"],
): ChargePoint {
  return {
    id: "test-cp",
    getConnector: () => connector,
    notifyOutgoingCall: () => {},
    error: undefined,
    events: { emit: () => {} },
    configuration: {
      meterValuesSampledData: () => measurands,
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

/**
 * A connector whose battery accepts only a tenth of what the EVSE offers, so
 * `Power.Offered` / `Current.Offered` and `Power.Active.Import` /
 * `Current.Import` carry genuinely different numbers. Without the taper the
 * two pairs would be equal and an aliasing bug would look correct.
 */
function taperedConnectorStub(): unknown {
  return {
    status: "Charging",
    soc: 90,
    meterValue: 1000,
    transaction: null,
    evSettings: {
      modelName: "Test EV",
      batteryCapacityKwh: 75,
      maxChargingPowerKw: 100,
      initialSoc: 20,
      targetSoc: 100,
      currentType: "DC",
      voltageV: 400,
      chargingCurve: [
        { socPercent: 0, powerFraction: 1 },
        { socPercent: 90, powerFraction: 0.1 },
      ],
    },
    currentScheduleLimitWatts: () => Infinity,
    // DC has no phases (#301).
    activePhaseCount: () => 1,
    // One resolve, one instant (#301).
    scheduleConstraints: () => ({ watts: Infinity, activePhases: 1 }),
  };
}

describe("OCPPSoapHandler.sendMeterValue on OCPP 1.5 measurands (#301)", () => {
  it("never emits two samples carrying the same measurand", async () => {
    const fetchMock = mockFetchCapturingBody();
    try {
      const chargePoint = createMockChargePoint(taperedConnectorStub(), [
        "Energy.Active.Import.Register",
        "Power.Active.Import",
        "Power.Offered",
        "Current.Import",
        "Current.Offered",
        "Voltage",
      ]);
      const handler = new OCPPSoapHandler(chargePoint, createMockLogger(), {
        centralSystemUrl: CSMS_URL,
      });
      handler.setBootStatus({ status: "Accepted" });

      handler.sendMeterValue(1, 1);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchMock.bodies.length).toBe(1);
      const body = fetchMock.bodies[0]!;
      const measurands = Array.from(
        body.matchAll(/measurand="([^"]+)"/g),
        (m) => m[1]!,
      );
      // The property itself: no measurand may appear twice in one MeterValue.
      // Aliasing Offered onto Import produced exactly that — two
      // `Power.Active.Import` samples, 100000 and 10000, in the same message.
      expect(measurands.length).toBeGreaterThan(0);
      expect(new Set(measurands).size).toBe(measurands.length);
      // The unsupported Offered samples are dropped, not relabelled: the
      // supported measurands still go out, and only once each.
      expect(measurands).toContain("Power.Active.Import");
      expect(measurands).toContain("Current.Import");
      expect(measurands).not.toContain("Power.Offered");
      expect(measurands).not.toContain("Current.Offered");
      // And the surviving samples are the accepted (curve-limited) numbers,
      // not the EVSE's offer: 100 kW x 0.1 = 10 kW, 10000 W / 400 V = 25 A.
      expect(body).toContain(">10000<");
      expect(body).not.toContain(">100000<");
    } finally {
      fetchMock.restore();
    }
  });
});

describe("OCPPSoapHandler.sendMeterValue on OCPP 1.5 with only unsupported measurands (#301)", () => {
  it("sends nothing rather than an empty MeterValues request", async () => {
    // OCPP 1.5 defines neither Offered measurand, so every sample projects to
    // null and the request would carry an empty `values[].value` list. A 1.5
    // MeterValues.req must have at least one sample, so a conforming CSMS
    // rejects it — an empty request is worse than no request.
    const fetchMock = mockFetchCapturingBody();
    try {
      const chargePoint = createMockChargePoint(taperedConnectorStub(), [
        "Power.Offered",
        "Current.Offered",
      ]);
      const handler = new OCPPSoapHandler(chargePoint, createMockLogger(), {
        centralSystemUrl: CSMS_URL,
      });
      handler.setBootStatus({ status: "Accepted" });

      handler.sendMeterValue(1, 1);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchMock.bodies.length).toBe(0);
    } finally {
      fetchMock.restore();
    }
  });

  it("still sends when at least one configured measurand survives", async () => {
    const fetchMock = mockFetchCapturingBody();
    try {
      const chargePoint = createMockChargePoint(taperedConnectorStub(), [
        "Power.Offered",
        "Current.Offered",
        "Energy.Active.Import.Register",
      ]);
      const handler = new OCPPSoapHandler(chargePoint, createMockLogger(), {
        centralSystemUrl: CSMS_URL,
      });
      handler.setBootStatus({ status: "Accepted" });

      handler.sendMeterValue(1, 1);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchMock.bodies.length).toBe(1);
      expect(fetchMock.bodies[0]!).toContain(
        'measurand="Energy.Active.Import.Register"',
      );
    } finally {
      fetchMock.restore();
    }
  });
});
