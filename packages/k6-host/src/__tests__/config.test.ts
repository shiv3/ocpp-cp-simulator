import { describe, expect, it } from "vitest";
import { k6Options, readFleetConfig } from "../config";

const base = { CSMS_URL: "ws://127.0.0.1:9000/ocpp" };

describe("readFleetConfig", () => {
  it("applies the defaults", () => {
    const c = readFleetConfig(base);
    expect(c).toMatchObject({
      chargers: 10,
      chargersPerVu: 50,
      profile: "steady",
      durationSeconds: 300,
      rampSeconds: 30,
      prefix: "CP-",
      pad: 5,
      offset: 0,
      ocppVersion: "1.6",
    });
  });

  it("reads overrides", () => {
    const c = readFleetConfig({
      ...base,
      CHARGERS: "2000",
      CHARGERS_PER_VU: "100",
      PROFILE: "soak",
      DURATION: "8h",
      SEED: "7",
      BASIC_AUTH_PASSWORD: "pw",
      METER_VALUE_SAMPLE_INTERVAL: "5",
    });
    expect(c).toMatchObject({
      chargers: 2000,
      chargersPerVu: 100,
      profile: "soak",
      durationSeconds: 28800,
      seed: "7",
      basicPassword: "pw",
      meterValueSampleIntervalS: 5,
    });
  });

  it("refuses a missing or non-ws CSMS_URL", () => {
    expect(() => readFleetConfig({})).toThrow(/CSMS_URL/);
    expect(() => readFleetConfig({ CSMS_URL: "http://x" })).toThrow(/ws:\/\//);
  });

  it("refuses other OCPP versions, profiles and bad numbers", () => {
    expect(() => readFleetConfig({ ...base, OCPP_VERSION: "2.0.1" })).toThrow(
      /1\.6J only/,
    );
    expect(() => readFleetConfig({ ...base, PROFILE: "spike" })).toThrow(
      /PROFILE/,
    );
    expect(() => readFleetConfig({ ...base, CHARGERS: "0" })).toThrow(
      /CHARGERS/,
    );
    expect(() => readFleetConfig({ ...base, CHARGERS_PER_VU: "x" })).toThrow(
      /CHARGERS_PER_VU/,
    );
  });
});

describe("k6Options", () => {
  it("runs one iteration per VU and sizes vus from the fleet", () => {
    const o = k6Options(
      readFleetConfig({ ...base, CHARGERS: "120", CHARGERS_PER_VU: "50" }),
      true,
    ) as {
      scenarios: {
        chargers: { vus: number; iterations: number; executor: string };
      };
      thresholds: unknown;
    };
    expect(o.scenarios.chargers).toMatchObject({
      executor: "per-vu-iterations",
      vus: 3,
      iterations: 1,
    });
    expect(o.thresholds).toEqual({ scenario_success: ["rate>0.99"] });
  });
  it("has no threshold without a scenario", () => {
    const o = k6Options(readFleetConfig(base), false);
    expect(o.thresholds).toBeUndefined();
  });
});
