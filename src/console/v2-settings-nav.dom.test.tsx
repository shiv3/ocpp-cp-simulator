// @vitest-environment jsdom
//
// Regression test for the `/v2/settings` → `/v2` leg of Settings.tsx's
// relative `navigate("..")` "Back to Home" button. The `/settings` → `/`
// leg (embedded in the new console) is already covered by
// src/console/ConsoleApp.dom.test.tsx. That test alone doesn't prove the
// `/v2` case: `..` resolution in react-router v6 depends on route-context
// depth, not URL segment count, so it has to be exercised through the same
// two-level nesting App.tsx actually uses (`/v2/*` → V2App → `/settings`).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { V2App } from "../App";
import { DataContext } from "../data/providers/DataProvider";
import { createFakeChargePointService } from "./test/harness";

/** Reports the router's current pathname via a data attribute so the test
 *  can assert the exact resulting location without depending on any
 *  particular page's content. Mounted as a sibling of the routed tree so it
 *  always reflects the *real* location, unaffected by nested route
 *  boundaries. */
function LocationProbe(): React.ReactElement {
  const location = useLocation();
  return <div data-testid="location-probe" data-pathname={location.pathname} />;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
}

describe("V2 Settings back-nav across the /v2 boundary", () => {
  let cleanup: (() => Promise<void>) | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it('"Back to Home" on /v2/settings returns to /v2 (relative navigate("..") mirroring App.tsx\'s /v2/* -> V2App nesting)', async () => {
    const service = createFakeChargePointService();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanup = () => unmount(root);

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/v2/settings"]}>
          <DataContext.Provider
            value={{
              mode: "remote",
              serverUrl: "http://test",
              defaultEvSettings: null,
              setDefaultEvSettings: () => {},
              chargePointService: service,
            }}
          >
            <LocationProbe />
            {/* Mirrors App.tsx's actual route tree: <Route path="/v2/*"
                element={<V2App />} />, the exact nesting the real
                Settings.tsx "Back to Home" button navigates within. */}
            <Routes>
              <Route path="/v2/*" element={<V2App />} />
            </Routes>
          </DataContext.Provider>
        </MemoryRouter>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const probe = () =>
      container.querySelector('[data-testid="location-probe"]');
    expect(probe()?.getAttribute("data-pathname")).toBe("/v2/settings");
    expect(container.textContent).toContain("RFID Tag IDs");

    const backButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Back to Home",
    );
    expect(backButton, 'expected a "Back to Home" button').toBeTruthy();

    await act(async () => {
      backButton!.click();
    });

    expect(probe()?.getAttribute("data-pathname")).toBe("/v2");
  });
});
