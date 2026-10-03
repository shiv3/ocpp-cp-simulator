// @vitest-environment jsdom
//
// Top-level routing through the real `AppRoutes` tree (the one App.tsx mounts
// under its BrowserRouter), so these tests cover the route table itself —
// legacy paths, redirects and deep links — rather than any single page.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { AppRoutes } from "./App";
import { DataContext } from "./data/providers/DataProvider";
import { createFakeChargePointService } from "./console/test/harness";

/** Exposes the router's current location so tests assert where a URL
 *  actually lands, independently of the page it renders. */
function LocationProbe(): React.ReactElement {
  const location = useLocation();
  return (
    <div
      data-testid="location-probe"
      data-pathname={location.pathname}
      data-search={location.search}
      data-hash={location.hash}
    />
  );
}

interface RenderedApp {
  container: HTMLElement;
  location: () => { pathname: string; search: string; hash: string };
}

let root: Root | null = null;

async function renderApp(initialPath: string): Promise<RenderedApp> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <DataContext.Provider
          value={{
            mode: "remote",
            serverUrl: "http://test",
            defaultEvSettings: null,
            setDefaultEvSettings: () => {},
            chargePointService: createFakeChargePointService(),
          }}
        >
          <LocationProbe />
          <AppRoutes />
        </DataContext.Provider>
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });

  return {
    container,
    location: () => {
      const probe = container.querySelector('[data-testid="location-probe"]');
      return {
        pathname: probe?.getAttribute("data-pathname") ?? "",
        search: probe?.getAttribute("data-search") ?? "",
        hash: probe?.getAttribute("data-hash") ?? "",
      };
    },
  };
}

describe("AppRoutes", () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = "";
    localStorage.clear();
  });

  describe("legacy v1 UI (removed)", () => {
    it.each(["/v1", "/v1/settings"])(
      "%s no longer renders the v1 UI and redirects to the root",
      async (path) => {
        const app = await renderApp(path);

        expect(app.location().pathname).toBe("/");
        expect(app.container.textContent).not.toContain(
          "OCPP ChargePoint Simulator (v1)",
        );
      },
    );
  });
});
