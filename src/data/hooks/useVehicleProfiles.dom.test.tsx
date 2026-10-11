// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { VehicleProfile } from "../../cp/domain/vehicle/VehicleProfile";
import { createFakeChargePointService } from "../../console/test/harness";
import { DataContext } from "../providers/DataProvider";
import { useVehicleProfiles, type VehicleProfiles } from "./useVehicleProfiles";

let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
});

function profile(id: string, name: string): VehicleProfile {
  return {
    id,
    name,
    specs: {
      usableBatteryKwh: 50,
      acMaxKw: 11,
      acPhases: 3,
      dcMaxKw: 100,
      acConnectors: [],
      dcConnectors: [],
    },
    dcCurve: null,
    overrides: {},
    origin: null,
    createdAt: "2026-10-11T10:00:00.000Z",
    updatedAt: "2026-10-11T10:00:00.000Z",
  };
}

describe("useVehicleProfiles (#458)", () => {
  it("shows a write even when a list read started before it lands last", async () => {
    let stored: VehicleProfile[] = [];
    const pending: Array<() => void> = [];
    const service = createFakeChargePointService({
      // Each read answers with the store as it was when the read *started*,
      // and only when released, so reads can finish out of order.
      listVehicleProfiles: vi.fn(() => {
        const snapshot = [...stored];
        return new Promise<VehicleProfile[]>((resolve) =>
          pending.push(() => resolve(snapshot)),
        );
      }),
      saveVehicleProfile: vi.fn(async (p: VehicleProfile) => {
        stored = [...stored, p];
        return p;
      }),
    });
    let hook: VehicleProfiles | null = null;
    const Probe = () => {
      hook = useVehicleProfiles();
      return null;
    };
    root = createRoot(document.createElement("div"));
    await act(async () =>
      root!.render(
        <DataContext.Provider
          value={{
            mode: "local",
            serverUrl: "",
            defaultEvSettings: null,
            setDefaultEvSettings: () => {},
            chargePointService: service,
          }}
        >
          <Probe />
        </DataContext.Provider>,
      ),
    );
    // The initial read is in flight (empty store) when a save lands.
    let saved: Promise<unknown> = Promise.resolve();
    await act(async () => {
      saved = hook!.save(profile("a", "A"));
      await Promise.resolve();
    });
    // Release the reads newest first, then the stale one.
    await act(async () => {
      while (pending.length > 0) pending.pop()!();
      await saved;
    });
    expect(hook!.profiles.map((p) => p.id)).toEqual(["a"]);
  });
});
