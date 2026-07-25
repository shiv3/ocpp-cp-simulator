// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  renderConsole,
} from "../../../test/harness";

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

describe("NetworkSimEditor", () => {
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

  it("renders the global editor from SettingsPage with initial null value", async () => {
    const service = createFakeChargePointService({
      getNetworkSimGlobal: vi.fn(async () => null),
    });

    const { container, root } = await renderConsole("/settings", { service });
    cleanup = () => unmount(root);
    await flush();

    expect(container.textContent).toContain("Network Simulation");
    expect(container.textContent).toContain(
      "Network simulation rules apply to WebSocket charge points only",
    );
    expect(container.textContent).toContain("Enable network simulation");
    expect(container.textContent).toContain("Seed");
    expect(container.textContent).toContain("Add Rule");
  });

  it("loads and displays an existing global config on mount", async () => {
    const service = createFakeChargePointService({
      getNetworkSimGlobal: vi.fn(
        async () =>
          ({
            enabled: true,
            seed: 42,
            rules: {
              "latency-rule": {
                type: "latency",
                direction: "upstream",
                delayMs: 100,
              },
            },
          }) as const,
      ),
    });

    const { container, root } = await renderConsole("/settings", { service });
    cleanup = () => unmount(root);
    await flush();

    const enableCheckbox = container.querySelector(
      'input[id="network-sim-enabled"]',
    ) as HTMLInputElement;
    expect(enableCheckbox?.checked).toBe(true);

    const seedInput = container.querySelector(
      'input[id="network-sim-seed"]',
    ) as HTMLInputElement;
    expect(seedInput?.value).toBe("42");
  });

  it("adds a rule to the list when Add Rule is clicked", async () => {
    const service = createFakeChargePointService({
      getNetworkSimGlobal: vi.fn(async () => null),
      saveNetworkSimGlobal: vi.fn(async () => {}),
    });

    const { container, root } = await renderConsole("/settings", { service });
    cleanup = () => unmount(root);
    await flush();

    expect(container.textContent).toContain("Rules (0/32)");

    const addRuleButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Add Rule"),
    ) as HTMLButtonElement | undefined;
    expect(addRuleButton).toBeTruthy();

    await act(async () => {
      addRuleButton!.click();
    });
    await flush();

    expect(container.textContent).toContain("Rules (1/32)");
    expect(container.textContent).toContain("Rule ID");
    expect(container.textContent).toContain("Type");
  });

  it("removes a rule when trash button is clicked", async () => {
    const service = createFakeChargePointService({
      getNetworkSimGlobal: vi.fn(async () => null),
      saveNetworkSimGlobal: vi.fn(async () => {}),
    });

    const { container, root } = await renderConsole("/settings", { service });
    cleanup = () => unmount(root);
    await flush();

    // Add a rule
    const addRuleButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Add Rule"),
    ) as HTMLButtonElement | undefined;

    await act(async () => {
      addRuleButton!.click();
    });
    await flush();

    expect(container.textContent).toContain("Rules (1/32)");

    // Find and click the trash button
    const trashButtons = Array.from(
      container.querySelectorAll("button"),
    ).filter(
      (b) =>
        b.querySelector("svg") !== null && b.className.includes("text-red"),
    ) as HTMLButtonElement[];

    if (trashButtons.length > 0) {
      await act(async () => {
        trashButtons[0].click();
      });
      await flush();

      expect(container.textContent).toContain("Rules (0/32)");
    }
  });

  it("shows WebSocket CPs only notice at the top of editor", async () => {
    const service = createFakeChargePointService({
      getNetworkSimGlobal: vi.fn(async () => null),
    });

    const { container, root } = await renderConsole("/settings", { service });
    cleanup = () => unmount(root);
    await flush();

    expect(container.textContent).toContain(
      "Network simulation rules apply to WebSocket charge points only",
    );
    expect(container.textContent).toContain("SOAP CPs are unaffected");
  });

  it("disables Add Rule button when max rules (32) is reached", async () => {
    const service = createFakeChargePointService({
      getNetworkSimGlobal: vi.fn(async () => null),
      saveNetworkSimGlobal: vi.fn(async () => {}),
    });

    const { container, root } = await renderConsole("/settings", { service });
    cleanup = () => unmount(root);
    await flush();

    // Add 32 rules
    const addRuleButton = () =>
      Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Add Rule"),
      ) as HTMLButtonElement | undefined;

    for (let i = 0; i < 32; i += 1) {
      await act(async () => {
        addRuleButton()!.click();
      });
    }
    await flush();

    expect(container.textContent).toContain("Rules (32/32)");
    const button = addRuleButton();
    expect(button?.disabled).toBe(true);
  });

  it("calls chargePointService.saveNetworkSimGlobal when Save is clicked with valid config", async () => {
    const saveNetworkSimGlobal = vi.fn(async () => {});
    const service = createFakeChargePointService({
      getNetworkSimGlobal: vi.fn(async () => null),
      saveNetworkSimGlobal,
    });

    const { container, root } = await renderConsole("/settings", { service });
    cleanup = () => unmount(root);
    await flush();

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Save"),
    ) as HTMLButtonElement | undefined;
    expect(saveButton).toBeTruthy();

    // Save should succeed with default empty config
    await act(async () => {
      saveButton!.click();
    });
    await flush();

    expect(saveNetworkSimGlobal).toHaveBeenCalledWith({
      enabled: false,
      seed: 1,
      rules: {},
    });
  });
});
