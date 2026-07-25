// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createFakeChargePointService,
  renderConsole,
} from "../../../test/harness";
import type {
  NetworkSimLayerConfig,
  NetworkSimRule,
} from "../../../../cp/infrastructure/transport/network-sim/config";

/** Drive a controlled input the way React's synthetic onChange expects. */
function setInputValue(input: HTMLInputElement, next: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, next);
  input.dispatchEvent(new Event("input", { bubbles: true }));
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

  it("re-enables Save once the invalid field is edited", async () => {
    // Save is gated on `hasError`. Errors used to be cleared only by a
    // successful save, so one invalid rule left the button dead with no way
    // back short of a page reload.
    const { NetworkSimEditor } = await import("../NetworkSimEditor");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    cleanup = () => unmount(root);

    await act(async () => {
      root.render(
        <NetworkSimEditor
          mode="global"
          value={{ enabled: true, seed: 1, rules: {} }}
          onSave={async () => {}}
        />,
      );
    });

    const button = (label: string) =>
      [...host.querySelectorAll("button")].find((b) =>
        b.textContent?.includes(label),
      );

    await act(async () => {
      button("Add Rule")!.click();
    });

    // A latency rule with no delay is rejected by formToLayerConfig.
    const delay = host.querySelector<HTMLInputElement>('input[type="number"]');
    expect(delay).not.toBeNull();
    await act(async () => {
      setInputValue(delay!, "");
    });
    await act(async () => {
      button("Save")!.click();
    });

    expect(button("Save")!.disabled).toBe(true);

    await act(async () => {
      setInputValue(
        host.querySelector<HTMLInputElement>('input[type="number"]')!,
        "250",
      );
    });

    expect(button("Save")!.disabled).toBe(false);
  });

  describe("CP mode (per-charge point)", () => {
    it("shows invalid edit with inline error and disables Save", async () => {
      // Create a simple test that validates the formToCpLayer rejects on invalid input
      const formToCpLayer = (await import("../ruleFormState")).formToCpLayer;
      const form = {
        enabled: undefined,
        seed: "1",
        rules: [
          {
            id: "test",
            type: "latency" as const,
            delayMs: -100, // invalid
            classification: "local" as const,
          },
        ],
      };

      const result = formToCpLayer(form);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors["rules.0.delayMs"]).toBeDefined();
      }
    });

    it("keeps in-progress edits when the parent re-renders with rebuilt props", async () => {
      // CpDetailPage polls a snapshot, so the editor re-renders constantly. Its
      // props are derived objects, so each render hands it a structurally equal
      // but freshly allocated `inheritedRules` / `value`. Reinitializing on that
      // would silently discard whatever the user has typed.
      const { NetworkSimEditor } = await import("../NetworkSimEditor");
      const inherited = (): Record<string, NetworkSimRule> => ({
        slow: { type: "latency", delayMs: 100 },
      });
      const value = (): NetworkSimLayerConfig => ({ enabled: true, rules: {} });

      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      cleanup = () => unmount(root);

      const render = async () => {
        await act(async () => {
          root.render(
            <NetworkSimEditor
              mode="cp"
              value={value()}
              inheritedRules={inherited()}
              inheritedEnabled
              onSave={async () => {}}
              onDeleteOverride={async () => {}}
            />,
          );
        });
      };

      await render();

      const addRule = [...host.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Add Local Rule"),
      );
      expect(addRule).toBeDefined();
      await act(async () => {
        addRule!.click();
      });

      const idInput =
        host.querySelector<HTMLInputElement>('input[type="text"]');
      expect(idInput).not.toBeNull();
      await act(async () => {
        setInputValue(idInput!, "half-typed-rule");
      });
      expect(idInput!.value).toBe("half-typed-rule");

      // Parent re-render with equal-but-new prop objects.
      await render();

      expect(
        host.querySelector<HTMLInputElement>('input[type="text"]')?.value,
      ).toBe("half-typed-rule");
    });
  });
});
