// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  flush,
  renderConsole,
} from "../../test/harness";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type { ChargePointSnapshot } from "../../../data/interfaces/ChargePointService";
import { batteryTone } from "./connectorCardModel";
import EvBattery, { type EvBatteryProps } from "./EvBattery";

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
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function renderBattery(props: Partial<EvBatteryProps> = {}) {
  const onSocCommit = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <EvBattery
        soc={46}
        targetSoc={80}
        capacityKwh={75}
        powerKw={7.4}
        evName="Tesla Model 3"
        tone="charging"
        onSocCommit={onSocCommit}
        {...props}
      />,
    ),
  );
  return { container, onSocCommit };
}

const fill = (c: HTMLElement) =>
  c.querySelector<SVGRectElement>('[data-testid="battery-fill"]')!;
const slider = (c: HTMLElement) =>
  c.querySelector<HTMLInputElement>(
    'input[aria-label="State of charge (drag)"]',
  )!;

function setRange(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("EvBattery: the EV as a battery with a hero SoC", () => {
  it("fills the battery by the SoC and marks the target", async () => {
    const { container } = await renderBattery({ soc: 50 });
    // 110 px of track inside the case: half of it at 50 %.
    expect(fill(container).getAttribute("width")).toBe("55");
    const target = container.querySelector('[data-testid="battery-target"]');
    expect(target?.getAttribute("x1")).toBe("95");
    expect(
      container.querySelector('[data-testid="battery-bolt"]'),
    ).not.toBeNull();
  });

  it("shows the SoC as the hero figure, and a dash without one", async () => {
    const first = await renderBattery({ soc: 46 });
    expect(
      first.container.querySelector('[data-testid="soc-hero"]')?.textContent,
    ).toBe("46%");
    await act(async () => root!.unmount());
    root = null;

    const none = await renderBattery({ soc: null, tone: "idle" });
    expect(
      none.container.querySelector('[data-testid="soc-hero"]')?.textContent,
    ).toBe("—");
    expect(fill(none.container).getAttribute("width")).toBe("0");
    expect(none.container.textContent).toContain("SoC not reported");
  });

  it("estimates the time to the target at the current power", async () => {
    const { container } = await renderBattery();
    expect(container.textContent).toContain(
      "Target 80 % · about 3 h 27 min at 7.4 kW · Tesla Model 3",
    );
  });

  it("leaves the estimate out without power, and says when the target is reached", async () => {
    const idle = await renderBattery({ powerKw: 0, tone: "idle" });
    expect(idle.container.textContent).toContain("Target 80 % · Tesla Model 3");
    expect(idle.container.textContent).not.toContain("about");
    await act(async () => root!.unmount());
    root = null;

    const full = await renderBattery({ soc: 82, tone: "full" });
    expect(full.container.textContent).toContain(
      "Target 80 % reached · Tesla Model 3",
    );
  });

  it("commits a dragged SoC on release", async () => {
    const { container, onSocCommit } = await renderBattery();
    await act(async () => setRange(slider(container), "63"));
    // The figure follows the drag before anything is sent.
    expect(
      container.querySelector('[data-testid="soc-hero"]')?.textContent,
    ).toBe("63%");
    expect(onSocCommit).not.toHaveBeenCalled();
    await act(async () => {
      slider(container).dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true }),
      );
    });
    expect(onSocCommit).toHaveBeenCalledWith(63);
  });

  it("picks the fill colour from the state", () => {
    expect(batteryTone(OCPPStatus.Charging, 40, 80)).toBe("charging");
    expect(batteryTone(OCPPStatus.Charging, 80, 80)).toBe("full");
    expect(batteryTone(OCPPStatus.Faulted, 40, 80)).toBe("faulted");
    expect(batteryTone(OCPPStatus.Preparing, 40, 80)).toBe("idle");
  });

  it("on the connector card, the drag sets the connector's SoC", async () => {
    const snapshot: ChargePointSnapshot = {
      id: "CP-1",
      status: OCPPStatus.Available,
      error: "",
      connectors: [
        {
          id: 1,
          status: OCPPStatus.Preparing,
          availability: "Operative",
          meterValue: 0,
          transactionId: null,
          soc: 20,
          mode: "manual",
          autoResetToAvailable: false,
          autoMeterValueConfig: null,
          evSettings: null,
          chargingProfile: null,
          chargingProfiles: [],
          transactionStartTime: null,
          transactionTagId: null,
          transactionBatteryCapacityKwh: null,
        },
      ],
    };
    const setConnectorSoc = vi.fn(async () => {});
    const service = createFakeChargePointService({
      snapshots: [snapshot],
      setConnectorSoc,
      getSocMeterSync: vi.fn(async () => false),
      getStateHistory: vi.fn(async () => []),
      getNetworkSimGlobal: vi.fn(async () => null),
      getNetworkSimCp: vi.fn(async () => ({
        config: null,
        resolved: {} as never,
      })),
      listScenarios: vi.fn(async () => []),
    });
    const rendered = await renderConsole("/cp/CP-1", { service });
    await flush();
    const card = document.body.querySelector<HTMLElement>(
      '[data-connector-id="1"]',
    )!;
    await act(async () => setRange(slider(card), "70"));
    await act(async () => {
      slider(card).dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true }),
      );
    });
    await flush();
    expect(setConnectorSoc).toHaveBeenCalledWith("CP-1", 1, 70);
    await act(async () => rendered.root.unmount());
  });
});
