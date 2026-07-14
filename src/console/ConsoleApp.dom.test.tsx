// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { renderConsole } from "./test/harness";

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
}

describe("ConsoleApp routing", () => {
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

  it("renders the sidebar shell and the Dashboard page at /", async () => {
    const { container, root } = await renderConsole("/");
    cleanup = () => unmount(root);

    for (const label of [
      "Charge Points",
      "Scenarios",
      "Message Log",
      "Settings",
    ]) {
      const link = Array.from(container.querySelectorAll("a")).find(
        (a) => a.textContent?.trim() === label,
      );
      expect(link, `expected a sidebar link labeled "${label}"`).toBeTruthy();
    }

    // No registry snapshot was pushed, so the Dashboard's charge point list
    // stays empty and renders its EmptyState.
    const heading = Array.from(container.querySelectorAll("h1")).find(
      (h) => h.textContent === "Charge Points",
    );
    expect(heading).toBeTruthy();
    expect(container.textContent).toContain("No charge points");
  });

  it("renders the real Settings page with a link back to the classic UI at /settings", async () => {
    const { container, root } = await renderConsole("/settings");
    cleanup = () => unmount(root);

    expect(container.textContent).toContain("RFID Tag IDs");
    expect(container.textContent).toContain("Export Configuration");

    // The Settings page itself carries an "Open classic UI" link back to the
    // classic UI at the root. (The sidebar's "Switch to classic design" link
    // also points at "/", so match on the link text rather than just the
    // href.)
    const classicLink = Array.from(
      container.querySelectorAll('a[href="/"]'),
    ).find((a) => a.textContent?.includes("Open classic UI"));
    expect(classicLink).toBeTruthy();
  });

  it('"Back to Home" on the embedded Settings page returns to the console Dashboard (relative navigate("..") from /settings)', async () => {
    const { container, root } = await renderConsole("/settings");
    cleanup = () => unmount(root);

    const backButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Back to Home",
    );
    expect(backButton, 'expected a "Back to Home" button').toBeTruthy();

    await act(async () => {
      backButton!.click();
    });

    const heading = Array.from(container.querySelectorAll("h1")).find(
      (h) => h.textContent === "Charge Points",
    );
    expect(heading).toBeTruthy();
    expect(container.textContent).toContain("No charge points");
  });
});
