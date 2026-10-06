// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ChargePoint } from "../cp/domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../cp/domain/types/OcppTypes";
import { DataContext } from "../data/providers/DataProvider";
import { LocalChargePointService } from "../data/local/LocalChargePointService";
import Connector from "./Connector";

/**
 * In Local mode the scenario runtime and the auto meter-value wiring belong
 * to the data layer (LocalChargePointService / LocalScenarioRuntime), not to
 * the classic connector card: mounting or unmounting the card must leave
 * them alone, or leaving the classic page would stop running scenarios and
 * meter values for the web console.
 */
describe("classic Connector card and the Local-mode runtime", () => {
  let service: LocalChargePointService | null = null;

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await service?.syncLocalChargePoints([]);
    service = null;
    document.body.innerHTML = "";
  });

  it("does not replace, destroy or rewire the connector's runtime on mount or unmount", async () => {
    service = new LocalChargePointService();
    await service.syncLocalChargePoints([
      {
        id: "CP-CARD",
        connectorNumber: 1,
        bootNotification: DefaultBootNotification,
        wsUrl: "ws://127.0.0.1:1/ocpp/",
        basicAuth: null,
        autoMeterValueSetting: null,
        ocppVersion: "OCPP-1.6J",
      },
    ]);
    const connector = (
      service.getLocalChargePoint("CP-CARD") as ChargePoint
    ).getConnector(1)!;
    const runtimeManager = connector.scenarioManager;
    expect(runtimeManager).toBeDefined();
    const destroy = vi.spyOn(runtimeManager!, "destroy");
    const rewire = vi.spyOn(connector, "setOnMeterValueSend");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <DataContext.Provider
          value={{
            mode: "local",
            serverUrl: "",
            defaultEvSettings: null,
            setDefaultEvSettings: () => {},
            chargePointService: service!,
          }}
        >
          <Connector id={1} cpId="CP-CARD" idTag="TAG" />
        </DataContext.Provider>,
      );
    });
    await act(async () => {
      root.unmount();
    });

    expect(connector.scenarioManager).toBe(runtimeManager);
    expect(destroy).not.toHaveBeenCalled();
    expect(rewire).not.toHaveBeenCalled();
  });
});
