// @vitest-environment jsdom
//
// Top-level routing through the real `AppRoutes` tree (the one App.tsx mounts
// under its BrowserRouter), so these tests cover the route table itself —
// legacy paths, redirects and deep links — rather than any single page.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { AppRoutes } from "./App";
import { createEmptyScenario, insertStep } from "./console/lib/scenarioSteps";
import { createFakeChargePointService } from "./console/test/harness";
import { ScenarioNodeType } from "./cp/application/scenario/ScenarioTypes";
import { OCPPStatus } from "./cp/domain/types/OcppTypes";
import { DataContext } from "./data/providers/DataProvider";

type Mode = "local" | "remote";

/** One linear scenario so the editor and the run console render their real
 *  page (rather than a shared "Scenario not found" state). */
function scenarioFixture() {
  const def = insertStep(
    createEmptyScenario("Routing demo", "connector", 1),
    0,
    ScenarioNodeType.STATUS_CHANGE,
  );
  return { ...def, id: "s1" };
}

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

async function renderApp(
  initialPath: string,
  mode: Mode = "remote",
): Promise<RenderedApp> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <DataContext.Provider
          value={{
            mode,
            serverUrl: "http://test",
            defaultEvSettings: null,
            setDefaultEvSettings: () => {},
            chargePointService: createFakeChargePointService({
              snapshots: [
                {
                  id: "CP-1",
                  status: OCPPStatus.Available,
                  error: "",
                  connectors: [],
                },
              ],
              getStateHistory: vi.fn(async () => []),
              listScenarioDefinitions: vi.fn(async () => [scenarioFixture()]),
            }),
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

function heading(container: HTMLElement): string | undefined {
  return container.querySelector("h1")?.textContent?.trim();
}

function hasButton(container: HTMLElement, label: string): boolean {
  return Array.from(container.querySelectorAll("button")).some(
    (b) => b.textContent?.trim() === label,
  );
}

describe("AppRoutes", () => {
  let installedScrollTo = false;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    // jsdom has no Element.scrollTo; the run console's log tail calls it.
    if (typeof Element.prototype.scrollTo !== "function") {
      Element.prototype.scrollTo = () => {};
      installedScrollTo = true;
    }
  });

  afterAll(() => {
    if (installedScrollTo) {
      delete (Element.prototype as { scrollTo?: () => void }).scrollTo;
    }
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
  describe.each<Mode>(["remote", "local"])(
    "web console at the root (%s mode)",
    (mode) => {
      it.each([
        ["/", "Charge Points"],
        ["/cp/CP-1", "CP-1"],
        ["/scenarios?cp=CP-1", "Scenarios"],
        ["/scenarios/runs?cp=CP-1", "Run History"],
        ["/logs", "Message Log"],
      ])("deep link %s renders its page", async (path, title) => {
        const app = await renderApp(path, mode);

        expect(heading(app.container)).toBe(title);
        expect(app.location().pathname + app.location().search).toBe(path);
      });

      it("deep link /scenarios/edit opens the editor for the scenario in the query", async () => {
        const app = await renderApp(
          "/scenarios/edit?cp=CP-1&connector=1&id=s1",
          mode,
        );

        expect(
          app.container.querySelector<HTMLInputElement>(
            'input[value="Routing demo"]',
          ),
        ).not.toBeNull();
        expect(hasButton(app.container, "Save")).toBe(true);
      });

      it("deep link /scenarios/run opens the run console for the scenario in the query", async () => {
        const app = await renderApp(
          "/scenarios/run?cp=CP-1&connector=1&id=s1",
          mode,
        );

        expect(app.container.textContent).toContain("Routing demo");
        expect(hasButton(app.container, "Start")).toBe(true);
      });

      it("deep link /settings renders the settings page", async () => {
        const app = await renderApp("/settings", mode);

        expect(app.container.textContent).toContain("RFID Tag IDs");
      });
    },
  );

  describe("/v3 bookmarks redirect to the same console route", () => {
    it.each([
      ["/v3", "/", ""],
      ["/v3/", "/", ""],
      ["/v3/cp/CP-1", "/cp/CP-1", ""],
      ["/v3/scenarios", "/scenarios", ""],
      ["/v3/scenarios/edit", "/scenarios/edit", "?cp=CP-1&connector=1&id=s1"],
      [
        "/v3/scenarios/run",
        "/scenarios/run",
        "?cp=CP-1&connector=&id=s1&run=r-1",
      ],
      ["/v3/scenarios/runs", "/scenarios/runs", "?cp=CP-1&page=2"],
      ["/v3/logs", "/logs", "?cp=CP-1"],
      ["/v3/settings", "/settings", ""],
    ])("%s → %s (query: %s)", async (from, to, search) => {
      const app = await renderApp(`${from}${search}#frag`);

      expect(app.location()).toEqual({
        pathname: to,
        search,
        hash: "#frag",
      });
    });

    it("lands on the console page, not an empty shell", async () => {
      const app = await renderApp("/v3/logs");

      expect(heading(app.container)).toBe("Message Log");
    });
  });

  describe("classic UI during the transition", () => {
    it.each(["/v2", "/v2/settings"])(
      "%s still renders the classic UI",
      async (path) => {
        const app = await renderApp(path);

        expect(app.location().pathname).toBe(path);
        const link = app.container.querySelector('a[href="/"]');
        expect(link?.textContent).toContain("Web console");
      },
    );

    it("the console links to the classic UI under /v2, not the root", async () => {
      const app = await renderApp("/");

      const classic = Array.from(app.container.querySelectorAll("a")).find(
        (a) => a.textContent?.includes("Classic UI"),
      );
      expect(classic?.getAttribute("href")).toBe("/v2");
      expect(app.container.textContent).not.toContain("classic design");
    });
  });

  it("an unknown path shows the console's not-found page", async () => {
    const app = await renderApp("/no-such-page");

    expect(heading(app.container)).toBe("Page not found");
    const home = Array.from(app.container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Back to charge points"),
    );
    expect(home?.getAttribute("href")).toBe("/");
  });
});
