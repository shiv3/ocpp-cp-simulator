// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createFakeChargePointService, renderConsole } from "../test/harness";

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

describe("SettingsPage", () => {
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

  it("surfaces the error and keeps the editor hidden when getNetworkSimGlobal rejects", async () => {
    const getNetworkSimGlobal = vi.fn(async () => {
      return new Promise<null>((_resolve, reject) => {
        reject(new Error("Failed to load network sim config"));
      });
    });
    const service = createFakeChargePointService({
      getNetworkSimGlobal,
    });

    const { container, root } = await renderConsole("/settings", { service });
    cleanup = () => unmount(root);
    await flush();

    // Error message should be visible
    expect(container.textContent).toContain(
      "Failed to load network sim config",
    );

    // Network Simulation section should not render
    expect(container.textContent).not.toContain("Enable network simulation");

    // But the page itself should still be visible (not just blank)
    expect(container.textContent).toContain("RFID Tag IDs");
  });

  it("marks the Network Simulation section #network-simulation, the target of the charge point tab's link", async () => {
    const service = createFakeChargePointService({
      getNetworkSimGlobal: vi.fn(async () => null),
    });
    const { container, root } = await renderConsole("/settings", { service });
    cleanup = () => unmount(root);
    await flush();

    const section = container.querySelector("#network-simulation");
    expect(section?.querySelector("h2")?.textContent).toBe(
      "Network Simulation",
    );
  });

  it("puts the Settings content and the Network Simulation card in one max-w-5xl column", async () => {
    const service = createFakeChargePointService({
      getNetworkSimGlobal: vi.fn(async () => null),
    });
    const { container, root } = await renderConsole("/settings", { service });
    cleanup = () => unmount(root);
    await flush();

    const section = container.querySelector("#network-simulation");
    const heading = Array.from(container.querySelectorAll("h2")).find(
      (h) => h.textContent === "Settings",
    );
    expect(section).not.toBeNull();
    expect(heading).toBeDefined();
    const column = section!.closest(".max-w-5xl");
    expect(column).not.toBeNull();
    expect(column!.classList.contains("mx-auto")).toBe(true);
    expect(column!.contains(heading!)).toBe(true);
    // Settings itself adds no second centred wrapper inside the column.
    expect(heading!.closest(".max-w-5xl")).toBe(column);
  });

  it("confirms the Configuration JSON form with Save", async () => {
    const service = createFakeChargePointService({
      getNetworkSimGlobal: vi.fn(async () => null),
    });
    const { container, root } = await renderConsole("/settings", { service });
    cleanup = () => unmount(root);
    await flush();

    const labels = Array.from(container.querySelectorAll("button")).map((b) =>
      b.textContent?.trim(),
    );
    expect(labels).not.toContain("Apply");
    expect(labels).not.toContain("Apply Changes");
    expect(container.textContent).toContain('click "Save" to update');
  });
});
