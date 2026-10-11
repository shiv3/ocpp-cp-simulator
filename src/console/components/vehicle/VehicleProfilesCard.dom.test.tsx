// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  VehicleCatalogError,
  type CatalogVariant,
  type VehicleCatalog,
} from "@/cp/domain/vehicle/VehicleCatalog";
import type { VehicleProfile } from "@/cp/domain/vehicle/VehicleProfile";
import type { ChargePointService } from "@/data/interfaces/ChargePointService";
import { DataContext } from "@/data/providers/DataProvider";

import { createFakeChargePointService } from "../../test/harness";
import {
  OED_BASE_URL_STORAGE_KEY,
  resetLocalCatalogCredentialsForTests,
} from "../../lib/vehicleCatalog";
import VehicleProfilesCard from "./VehicleProfilesCard";

let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  window.localStorage.clear();
  resetLocalCatalogCredentialsForTests();
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function flush(hops = 6): Promise<void> {
  for (let i = 0; i < hops; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const NOW = "2026-10-11T10:00:00.000Z";

const VARIANT: CatalogVariant = {
  id: "var_1",
  name: "ID.7 GTX",
  makeName: "Volkswagen",
  modelName: "ID.7",
  datasetVersion: "sha256:v1",
  sourceRecords: [
    {
      key: "gaia:id7",
      sourceId: "gaia",
      makeName: "Volkswagen",
      modelName: "ID.7",
      variantName: "GTX",
      year: 2024,
      yearKind: "MODEL_YEAR",
      markets: [],
      sourceUrl: null,
      specs: {
        usableBatteryKwh: null,
        acMaxKw: 11,
        acPhases: 3,
        dcMaxKw: 200,
        acConnectors: ["IEC_62196_T2"],
        dcConnectors: ["IEC_62196_T2_COMBO"],
      },
      license: {
        id: "CC-BY-SA-4.0",
        name: "CC BY-SA 4.0",
        url: "https://creativecommons.org/licenses/by-sa/4.0/",
        attribution: "Contains data from EVDB, CC BY-SA 4.0",
        shareAlike: true,
      },
    },
  ],
  curves: [
    {
      id: "crv_1",
      sourceId: "gaia",
      sourceRecordKey: "gaia:id7",
      quality: "UNKNOWN",
      qualityBasis: "record-level only",
      originalQuality: "verified",
      observations: ["ENDS_BELOW_FULL_SOC"],
      points: [
        { socPercent: 0, powerKw: 200 },
        { socPercent: 90, powerKw: 40 },
      ],
      datasetVersion: "sha256:v1",
      license: {
        id: "CC-BY-SA-4.0",
        name: "CC BY-SA 4.0",
        url: "https://creativecommons.org/licenses/by-sa/4.0/",
        attribution: "Contains data from EVDB, CC BY-SA 4.0",
        shareAlike: true,
      },
    },
  ],
};

function fakeCatalog(overrides: Partial<VehicleCatalog> = {}): VehicleCatalog {
  return {
    listMakes: vi.fn(async () => [
      { id: "volkswagen", name: "Volkswagen", modelCount: 1 },
    ]),
    searchModels: vi.fn(async () => ({
      items: [
        {
          id: "volkswagen--id-7",
          name: "ID.7",
          makeId: "volkswagen",
          makeName: "Volkswagen",
          variantCount: 1,
        },
      ],
      page: 0,
      totalPages: 1,
      totalItems: 1,
    })),
    listVariants: vi.fn(async () => ({
      items: [
        {
          id: "var_1",
          name: "ID.7 GTX",
          makeId: "volkswagen",
          modelId: "volkswagen--id-7",
          sources: ["gaia"],
          chargingCurveCount: 1,
        },
      ],
      page: 0,
      totalPages: 1,
      totalItems: 1,
    })),
    getVariant: vi.fn(async () => VARIANT),
    ...overrides,
  };
}

/** An in-memory profile store behind the service. */
function profileService(
  initial: VehicleProfile[] = [],
  extra: Partial<ChargePointService> = {},
) {
  let stored = [...initial];
  return createFakeChargePointService({
    listVehicleProfiles: vi.fn(async () => stored),
    saveVehicleProfile: vi.fn(async (p: VehicleProfile) => {
      stored = [...stored.filter((s) => s.id !== p.id), p];
      return p;
    }),
    deleteVehicleProfile: vi.fn(async (id: string) => {
      stored = stored.filter((s) => s.id !== id);
    }),
    ...extra,
  });
}

function remoteService(
  catalog: VehicleCatalog,
  initial: VehicleProfile[] = [],
  configured = true,
) {
  return profileService(initial, {
    getVehicleCatalog: () => catalog,
    getServerInfo: vi.fn(async () => ({
      version: "test",
      soap: { publicBaseUrl: null, path: "/ocpp/soap", tunnel: null },
      vehicleCatalog: {
        provider: "open-ev-directory" as const,
        configured,
        authenticated: true,
      },
    })),
  });
}

async function render(
  service: ChargePointService,
  mode: "local" | "remote" = "remote",
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <DataContext.Provider
        value={{
          mode,
          serverUrl: "http://test",
          defaultEvSettings: null,
          setDefaultEvSettings: () => {},
          chargePointService: service,
        }}
      >
        <VehicleProfilesCard now={() => NOW} />
      </DataContext.Provider>,
    ),
  );
  await flush();
  return container;
}

const button = (text: string) =>
  Array.from(document.body.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  );
const byLabel = <T extends HTMLElement>(label: string) =>
  document.body.querySelector<T>(`[aria-label="${label}"]`);

async function click(el: HTMLElement | null | undefined) {
  if (!el) throw new Error("element not found");
  await act(async () => el.click());
  await flush();
}

async function type(
  el: HTMLInputElement | HTMLSelectElement | null,
  value: string,
) {
  if (!el) throw new Error("field not found");
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
  await flush();
}

async function openVariant() {
  await click(button("Import from Open EV Directory"));
  await type(byLabel<HTMLInputElement>("Model"), "id.7");
  await click(button("Search"));
  await click(
    Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.startsWith("Volkswagen ID.7"),
    ),
  );
  await click(
    Array.from(document.body.querySelectorAll("button")).find((b) =>
      b.textContent?.startsWith("ID.7 GTX"),
    ),
  );
}

describe("VehicleProfilesCard — import (#458)", () => {
  it("imports a variant only once the record, the curve and the missing capacity are given", async () => {
    const service = remoteService(fakeCatalog());
    await render(service);
    await openVariant();

    const save = () => button("Save profile")!;
    expect(save().disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Choose the source record whose specs to keep.",
    );

    await click(byLabel("Specs from gaia"));
    // No curve is preselected — not even "no curve".
    expect(byLabel<HTMLInputElement>("Curve from gaia")!.checked).toBe(false);
    expect(byLabel<HTMLInputElement>("No curve")!.checked).toBe(false);
    expect(save().disabled).toBe(true);

    await click(byLabel("Curve from gaia"));
    // The source gives no capacity: it has to be filled in.
    expect(document.body.textContent).toContain(
      "The source gives no usable battery capacity: fill it in.",
    );
    expect(save().disabled).toBe(true);
    await type(
      byLabel<HTMLInputElement>("Missing usable battery capacity"),
      "86",
    );
    expect(save().disabled).toBe(false);
    // The attribution goes with the profile.
    expect(document.body.textContent).toContain(
      "Contains data from EVDB, CC BY-SA 4.0",
    );

    await click(save());
    const saved = vi.mocked(service.saveVehicleProfile!).mock.calls[0]![0];
    expect(saved).toMatchObject({
      name: "Volkswagen ID.7 GTX",
      specs: { usableBatteryKwh: null, dcMaxKw: 200 },
      overrides: { usableBatteryKwh: 86 },
      dcCurve: VARIANT.curves[0]!.points,
      origin: {
        variantId: "var_1",
        sourceRecordKey: "gaia:id7",
        curveId: "crv_1",
        curveQuality: "UNKNOWN",
        datasetVersion: "sha256:v1",
        importedAt: NOW,
      },
      createdAt: NOW,
    });
    // The dialog closed and the list shows the new profile.
    expect(byLabel("Specs from gaia")).toBeNull();
    expect(document.body.textContent).toContain("Volkswagen ID.7 GTX");
    expect(document.body.textContent).toContain("curve from gaia, unknown");
  });

  it("says how long to wait when the catalog rate-limits", async () => {
    const service = remoteService(
      fakeCatalog({
        searchModels: vi.fn(async () => {
          throw new VehicleCatalogError("rate_limited", "slow", {
            retryAfterSeconds: 42,
          });
        }),
      }),
    );
    await render(service);
    await click(button("Import from Open EV Directory"));
    await type(byLabel<HTMLInputElement>("Model"), "id.7");
    await click(button("Search"));
    expect(
      document.body.querySelector('[role="alert"]')!.textContent,
    ).toContain("try again in 42 s");
  });

  it("explains how to configure a daemon without a catalog", async () => {
    const service = remoteService(fakeCatalog(), [], false);
    await render(service);
    await click(button("Import from Open EV Directory"));
    expect(document.body.textContent).toContain(
      "The daemon has no Open EV Directory URL",
    );
    expect(byLabel("Model")).toBeNull();
  });
});

describe("VehicleProfilesCard — browser-only mode (#458)", () => {
  const KEY = "evd_live_SENTINEL_browser";

  it("calls the catalog with the typed key, keeps it in memory only, and explains a blocked call", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          auth: new Headers(init?.headers).get("authorization"),
        });
        const path = new URL(url).pathname;
        if (path === "/v1/makes") {
          return Response.json({
            items: [{ id: "volkswagen", name: "Volkswagen", modelCount: 1 }],
            page: { number: 0, size: 200, totalItems: 1, totalPages: 1 },
          });
        }
        // What a browser reports for a cross-origin call the API refuses.
        throw new TypeError("Failed to fetch");
      }),
    );
    await render(profileService(), "local");
    await click(button("Import from Open EV Directory"));

    const url = byLabel<HTMLInputElement>("Open EV Directory URL")!;
    await type(url, "https://evd.example.test");
    await act(async () => {
      url.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await flush();
    await type(byLabel<HTMLInputElement>("Open EV Directory API key"), KEY);
    await click(button("Use"));

    await type(byLabel<HTMLInputElement>("Model"), "id.7");
    await click(button("Search"));

    // The makes are read as soon as the URL is set, before the key is; the
    // search, after it, carries the key.
    const searchCall = calls.find((c) => c.url.includes("/v1/models"));
    expect(searchCall?.auth).toBe(`Bearer ${KEY}`);
    expect(calls.every((c) => !c.url.includes(KEY))).toBe(true);
    expect(
      document.body.querySelector('[role="alert"]')!.textContent,
    ).toContain("does not allow calls from this page (CORS)");
    // The URL is remembered; the key is not, anywhere.
    expect(window.localStorage.getItem(OED_BASE_URL_STORAGE_KEY)).toBe(
      "https://evd.example.test",
    );
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i)!;
      expect(window.localStorage.getItem(k)).not.toContain(KEY);
    }
    expect(document.body.innerHTML).not.toContain(KEY);
  });
});

describe("VehicleProfilesCard — refresh (#458)", () => {
  async function importedProfile(): Promise<VehicleProfile> {
    const { profileFromCatalog } =
      await import("@/cp/domain/vehicle/importProfile");
    const result = profileFromCatalog(
      {
        ...VARIANT,
        sourceRecords: [
          {
            ...VARIANT.sourceRecords[0]!,
            specs: { ...VARIANT.sourceRecords[0]!.specs, usableBatteryKwh: 86 },
          },
        ],
      },
      { sourceRecordKey: "gaia:id7", curveId: "crv_1" },
      { id: "vp_1", now: "2026-01-01T00:00:00.000Z" },
    );
    if (!result.ok) throw new Error(result.reason);
    return { ...result.profile, overrides: { acMaxKw: 22 } };
  }

  it("shows what changed and asks before replacing, keeping the user's edits", async () => {
    const profile = await importedProfile();
    const changed: CatalogVariant = {
      ...VARIANT,
      datasetVersion: "sha256:v2",
      sourceRecords: [
        {
          ...VARIANT.sourceRecords[0]!,
          specs: { ...VARIANT.sourceRecords[0]!.specs, usableBatteryKwh: 85 },
        },
      ],
      curves: [{ ...VARIANT.curves[0]!, datasetVersion: "sha256:v2" }],
    };
    const service = remoteService(
      fakeCatalog({ getVariant: vi.fn(async () => changed) }),
      [profile],
    );
    await render(service);
    await click(button("Refresh"));

    const changes = byLabel("Refresh changes")!;
    expect(changes.textContent).toContain("usable battery capacity: 86 → 85");
    expect(changes.textContent).toContain(
      "Dataset version: sha256:v1 → sha256:v2",
    );
    expect(service.saveVehicleProfile).not.toHaveBeenCalled();

    await click(button("Replace"));
    const saved = vi.mocked(service.saveVehicleProfile!).mock.calls[0]![0];
    expect(saved.specs.usableBatteryKwh).toBe(85);
    expect(saved.overrides).toEqual({ acMaxKw: 22 });
    expect(saved.origin!.datasetVersion).toBe("sha256:v2");
  });

  it("leaves the profile as it is when the user keeps it", async () => {
    const profile = await importedProfile();
    const service = remoteService(
      fakeCatalog({
        getVariant: vi.fn(async () => ({
          ...VARIANT,
          datasetVersion: "sha256:v2",
        })),
      }),
      [profile],
    );
    await render(service);
    await click(button("Refresh"));
    await click(button("Keep current"));
    expect(service.saveVehicleProfile).not.toHaveBeenCalled();
  });

  it("keeps a vehicle the catalog removed, flagged, and touches nothing else", async () => {
    const profile = await importedProfile();
    const service = remoteService(
      fakeCatalog({
        getVariant: vi.fn(async () => {
          throw new VehicleCatalogError("not_found", "gone");
        }),
      }),
      [profile],
    );
    await render(service);
    await click(button("Refresh"));
    const saved = vi.mocked(service.saveVehicleProfile!).mock.calls[0]![0];
    expect(saved.origin!.removedUpstream).toBe(true);
    expect(saved.specs).toEqual(profile.specs);
    expect(saved.overrides).toEqual(profile.overrides);
    expect(document.body.textContent).toContain(
      "Open EV Directory no longer has this vehicle",
    );
  });

  it("does not touch the profile when the catalog fails", async () => {
    const profile = await importedProfile();
    const service = remoteService(
      fakeCatalog({
        getVariant: vi.fn(async () => {
          throw new VehicleCatalogError("unavailable", "HTTP 503");
        }),
      }),
      [profile],
    );
    await render(service);
    await click(button("Refresh"));
    expect(service.saveVehicleProfile).not.toHaveBeenCalled();
    expect(
      document.body.querySelector('[role="alert"]')!.textContent,
    ).toContain("HTTP 503");
  });
});

describe("VehicleProfilesCard — edits (#458)", () => {
  it("stores only the values that differ from the imported ones", async () => {
    const profile: VehicleProfile = {
      id: "vp_1",
      name: "ID.7",
      specs: {
        usableBatteryKwh: null,
        acMaxKw: 11,
        acPhases: 3,
        dcMaxKw: 200,
        acConnectors: [],
        dcConnectors: [],
      },
      dcCurve: null,
      overrides: {},
      origin: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const service = profileService([profile]);
    await render(service);
    expect(document.body.textContent).toContain(
      "Not usable for DC: usable battery capacity missing",
    );
    await click(button("Edit"));
    await type(byLabel<HTMLInputElement>("usable battery capacity"), "77");
    await type(byLabel<HTMLInputElement>("AC maximum power"), "11");
    await click(button("Save"));
    const saved = vi.mocked(service.saveVehicleProfile!).mock.calls[0]![0];
    expect(saved.overrides).toEqual({ usableBatteryKwh: 77 });
  });

  it("shows a read failure instead of an empty list", async () => {
    const service = createFakeChargePointService({
      listVehicleProfiles: vi.fn(async () => {
        throw new Error("disk unreadable");
      }),
    });
    await render(service);
    expect(
      document.body.querySelector('[role="alert"]')!.textContent,
    ).toContain("disk unreadable");
    expect(document.body.textContent).not.toContain(
      "No saved vehicle profile yet",
    );
  });
});
