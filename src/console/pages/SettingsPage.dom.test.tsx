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

  it("surfaces error when getNetworkSimGlobal is rejected and does not leave section hidden", async () => {
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
    expect(container.textContent).toContain("Open classic UI");
  });
});
