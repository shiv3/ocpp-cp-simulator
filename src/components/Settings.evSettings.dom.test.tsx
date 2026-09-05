// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import Settings from "./Settings";
import type { EVSettings } from "../cp/domain/connector/EVSettings";

/**
 * Regression for #301 finding 3: the v1.2 EV settings fields
 * (`chargingCurve`, `currentType`, `phases`, `voltageV`, `powerFactor`) must
 * be reachable from the browser's "Default EV Settings" panel, not just via
 * raw JSON/RPC.
 */

let setDefaultEvSettings: ReturnType<typeof vi.fn>;
/** The stored override the provider hands back. Mutable so a test can render
 *  the "an override is already saved" state as well as the default one. */
let storedDefaultEv: EVSettings | null = null;

vi.mock("../data/providers/DataProvider", () => ({
  useDataContext: () => ({
    mode: "remote",
    serverUrl: "http://test",
    defaultEvSettings: storedDefaultEv,
    setDefaultEvSettings,
    chargePointService: {
      loadConfig: vi.fn(async () => null),
      subscribeConfig: vi.fn(() => () => {}),
    },
  }),
}));

/** Drive a controlled input the way React's synthetic onChange expects. */
function setInputValue(input: HTMLInputElement, next: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, next);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The number input whose sibling <label> reads `text`. */
function findLabeledInput(
  container: HTMLElement,
  text: string,
): HTMLInputElement {
  const label = Array.from(container.querySelectorAll("label")).find(
    (l) => l.textContent?.trim() === text,
  );
  const input = label?.parentElement?.querySelector("input");
  if (!input) throw new Error(`No input labeled "${text}"`);
  return input as HTMLInputElement;
}

/**
 * The control a <label> is actually associated with, via `htmlFor`/`id` or by
 * wrapping. `HTMLLabelElement.control` is what an assistive technology
 * follows, so asserting on it tests the accessible name rather than the DOM
 * layout that `findLabeledInput` happens to rely on.
 */
function controlFor(container: HTMLElement, text: string): HTMLElement | null {
  const label = Array.from(container.querySelectorAll("label")).find(
    (l) => l.textContent?.trim() === text,
  );
  if (!label) throw new Error(`No label reading "${text}"`);
  return (label as HTMLLabelElement).control as HTMLElement | null;
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  );
  if (!button) throw new Error(`No button containing "${text}"`);
  return button as HTMLButtonElement;
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Settings default EV settings panel — charging curve (#301)", () => {
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
    vi.restoreAllMocks();
  });

  it("normalizes an out-of-order charging curve before applying it", async () => {
    setDefaultEvSettings = vi.fn();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Settings />
        </MemoryRouter>,
      );
    });
    cleanup = () => unmount(root);
    await flush();

    // Add two curve points — both start as { socPercent: 0, powerFraction: 1 }.
    const addPoint = findButton(container, "Add point");
    await act(async () => addPoint.click());
    await act(async () => addPoint.click());
    await flush();

    const socInputs = Array.from(
      container.querySelectorAll('input[aria-label*="SoC percent"]'),
    ) as HTMLInputElement[];
    const fractionInputs = Array.from(
      container.querySelectorAll('input[aria-label*="power fraction"]'),
    ) as HTMLInputElement[];
    expect(socInputs).toHaveLength(2);
    expect(fractionInputs).toHaveLength(2);

    // Edit only the first row, so on-wire order is [{80, 0.5}, {0, 1}] —
    // out of order — before Apply normalizes it.
    await act(async () => setInputValue(socInputs[0]!, "80"));
    await act(async () => setInputValue(fractionInputs[0]!, "0.5"));
    await flush();

    await act(async () => findButton(container, "Apply").click());
    await flush();

    expect(setDefaultEvSettings).toHaveBeenCalledTimes(1);
    const applied = setDefaultEvSettings.mock.calls[0]![0] as EVSettings;
    expect(applied.chargingCurve).toEqual([
      { socPercent: 0, powerFraction: 1 },
      { socPercent: 80, powerFraction: 0.5 },
    ]);
  });

  it("never stores a power factor of 0", async () => {
    // A cos phi of 0 means no real power flows, so the derived current would
    // be infinite. The panel used to clamp with Math.max(0, ...) and store the
    // 0 the domain then quietly replaced with 1 (#301).
    setDefaultEvSettings = vi.fn();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Settings />
        </MemoryRouter>,
      );
    });
    cleanup = () => unmount(root);
    await flush();

    const powerFactor = findLabeledInput(container, "Power Factor");
    expect(powerFactor.min).toBe("0.01");

    await act(async () => setInputValue(powerFactor, "0"));
    await flush();
    await act(async () => findButton(container, "Apply").click());
    await flush();

    expect(setDefaultEvSettings).toHaveBeenCalledTimes(1);
    const applied = setDefaultEvSettings.mock.calls[0]![0] as EVSettings;
    expect(applied.powerFactor).toBe(0.01);
  });
});

describe("Settings electrical controls have accessible names (#301)", () => {
  // The four controls this PR added to the Default EV Settings panel. Their
  // labels carried no `htmlFor`, so a screen reader announced four unnamed
  // controls. The five pre-1.2 fields above them have the same gap; fixing
  // those is a separate accessibility pass, not this PR's change.
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
    vi.restoreAllMocks();
  });

  it("associates each of Current Type, Phases, Voltage and Power Factor with its input", async () => {
    setDefaultEvSettings = vi.fn();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Settings />
        </MemoryRouter>,
      );
    });
    cleanup = () => unmount(root);
    await flush();

    const expected: [string, string][] = [
      ["Current Type", "SELECT"],
      ["Phases", "SELECT"],
      ["Voltage (V)", "INPUT"],
      ["Power Factor", "INPUT"],
    ];
    for (const [text, tag] of expected) {
      const control = controlFor(container, text);
      expect(control, `"${text}" label names no control`).not.toBeNull();
      expect(control!.tagName).toBe(tag);
    }
  });
});

describe("Apply saves the electrical model the panel is showing (#301)", () => {
  // With built-in defaults loaded, `currentType` / `phases` / `voltageV` /
  // `powerFactor` are all undefined while the controls display AC, 1, 230 and
  // 1. Saving them as undefined selected the pre-1.2 conversion, which reads
  // an amp-based profile limit as three-phase — so a 16 A profile metered as
  // 48 A while this page claimed single-phase.
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
    vi.restoreAllMocks();
  });

  async function renderSettings(): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Settings />
        </MemoryRouter>,
      );
    });
    cleanup = () => unmount(root);
    await flush();
    return container;
  }

  it("materializes the four displayed electrical fields on Apply", async () => {
    setDefaultEvSettings = vi.fn();
    const container = await renderSettings();

    // The finding's own scenario: change something unrelated — a curve point —
    // and Apply. Nothing electrical is touched, so all four fields are still
    // the fallbacks the controls render.
    await act(async () => findButton(container, "Add point").click());
    await flush();
    await act(async () => findButton(container, "Apply").click());
    await flush();

    expect(setDefaultEvSettings).toHaveBeenCalledTimes(1);
    const applied = setDefaultEvSettings.mock.calls[0]![0] as EVSettings;
    expect(applied.currentType).toBe("AC");
    expect(applied.phases).toBe(1);
    expect(applied.voltageV).toBe(230);
    expect(applied.powerFactor).toBe(1);
  });

  it("saves exactly what each control displays", async () => {
    setDefaultEvSettings = vi.fn();
    const container = await renderSettings();

    for (const [text, tag] of [
      ["Current Type", "SELECT"],
      ["Phases", "SELECT"],
      ["Voltage (V)", "INPUT"],
      ["Power Factor", "INPUT"],
    ] as const) {
      const control = controlFor(container, text);
      expect(control!.tagName).toBe(tag);
    }
    await act(async () => findButton(container, "Add point").click());
    await flush();
    const displayed = {
      currentType: (controlFor(container, "Current Type") as HTMLSelectElement)
        .value,
      phases: Number(
        (controlFor(container, "Phases") as HTMLSelectElement).value,
      ),
      voltageV: Number(
        (controlFor(container, "Voltage (V)") as HTMLInputElement).value,
      ),
      powerFactor: Number(
        (controlFor(container, "Power Factor") as HTMLInputElement).value,
      ),
    };

    await act(async () => findButton(container, "Apply").click());
    await flush();

    const applied = setDefaultEvSettings.mock.calls[0]![0] as EVSettings;
    expect({
      currentType: applied.currentType,
      phases: applied.phases,
      voltageV: applied.voltageV,
      powerFactor: applied.powerFactor,
    }).toEqual(displayed);
  });

  it("does not override a value the user did set", async () => {
    setDefaultEvSettings = vi.fn();
    const container = await renderSettings();

    const voltage = controlFor(container, "Voltage (V)") as HTMLInputElement;
    await act(async () => setInputValue(voltage, "400"));
    await flush();
    await act(async () => findButton(container, "Apply").click());
    await flush();

    const applied = setDefaultEvSettings.mock.calls[0]![0] as EVSettings;
    expect(applied.voltageV).toBe(400);
  });
});

describe("Apply is reachable from the default state (#301)", () => {
  /**
   * Materializing the displayed model on Apply only helps if Apply can be
   * pressed. With no stored override — and straight after Reset — the draft
   * equalled `defaultEVSettings`, so the dirty check was false and the button
   * was disabled: the page showed AC / single-phase / 230 V / unity while the
   * connector kept the legacy no-model conversion, which reads an amp limit
   * with no `numberPhases` as three-phase and reports 48 A for a 16 A profile.
   */
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
    storedDefaultEv = null;
    vi.restoreAllMocks();
  });

  async function render(): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Settings />
        </MemoryRouter>,
      );
    });
    cleanup = () => unmount(root);
    await flush();
    return container;
  }

  const applyButton = (container: HTMLElement) =>
    findButton(container, "Apply");

  it("enables Apply with no stored override, and saves the displayed model", async () => {
    setDefaultEvSettings = vi.fn();
    const container = await render();

    expect(applyButton(container).disabled).toBe(false);

    await act(async () => applyButton(container).click());
    await flush();

    expect(setDefaultEvSettings).toHaveBeenCalledTimes(1);
    const applied = setDefaultEvSettings.mock.calls[0]![0] as EVSettings;
    expect(applied.currentType).toBe("AC");
    expect(applied.phases).toBe(1);
    expect(applied.voltageV).toBe(230);
    expect(applied.powerFactor).toBe(1);
  });

  it("disables Apply again once the stored override already holds that model", async () => {
    // Nothing on screen differs from what is stored, so there is nothing to
    // apply — the button must not stay permanently lit.
    setDefaultEvSettings = vi.fn();
    storedDefaultEv = {
      modelName: "Generic EV",
      batteryCapacityKwh: 75,
      maxChargingPowerKw: 150,
      initialSoc: 20,
      targetSoc: 80,
      currentType: "AC",
      phases: 1,
      voltageV: 230,
      powerFactor: 1,
    };
    const container = await render();
    expect(applyButton(container).disabled).toBe(true);
  });

  it("enables Apply when a stored override predates the electrical fields", async () => {
    // A v1.1-era override: the page shows a model the stored settings do not
    // hold, which is exactly when Apply should be pressable.
    setDefaultEvSettings = vi.fn();
    storedDefaultEv = {
      modelName: "Generic EV",
      batteryCapacityKwh: 75,
      maxChargingPowerKw: 150,
      initialSoc: 20,
      targetSoc: 80,
    };
    const container = await render();
    expect(applyButton(container).disabled).toBe(false);
  });
});
