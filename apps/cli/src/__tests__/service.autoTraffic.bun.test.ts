import { afterEach, describe, expect, it } from "bun:test";
import { OCPPStatus } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import {
  AutoTrafficPlanner,
  defaultAutoTrafficConfig,
  type AutoTrafficConfig,
  type AutoTrafficVehicle,
} from "@ocpp-cp-simulator/core/cp/domain/connector/AutoTraffic";
import { CLIChargePointService } from "../service";
import type { ChargePointInitOptions } from "../types";

/**
 * #603: AutoTraffic draws its idTags from the charge point's pool, starts a
 * cycle only on an Accepted charge point and an Available connector without a
 * transaction, and counts the cycles it skips.
 */

const INIT: ChargePointInitOptions = {
  cpId: "cp-traffic",
  wsUrl: "ws://127.0.0.1:65534/never",
  connectors: 1,
  vendor: "v",
  model: "m",
  basicAuth: null,
  idTags: ["TAG-A", "TAG-B", "TAG-C"],
  idTagDistribution: "round-robin",
};

const CONFIG: AutoTrafficConfig = {
  ...defaultAutoTrafficConfig,
  enabled: true,
  seed: 5,
  minGapSec: 0,
  maxGapSec: 0,
  minDurationSec: 1,
  maxDurationSec: 1,
  requireAuthorize: true,
  cpIndex: 0,
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const services: CLIChargePointService[] = [];

/** A service whose charge point records what traffic does, with no network. */
function station(init: ChargePointInitOptions = INIT) {
  const svc = new CLIChargePointService({ ...init });
  services.push(svc);
  const cp = (svc as unknown as { _chargePoint: Record<string, unknown> })
    ._chargePoint;
  (
    cp as unknown as {
      getConnector(id: number): { status: OCPPStatus } | undefined;
    }
  ).getConnector(1)!.status = OCPPStatus.Available;
  const calls: string[] = [];
  let booted = true;
  Object.defineProperty(cp, "bootAccepted", { get: () => booted });
  cp.authorizeAndWait = async (tag: string) => {
    calls.push(`authorize:${tag}`);
    return "Accepted";
  };
  cp.startTransaction = async (tag: string) => {
    calls.push(`start:${tag}`);
    return { started: true };
  };
  cp.stopTransaction = () => {
    calls.push("stop");
  };
  return {
    svc,
    calls,
    setBooted: (value: boolean) => {
      booted = value;
    },
  };
}

afterEach(() => {
  for (const svc of services.splice(0)) svc.cleanup(true);
});

describe("AutoTraffic on a charge point (#603)", () => {
  it("presents the pool's tags, one per session, for Authorize and the start", async () => {
    const { svc, calls } = station();
    svc.setAutoTrafficConfig(1, CONFIG);
    await wait(2_400);
    // Read before turning the traffic off: disabling drops the runner and
    // its counters.
    const counters = { ...svc.getAutoTrafficCounters(1) };
    svc.setAutoTrafficConfig(1, { ...CONFIG, enabled: false });
    expect(calls.slice(0, 5)).toEqual([
      "authorize:TAG-A",
      "start:TAG-A",
      "stop",
      "authorize:TAG-B",
      "start:TAG-B",
    ]);
    expect(counters.authorizeAccepted).toBeGreaterThan(1);
  });

  it("falls back to the fixed idTag without a pool", async () => {
    const { svc, calls } = station({
      ...INIT,
      idTags: undefined,
      idTagDistribution: undefined,
    });
    svc.setAutoTrafficConfig(1, CONFIG);
    await wait(300);
    svc.setAutoTrafficConfig(1, { ...CONFIG, enabled: false });
    expect(calls.slice(0, 2)).toEqual(["authorize:123456", "start:123456"]);
  });

  it("skips cycles while the charge point is not Accepted", async () => {
    const { svc, calls, setBooted } = station();
    setBooted(false);
    svc.setAutoTrafficConfig(1, CONFIG);
    await wait(300);
    const counters = svc.getAutoTrafficCounters(1);
    expect(calls).toEqual([]);
    expect(counters.skipped).toBeGreaterThan(0);
    expect(counters.consecutiveSkips).toBe(counters.skipped);
    expect(counters.started).toBe(0);
    svc.setAutoTrafficConfig(1, { ...CONFIG, enabled: false });
  });

  it("skips cycles while the connector is not Available", async () => {
    const { svc, calls } = station();
    const connector = (
      svc as unknown as {
        _chargePoint: {
          getConnector(id: number): { status: OCPPStatus } | undefined;
        };
      }
    )._chargePoint.getConnector(1)!;
    connector.status = OCPPStatus.Preparing;
    svc.setAutoTrafficConfig(1, CONFIG);
    await wait(300);
    expect(calls).toEqual([]);
    expect(svc.getAutoTrafficCounters(1).skipped).toBeGreaterThan(0);
    svc.setAutoTrafficConfig(1, { ...CONFIG, enabled: false });
  });

  it("counts only the refused start answer once, not a mid-session 2.x refusal", async () => {
    const { svc } = station();
    const cp = (
      svc as unknown as {
        _chargePoint: {
          notifyStartTransactionNotAccepted(
            connectorId: number,
            status: string,
            stopped: boolean,
            midSession?: boolean,
          ): void;
        };
      }
    )._chargePoint;
    svc.setAutoTrafficConfig(1, {
      ...CONFIG,
      minDurationSec: 60,
      maxDurationSec: 60,
    });
    await wait(300);
    try {
      expect(svc.getAutoTrafficCounters(1)).toMatchObject({
        startAccepted: 1,
        startRejected: 0,
      });
      // An Updated refused after the accepted start: not a start refusal.
      cp.notifyStartTransactionNotAccepted(1, "Blocked", false, true);
      expect(svc.getAutoTrafficCounters(1)).toMatchObject({
        startAccepted: 1,
        startRejected: 0,
      });
      // The refused start answer counts, and only once.
      cp.notifyStartTransactionNotAccepted(1, "Invalid", false);
      cp.notifyStartTransactionNotAccepted(1, "Invalid", false);
      expect(svc.getAutoTrafficCounters(1)).toMatchObject({
        startAccepted: 0,
        startRejected: 1,
      });
    } finally {
      svc.setAutoTrafficConfig(1, { ...CONFIG, enabled: false });
    }
  });

  it("rebuilds the idTag stream when the traffic is reconfigured", () => {
    const { svc } = station();
    const pickerOf = () =>
      (
        svc as unknown as {
          _autoTrafficPickers: Map<number, { next(): string } | null>;
        }
      )._autoTrafficPickers.get(1)!;
    svc.setAutoTrafficConfig(1, {
      ...CONFIG,
      minGapSec: 3600,
      maxGapSec: 3600,
    });
    expect([pickerOf().next(), pickerOf().next()]).toEqual(["TAG-A", "TAG-B"]);
    svc.setAutoTrafficConfig(1, {
      ...CONFIG,
      minGapSec: 3600,
      maxGapSec: 3600,
      idTagStrategy: "connector-affinity",
    });
    expect([pickerOf().next(), pickerOf().next()]).toEqual(["TAG-A", "TAG-A"]);
    svc.setAutoTrafficConfig(1, { ...CONFIG, enabled: false });
  });

  it("refuses a stop time that is not an ISO 8601 date-time with an offset", () => {
    const { svc } = station();
    for (const stopAt of ["Nov 9 2026", "2026-11-09", "2026-11-09T10:00:00"]) {
      expect(() => svc.setAutoTrafficConfig(1, { ...CONFIG, stopAt })).toThrow(
        /stopAt/,
      );
    }
    svc.setAutoTrafficConfig(1, {
      ...CONFIG,
      minGapSec: 3600,
      maxGapSec: 3600,
      stopAt: "2099-11-09T10:00:00+09:00",
    });
    svc.setAutoTrafficConfig(1, { ...CONFIG, enabled: false });
  });

  it("refuses an invalid stop time", () => {
    const { svc } = station();
    expect(() =>
      svc.setAutoTrafficConfig(1, { ...CONFIG, stopAt: "later" }),
    ).toThrow(/stopAt/);
  });
});

describe("AutoTraffic vehicle pool on a charge point (#627)", () => {
  const POOL: AutoTrafficVehicle[] = [
    {
      weight: 1,
      profileId: "city-ac",
      vehicle: {
        modelName: "City AC",
        batteryCapacityKwh: 35,
        maxChargingPowerKw: 7,
        currentType: "AC",
        phases: 1,
      },
    },
    {
      weight: 1,
      profileId: "fast-dc",
      vehicle: {
        modelName: "Fast DC",
        batteryCapacityKwh: 90,
        maxChargingPowerKw: 120,
        currentType: "DC",
        chargingCurve: [
          { socPercent: 0, powerFraction: 1 },
          { socPercent: 100, powerFraction: 0.2 },
        ],
      },
    },
  ];

  it("makes the connector the drawn vehicle before each start, in the seeded order", async () => {
    const { svc } = station();
    const cp = (
      svc as unknown as {
        _chargePoint: {
          getConnector(id: number): {
            evSettings: {
              modelName: string;
              batteryCapacityKwh: number;
              maxChargingPowerKw: number;
              currentType?: string;
              chargingCurve?: unknown[];
            };
          };
          startTransaction: (tag: string) => Promise<{ started: boolean }>;
        };
      }
    )._chargePoint;
    const atStart: string[] = [];
    cp.startTransaction = async () => {
      // What the meter model reads at the moment the session begins.
      const ev = cp.getConnector(1).evSettings;
      atStart.push(
        `${ev.modelName}/${ev.batteryCapacityKwh}/${ev.maxChargingPowerKw}/${ev.currentType}/${ev.chargingCurve?.length ?? 0}`,
      );
      return { started: true };
    };
    const config: AutoTrafficConfig = { ...CONFIG, vehiclePool: POOL };
    svc.setAutoTrafficConfig(1, config);
    await wait(3_500);
    const counters = { ...svc.getAutoTrafficCounters(1) };
    svc.setAutoTrafficConfig(1, { ...config, enabled: false });
    expect(atStart.length).toBeGreaterThan(1);

    const planner = new AutoTrafficPlanner(config, "cp-traffic", 1);
    const expected = atStart.map(() => {
      const entry = POOL[planner.next().vehicleIndex!]!.vehicle;
      return `${entry.modelName}/${entry.batteryCapacityKwh}/${entry.maxChargingPowerKw}/${entry.currentType}/${entry.chargingCurve?.length ?? 0}`;
    });
    expect(atStart).toEqual(expected);
    const total = Object.values(counters.vehicles ?? {}).reduce(
      (a, b) => a + b,
      0,
    );
    expect(total).toBe(counters.started);
  });

  it("refuses an invalid pool", () => {
    const { svc } = station();
    expect(() =>
      svc.setAutoTrafficConfig(1, { ...CONFIG, vehiclePool: [] }),
    ).toThrow(/vehiclePool/);
  });
});
