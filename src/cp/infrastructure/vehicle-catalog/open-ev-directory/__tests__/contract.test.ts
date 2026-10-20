import { describe, expect, it } from "vitest";

import { profileFromCatalog } from "../../../../domain/vehicle/importProfile";
import { resolveEvSettings } from "../../../../domain/vehicle/VehicleProfile";
import {
  OpenEvDirectoryClient,
  type FetchLike,
} from "../OpenEvDirectoryClient";

import id7Curves from "../__fixtures__/id7GtxChargingCurves.json";
import id7Variant from "../__fixtures__/id7GtxVariant.json";

/**
 * From the published contract examples to the EV settings a connector gets
 * (#458): the adapter, the import and the resolution together, with the
 * variants of the data the issue names (two sources, a missing capacity, an
 * estimated curve, a curve above the DC maximum, no curve).
 */

type Json = typeof id7Variant;
type Curves = typeof id7Curves;

function catalog(variant: Json, curves: Curves) {
  const impl = (async (input: string) => {
    const path = new URL(String(input)).pathname;
    const body = path.endsWith("/charging-curves") ? curves : variant;
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }) satisfies FetchLike;
  return new OpenEvDirectoryClient({
    baseUrl: "https://evd.example.test",
    fetch: impl,
  });
}

const clone = <T>(v: T): T => structuredClone(v);
const GAIA = "gaia:volkswagen-id7-gtx-2024";
const KILOWATT = "kilowatt:2854a132-20b9-4bb1-b18a-fc0fec23a346";
const NOW = "2026-10-11T10:00:00.000Z";

async function importWith(
  variant: Json,
  curves: Curves,
  selection: { sourceRecordKey: string; curveId: string | null },
) {
  const v = await catalog(variant, curves).getVariant(variant.id);
  const result = profileFromCatalog(v, selection, { id: "vp_1", now: NOW });
  if (!result.ok) throw new Error(result.reason);
  return { variant: v, profile: result.profile };
}

describe("Open EV Directory contract (#458)", () => {
  it("offers both sources and both curves, and selects none of them", async () => {
    const v = await catalog(id7Variant, id7Curves).getVariant(id7Variant.id);
    expect(v.sourceRecords).toHaveLength(2);
    expect(v.curves).toHaveLength(2);
    // Neither curve is presented as measured: the contract says UNKNOWN.
    expect(v.curves.every((c) => c.quality === "UNKNOWN")).toBe(true);
  });

  it("imports the Gaia record and curve and resolves them for DC", async () => {
    const { profile } = await importWith(id7Variant, id7Curves, {
      sourceRecordKey: GAIA,
      curveId: "crv_2523855ffac08d0a",
    });
    expect(profile.origin).toMatchObject({
      sourceId: "gaia",
      curveQuality: "UNKNOWN",
      observations: ["ENDS_BELOW_FULL_SOC"],
      datasetVersion: "sha256:b1e424ab58d32fcf",
    });
    expect(profile.origin!.licenses[0]!.attribution).toContain("CC BY-SA 4.0");
    const resolved = resolveEvSettings(profile, "DC");
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(resolved.settings.maxChargingPowerKw).toBe(200);
    expect(resolved.settings.chargingCurve).toHaveLength(10);
    expect(resolved.warnings).toContainEqual({
      code: "CURVE_ENDS_BELOW_FULL_SOC",
      lastSocPercent: 90,
    });
  });

  it("keeps a capacity the source does not give as missing", async () => {
    const variant = clone(id7Variant);
    variant.sourceRecords[1]!.specifications.usableBatteryKwh =
      null as unknown as number;
    const { profile } = await importWith(variant, id7Curves, {
      sourceRecordKey: KILOWATT,
      curveId: "crv_8fb466d59158ccb5",
    });
    expect(profile.specs.usableBatteryKwh).toBeNull();
    expect(resolveEvSettings(profile, "DC")).toEqual({
      ok: false,
      reason: "missing_fields",
      missing: ["usableBatteryKwh"],
    });
  });

  it("keeps an estimated curve labelled as estimated", async () => {
    const curves = clone(id7Curves);
    curves.items[1]!.quality = "ESTIMATED";
    const { profile } = await importWith(id7Variant, curves, {
      sourceRecordKey: KILOWATT,
      curveId: "crv_8fb466d59158ccb5",
    });
    expect(profile.origin!.curveQuality).toBe("ESTIMATED");
  });

  it("keeps every point of a curve above the DC maximum", async () => {
    const variant = clone(id7Variant);
    variant.sourceRecords[0]!.specifications.dcMaxKw = 175;
    const curves = clone(id7Curves);
    curves.items[0]!.observations = [
      "POWER_ABOVE_DC_MAX",
      "ENDS_BELOW_FULL_SOC",
    ];
    const { profile } = await importWith(variant, curves, {
      sourceRecordKey: GAIA,
      curveId: "crv_2523855ffac08d0a",
    });
    const resolved = resolveEvSettings(profile, "DC");
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(resolved.settings.chargingCurve).toHaveLength(10);
    expect(resolved.warnings).toContainEqual({
      code: "POWER_ABOVE_DC_MAX",
      dcMaxKw: 175,
      peakKw: 200,
    });
  });

  it("imports a variant without curves and charges it flat", async () => {
    const curves = clone(id7Curves);
    curves.items = [];
    const { variant, profile } = await importWith(id7Variant, curves, {
      sourceRecordKey: GAIA,
      curveId: null,
    });
    expect(variant.curves).toEqual([]);
    const resolved = resolveEvSettings(profile, "DC");
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(resolved.settings.chargingCurve).toEqual([]);
    expect(resolved.warnings).toContainEqual({ code: "NO_DC_CURVE" });
  });

  it("resolves the AC side from the record", async () => {
    const { profile } = await importWith(id7Variant, id7Curves, {
      sourceRecordKey: GAIA,
      curveId: null,
    });
    const resolved = resolveEvSettings(profile, "AC");
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(resolved.settings).toMatchObject({
      maxChargingPowerKw: 11,
      phases: 3,
      currentType: "AC",
    });
  });
});
