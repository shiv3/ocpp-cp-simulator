import { describe, expect, it } from "vitest";

import type { CatalogCurve, CatalogVariant } from "../VehicleCatalog";
import {
  markRemovedUpstream,
  profileFromCatalog,
  refreshFromCatalog,
} from "../importProfile";

const GAIA_LICENSE = {
  id: "CC-BY-SA-4.0",
  name: "Creative Commons Attribution-ShareAlike 4.0 International",
  url: "https://creativecommons.org/licenses/by-sa/4.0/",
  attribution: "Contains data from EVDB …",
  shareAlike: true,
};
const KILOWATT_LICENSE = {
  id: "LicenseRef-KilowattApp-MIT-Attribution",
  name: "MIT License with Attribution Requirement",
  url: "https://github.com/KilowattApp/open-ev-data/blob/x/LICENSE",
  attribution: "Open EV Data (https://github.com/KilowattApp/open-ev-data)",
  shareAlike: false,
};

const SPECS = {
  usableBatteryKwh: 86,
  acMaxKw: 11,
  acPhases: 3,
  dcMaxKw: 200,
  acConnectors: ["IEC_62196_T2"],
  dcConnectors: ["IEC_62196_T2_COMBO"],
};

function curve(overrides: Partial<CatalogCurve> = {}): CatalogCurve {
  return {
    id: "crv_gaia",
    sourceId: "gaia",
    sourceRecordKey: "gaia:volkswagen-id7-gtx-2024",
    quality: "UNKNOWN",
    qualityBasis: "record-level only",
    originalQuality: "metadata.data_quality=verified (record-level)",
    observations: ["ENDS_BELOW_FULL_SOC"],
    points: [
      { socPercent: 0, powerKw: 200 },
      { socPercent: 90, powerKw: 40 },
    ],
    datasetVersion: "sha256:b1e424ab58d32fcf",
    license: GAIA_LICENSE,
    ...overrides,
  };
}

function variant(overrides: Partial<CatalogVariant> = {}): CatalogVariant {
  return {
    id: "var_b16bdbae5aa906a7",
    name: "ID.7 GTX",
    makeName: "Volkswagen",
    modelName: "ID.7",
    datasetVersion: "sha256:b1e424ab58d32fcf",
    sourceRecords: [
      {
        key: "gaia:volkswagen-id7-gtx-2024",
        sourceId: "gaia",
        makeName: "Volkswagen",
        modelName: "ID.7",
        variantName: "GTX",
        year: 2024,
        yearKind: "MODEL_YEAR",
        markets: ["DE"],
        sourceUrl: "https://github.com/gaia-charge/evdb/blob/x/a.yaml",
        specs: SPECS,
        license: GAIA_LICENSE,
      },
      {
        key: "kilowatt:2854a132",
        sourceId: "kilowatt",
        makeName: "Volkswagen",
        modelName: "ID.7",
        variantName: "GTX",
        year: 2024,
        yearKind: "RELEASE_YEAR",
        markets: [],
        sourceUrl: null,
        specs: { ...SPECS, usableBatteryKwh: null },
        license: KILOWATT_LICENSE,
      },
    ],
    curves: [
      curve(),
      curve({
        id: "crv_kilowatt",
        sourceId: "kilowatt",
        sourceRecordKey: "kilowatt:2854a132",
        observations: [],
        license: KILOWATT_LICENSE,
        points: [
          { socPercent: 0, powerKw: 200 },
          { socPercent: 100, powerKw: 60 },
        ],
      }),
    ],
    ...overrides,
  };
}

const NOW = "2026-10-11T10:00:00.000Z";
const LATER = "2026-11-01T10:00:00.000Z";

describe("profileFromCatalog (#458)", () => {
  it("takes the specs of the chosen record and the chosen curve, nothing else", () => {
    const result = profileFromCatalog(
      variant(),
      { sourceRecordKey: "kilowatt:2854a132", curveId: "crv_gaia" },
      { id: "vp_1", now: NOW },
    );
    if (!result.ok) throw new Error(result.reason);
    const p = result.profile;
    expect(p.name).toBe("Volkswagen ID.7 GTX");
    // The kilowatt record has no capacity: it stays missing, it is not
    // borrowed from the gaia record.
    expect(p.specs.usableBatteryKwh).toBeNull();
    expect(p.dcCurve).toEqual([
      { socPercent: 0, powerKw: 200 },
      { socPercent: 90, powerKw: 40 },
    ]);
    expect(p.overrides).toEqual({});
    expect(p.origin).toMatchObject({
      provider: "open-ev-directory",
      variantId: "var_b16bdbae5aa906a7",
      sourceId: "kilowatt",
      sourceRecordKey: "kilowatt:2854a132",
      curveId: "crv_gaia",
      curveSourceId: "gaia",
      curveQuality: "UNKNOWN",
      qualityBasis: "record-level only",
      observations: ["ENDS_BELOW_FULL_SOC"],
      datasetVersion: "sha256:b1e424ab58d32fcf",
      importedAt: NOW,
    });
  });

  it("keeps the license of both the record and the curve", () => {
    const result = profileFromCatalog(
      variant(),
      { sourceRecordKey: "kilowatt:2854a132", curveId: "crv_gaia" },
      { id: "vp_1", now: NOW },
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.profile.origin!.licenses).toEqual([
      { ...KILOWATT_LICENSE, sourceId: "kilowatt" },
      { ...GAIA_LICENSE, sourceId: "gaia" },
    ]);
  });

  it("imports no curve when none is chosen", () => {
    const result = profileFromCatalog(
      variant(),
      { sourceRecordKey: "gaia:volkswagen-id7-gtx-2024", curveId: null },
      { id: "vp_1", now: NOW, name: "My ID.7" },
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.profile.name).toBe("My ID.7");
    expect(result.profile.dcCurve).toBeNull();
    expect(result.profile.origin).toMatchObject({
      curveId: null,
      curveQuality: null,
      observations: [],
    });
    expect(result.profile.origin!.licenses).toHaveLength(1);
  });

  it("refuses a record or a curve the variant does not have", () => {
    expect(
      profileFromCatalog(
        variant(),
        { sourceRecordKey: "gaia:nope", curveId: null },
        { id: "vp_1", now: NOW },
      ),
    ).toEqual({ ok: false, reason: "source_record_not_found" });
    expect(
      profileFromCatalog(
        variant(),
        { sourceRecordKey: "gaia:volkswagen-id7-gtx-2024", curveId: "crv_x" },
        { id: "vp_1", now: NOW },
      ),
    ).toEqual({ ok: false, reason: "curve_not_found" });
  });
});

function imported() {
  const result = profileFromCatalog(
    variant(),
    { sourceRecordKey: "gaia:volkswagen-id7-gtx-2024", curveId: "crv_gaia" },
    { id: "vp_1", now: NOW },
  );
  if (!result.ok) throw new Error(result.reason);
  return { ...result.profile, overrides: { usableBatteryKwh: 80 } };
}

describe("refreshFromCatalog (#458)", () => {
  it("reports an unchanged dataset as up to date", () => {
    const result = refreshFromCatalog(imported(), variant(), LATER);
    if (!result.ok) throw new Error(result.reason);
    expect(result.upToDate).toBe(true);
    expect(result.changes).toEqual([]);
  });

  it("lists what changed and keeps the user's edits", () => {
    const next = variant({ datasetVersion: "sha256:new" });
    next.sourceRecords[0] = {
      ...next.sourceRecords[0]!,
      specs: { ...SPECS, usableBatteryKwh: 85, dcMaxKw: 210 },
    };
    next.curves[0] = curve({
      datasetVersion: "sha256:new",
      points: [{ socPercent: 0, powerKw: 210 }],
    });
    const result = refreshFromCatalog(imported(), next, LATER);
    if (!result.ok) throw new Error(result.reason);
    expect(result.upToDate).toBe(false);
    expect(result.changes).toEqual([
      { field: "usableBatteryKwh", before: 86, after: 85 },
      { field: "dcMaxKw", before: 200, after: 210 },
      { field: "dcCurve" },
      {
        field: "datasetVersion",
        before: "sha256:b1e424ab58d32fcf",
        after: "sha256:new",
      },
    ]);
    expect(result.profile.specs.usableBatteryKwh).toBe(85);
    expect(result.profile.overrides).toEqual({ usableBatteryKwh: 80 });
    expect(result.profile.dcCurve).toEqual([{ socPercent: 0, powerKw: 210 }]);
    expect(result.profile.origin!.importedAt).toBe(LATER);
    expect(result.profile.createdAt).toBe(NOW);
    expect(result.profile.updatedAt).toBe(LATER);
  });

  it("follows a variant that moved to a new id", () => {
    const result = refreshFromCatalog(
      imported(),
      variant({ id: "var_new" }),
      LATER,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.profile.origin!.variantId).toBe("var_new");
    expect(result.changes).toContainEqual({
      field: "variantId",
      before: "var_b16bdbae5aa906a7",
      after: "var_new",
    });
  });

  it("refuses when the record or the curve is gone, leaving the profile alone", () => {
    const p = imported();
    expect(
      refreshFromCatalog(p, variant({ sourceRecords: [] }), LATER),
    ).toEqual({ ok: false, reason: "source_record_not_found" });
    expect(refreshFromCatalog(p, variant({ curves: [] }), LATER)).toEqual({
      ok: false,
      reason: "curve_not_found",
    });
  });

  it("refuses a hand-made profile", () => {
    expect(
      refreshFromCatalog({ ...imported(), origin: null }, variant(), LATER),
    ).toEqual({ ok: false, reason: "not_imported" });
  });
});

describe("markRemovedUpstream (#458)", () => {
  it("flags the origin and keeps every value", () => {
    const p = imported();
    const marked = markRemovedUpstream(p, LATER);
    expect(marked.origin!.removedUpstream).toBe(true);
    expect(marked.specs).toEqual(p.specs);
    expect(marked.dcCurve).toEqual(p.dcCurve);
    expect(marked.updatedAt).toBe(LATER);
  });
});
