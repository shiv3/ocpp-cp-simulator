// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { appBuildLabel } from "@/lib/appBuildLabel";
import { flush, renderConsole } from "./test/harness";

vi.mock("@/lib/appBuildLabel", () => ({ appBuildLabel: vi.fn() }));

const STORAGE_KEY = "ocpp-cp.console.sidebar.collapsed";

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
}

describe("AppShell collapsible sidebar", () => {
  let cleanup: (() => Promise<void>) | null = null;

  async function renderAside(path = "/"): Promise<HTMLElement> {
    const { container, root } = await renderConsole(path);
    cleanup = () => unmount(root);
    await flush();
    return container.querySelector("aside")!;
  }

  function toggle(aside: HTMLElement): HTMLButtonElement {
    return aside.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse sidebar"], button[aria-label="Expand sidebar"]',
    )!;
  }

  async function click(button: HTMLElement): Promise<void> {
    await act(async () => {
      button.click();
    });
  }

  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("starts expanded, with labels and the version line, and writes nothing", async () => {
    vi.mocked(appBuildLabel).mockReturnValue("v9.9.9");
    const aside = await renderAside();

    expect(aside.dataset.collapsed).toBe("false");
    expect(toggle(aside).getAttribute("aria-label")).toBe("Collapse sidebar");
    expect(toggle(aside).getAttribute("aria-expanded")).toBe("true");
    expect(aside.textContent).toContain("Scenarios");
    expect(aside.textContent).toContain("v9.9.9");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("collapses to an icon rail that keeps link names, the mode dot and the theme toggle", async () => {
    vi.mocked(appBuildLabel).mockReturnValue("v9.9.9");
    const aside = await renderAside("/scenarios");

    await click(toggle(aside));

    expect(aside.dataset.collapsed).toBe("true");
    expect(toggle(aside).getAttribute("aria-label")).toBe("Expand sidebar");
    expect(toggle(aside).getAttribute("aria-expanded")).toBe("false");
    // Labels leave the visible text but stay the links' accessible names.
    const scenarios = aside.querySelector('a[aria-label="Scenarios"]');
    expect(scenarios).toBeTruthy();
    expect(scenarios!.getAttribute("title")).toBe("Scenarios");
    expect(scenarios!.getAttribute("aria-current")).toBe("page");
    expect(aside.querySelector('a[aria-label="Run History"]')).toBeTruthy();
    expect(aside.textContent).not.toContain("v9.9.9");
    expect(aside.textContent).not.toContain("ocpp-cp-simulator");
    expect(aside.querySelector('[data-testid="mode-indicator"]')).toBeTruthy();
    expect(aside.querySelector('[aria-label="Toggle theme"]')).toBeTruthy();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("1");
  });

  it("restores the collapsed state, and expanding removes the stored key", async () => {
    window.localStorage.setItem(STORAGE_KEY, "1");
    const aside = await renderAside();

    expect(aside.dataset.collapsed).toBe("true");

    await click(toggle(aside));

    expect(aside.dataset.collapsed).toBe("false");
    expect(aside.textContent).toContain("Scenarios");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("starts expanded and still toggles when storage is unavailable", async () => {
    // Only the sidebar's key throws: the theme provider reads storage too.
    const { getItem, setItem } = Storage.prototype;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (
      this: Storage,
      key: string,
    ) {
      if (key === STORAGE_KEY) throw new Error("denied");
      return getItem.call(this, key);
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === STORAGE_KEY) throw new Error("denied");
      setItem.call(this, key, value);
    });
    const aside = await renderAside();

    expect(aside.dataset.collapsed).toBe("false");

    await click(toggle(aside));

    expect(aside.dataset.collapsed).toBe("true");
  });
});
