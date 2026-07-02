// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AutoMeterValueConfig } from "../cp/domain/connector/MeterValueCurve";
import { OCPPStatus } from "../cp/domain/types/OcppTypes";
import type { ChargePointService } from "../data/interfaces/ChargePointService";
import { saveConnectorAutoMeterConfig } from "./connectorAutoMeterConfig";
import { ConnectorSidePanel } from "./ConnectorSidePanel";

type PanelService = Pick<
  ChargePointService,
  | "getAutoMeterConfig"
  | "getLocalChargePoint"
  | "getSocMeterSync"
  | "saveAutoMeterConfig"
  | "saveSocMeterSync"
  | "sendMeterValue"
  | "sendStatusNotification"
  | "setAutoMeterValueConfig"
  | "setConnectorSoc"
  | "setConnectorSocMeterSync"
  | "setMeterValue"
  | "startTransaction"
  | "stopTransaction"
>;

let service: PanelService;
let connectorViewState: {
  status: OCPPStatus;
  availability: "Operative";
  meterValue: number;
  soc: number | null;
  transactionId: number | null;
  transactionStartTime: Date | null;
  transactionTagId: string | null;
  transactionBatteryCapacityKwh: number | null;
  logs: string[];
  autoMeterValueConfig: AutoMeterValueConfig | null;
  mode: "manual";
  autoResetToAvailable: boolean;
  evSettings: {
    modelName: string;
    batteryCapacityKwh: number;
    maxChargingPowerKw: number;
    initialSoc: number;
    targetSoc: number;
  };
  chargingProfile: null;
  chargingProfiles: [];
};

const autoMeterConfig: AutoMeterValueConfig = {
  enabled: true,
  curvePoints: [
    { time: 0, value: 0 },
    { time: 60, value: 5 },
  ],
  intervalSeconds: 10,
  autoCalculateInterval: false,
};

vi.mock("../data/providers/DataProvider", () => ({
  useDataContext: () => ({
    mode: "local",
    chargePointService: service,
  }),
}));

vi.mock("../data/hooks/useConnectorView", () => ({
  useConnectorView: () => connectorViewState,
}));

vi.mock("../data/hooks/useScenarios", () => ({
  useScenarios: () => ({ scenarios: [], isLoading: false }),
}));

vi.mock("./scenario/ScenarioEditor", () => ({
  default: () => <div data-testid="scenario-editor" />,
}));

vi.mock("./state-transition/StateTransitionViewer", () => ({
  default: () => <div data-testid="state-transition-viewer" />,
}));

vi.mock("./MeterValueCurveModal", () => ({
  default: () => <div data-testid="meter-value-curve-modal" />,
}));

function panelElement(): JSX.Element {
  return (
    <ConnectorSidePanel
      cpId="CP-1"
      connectorId={1}
      idTag="TAG-1"
      onClose={() => undefined}
      isCollapsed={false}
      onToggleCollapse={() => undefined}
      isFullscreen={false}
      onToggleFullscreen={() => undefined}
      panelWidth={40}
      onWidthChange={() => undefined}
    />
  );
}

async function renderPanel(): Promise<{
  container: HTMLElement;
  root: Root;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(panelElement());
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root };
}

function checkbox(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="checkbox"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("Missing checkbox");
  }
  return input;
}

function meterInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="number"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("Missing meter input");
  }
  return input;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  if (!setter) throw new Error("Missing input value setter");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ConnectorSidePanel connector-settings service consumer", () => {
  let roots: Root[];

  beforeEach(() => {
    roots = [];
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    service = {
      getAutoMeterConfig: vi.fn().mockResolvedValue(autoMeterConfig),
      getLocalChargePoint: vi.fn(() => null),
      getSocMeterSync: vi.fn().mockResolvedValue(true),
      saveAutoMeterConfig: vi.fn().mockResolvedValue(undefined),
      saveSocMeterSync: vi.fn().mockResolvedValue(undefined),
      sendMeterValue: vi.fn().mockResolvedValue(undefined),
      sendStatusNotification: vi.fn().mockResolvedValue(undefined),
      setAutoMeterValueConfig: vi.fn().mockResolvedValue(undefined),
      setConnectorSoc: vi.fn().mockResolvedValue(undefined),
      setConnectorSocMeterSync: vi.fn().mockResolvedValue(undefined),
      setMeterValue: vi.fn().mockResolvedValue(undefined),
      startTransaction: vi.fn().mockResolvedValue(undefined),
      stopTransaction: vi.fn().mockResolvedValue(undefined),
    };
    connectorViewState = {
      status: OCPPStatus.Available,
      availability: "Operative",
      meterValue: 1_000,
      soc: 30,
      transactionId: null,
      transactionStartTime: null,
      transactionTagId: null,
      transactionBatteryCapacityKwh: null,
      logs: [],
      autoMeterValueConfig: autoMeterConfig,
      mode: "manual",
      autoResetToAvailable: true,
      evSettings: {
        modelName: "Test EV",
        batteryCapacityKwh: 50,
        maxChargingPowerKw: 100,
        initialSoc: 20,
        targetSoc: 80,
      },
      chargingProfile: null,
      chargingProfiles: [],
    };
  });

  afterEach(() => {
    for (const root of roots) {
      act(() => {
        root.unmount();
      });
    }
    document.body.innerHTML = "";
  });

  it("reads connector settings through the service and persists SoC sync through the service", async () => {
    const rendered = await renderPanel();
    roots.push(rendered.root);

    expect(service.getAutoMeterConfig).toHaveBeenCalledWith("CP-1", 1);
    expect(service.getSocMeterSync).toHaveBeenCalledWith("CP-1", 1);

    const toggle = checkbox(rendered.container);
    expect(toggle.checked).toBe(true);

    await act(async () => {
      toggle.click();
    });

    expect(service.saveSocMeterSync).toHaveBeenCalledWith("CP-1", 1, false);
    expect(service.setConnectorSocMeterSync).toHaveBeenLastCalledWith(
      "CP-1",
      1,
      false,
    );
  });

  it("persists auto-meter config through the service port", () => {
    const nextConfig: AutoMeterValueConfig = {
      ...autoMeterConfig,
      intervalSeconds: 15,
    };

    saveConnectorAutoMeterConfig(service, "CP-1", 1, nextConfig);

    expect(service.setAutoMeterValueConfig).toHaveBeenCalledWith(
      "CP-1",
      1,
      nextConfig,
    );
    expect(service.saveAutoMeterConfig).toHaveBeenCalledWith(
      "CP-1",
      1,
      nextConfig,
    );
  });

  it("does not overwrite a focused dirty meter input with a live meter refresh", async () => {
    const rendered = await renderPanel();
    roots.push(rendered.root);

    const input = meterInput(rendered.container);
    expect(input.value).toBe("1000");

    await act(async () => {
      input.focus();
      setInputValue(input, "2500");
    });

    connectorViewState = {
      ...connectorViewState,
      meterValue: 5_000,
    };
    await act(async () => {
      rendered.root.render(panelElement());
    });

    expect(input.value).toBe("2500");
  });
});
