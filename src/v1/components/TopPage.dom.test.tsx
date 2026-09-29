// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "jotai";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import TopPage from "./TopPage";

/**
 * #374: the experimental multi-charger view used `<Tabs.Item>`, which
 * flowbite-react 0.12 no longer declares (it exports `TabItem`). It still
 * rendered, because `Tabs` only reads its children's props; this pins that
 * the view keeps one tab per charge point on the supported API.
 */
describe("v1 TopPage experimental multi-charger view", () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("renders one tab per configured charge point", async () => {
    localStorage.setItem(
      "config-v1",
      JSON.stringify({
        wsURL: "ws://127.0.0.1:1/",
        ChargePointID: "CP-A",
        connectorNumber: 1,
        tagID: "TAG",
        ocppVersion: "OCPP-1.6J",
        basicAuthSettings: { enabled: false, username: "", password: "" },
        autoMeterValueSetting: { enabled: false, interval: 30, value: 10 },
        Experimental: {
          ChargePointIDs: [
            { ChargePointID: "CP-A", ConnectorNumber: 1 },
            { ChargePointID: "CP-B", ConnectorNumber: 1 },
          ],
          TagIDs: ["TAG"],
        },
        BootNotification: null,
      }),
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <Provider>
          <MemoryRouter>
            <TopPage />
          </MemoryRouter>
        </Provider>,
      );
    });

    const tabs = Array.from(container.querySelectorAll('[role="tab"]')).map(
      (tab) => tab.textContent,
    );
    expect(tabs).toEqual(["CP-A", "CP-B"]);
    await act(async () => {
      root.unmount();
    });
  });
});
