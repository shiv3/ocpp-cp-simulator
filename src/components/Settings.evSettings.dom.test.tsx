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

vi.mock("../data/providers/DataProvider", () => ({
  useDataContext: () => ({
    mode: "remote",
    serverUrl: "http://test",
    defaultEvSettings: null,
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
});
